import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent"
import { applyCouncilPreset, type CouncilPreset, DEFAULT_COUNCIL_CONFIG, readCouncilConfig } from "./config.js"
import { createCouncilStream } from "./coordinator.js"
import { COUNCIL_API, COUNCIL_MODEL_IDS, COUNCIL_PROVIDER, isCouncilVirtualModel } from "./model.js"
import { CouncilProgressUI } from "./progress-ui.js"
import { isMutatingCouncilToolCall } from "./review-policy.js"
import { sanitizeCouncilTransactionSnapshot } from "./telemetry.js"
import { CouncilTransactionRuntime } from "./transaction-runtime.js"
import {
	installCouncilMutationGuard,
	isCouncilPostApplyValidationCommand,
	registerCouncilTransactionTools,
	syncCouncilTransactionToolVisibility,
} from "./transaction-tools.js"
import type { CouncilProgressEvent, CouncilRunRecord } from "./types.js"

const COUNCIL_MODEL_NAMES: Record<(typeof COUNCIL_MODEL_IDS)[number], string> = {
	"council-fast": "Kimchi Council Fast",
	council: "Kimchi Council",
	"council-deep": "Kimchi Council Deep",
}

interface CouncilSessionRoute {
	owner: symbol
	config: ReturnType<typeof readCouncilConfig>
	registry: ModelRegistry
	recordRun: (record: CouncilRunRecord) => void
	onProgress: (event: CouncilProgressEvent) => void
	changedThisTurn: boolean
	pendingMutatingToolCalls: Set<string>
	pendingPostApplyValidationCalls: Map<string, string>
	transaction: CouncilTransactionRuntime
	progressUI?: CouncilProgressUI
}

const sessionRoutes = new Map<string, CouncilSessionRoute>()
const unavailableCouncilStream = createCouncilStream({
	config: applyCouncilPreset(DEFAULT_COUNCIL_CONFIG, "normal"),
	getModelRegistry: () => undefined,
})

function presetForModel(modelId: string): CouncilPreset {
	if (modelId === "council-fast") return "fast"
	if (modelId === "council-deep") return "deep"
	return "normal"
}

export function sanitizeCouncilSessionRecord(record: CouncilRunRecord) {
	return {
		...record,
		stages: record.stages.map(({ modelRef: _modelRef, ...stage }) => stage),
		transaction: record.transaction ? sanitizeCouncilTransactionSnapshot(record.transaction) : undefined,
	}
}

function routeCouncilStream(
	owner: symbol,
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions = {},
	fallbackRoute?: () => CouncilSessionRoute | undefined,
): AssistantMessageEventStream {
	const exactRoute = options.sessionId ? sessionRoutes.get(options.sessionId) : undefined
	const route = exactRoute ? (exactRoute.owner === owner ? exactRoute : undefined) : fallbackRoute?.()
	if (!route) return unavailableCouncilStream(model, context, options)
	return createCouncilStream({
		config: applyCouncilPreset(route.config, presetForModel(model.id)),
		getModelRegistry: () => route.registry,
		recordRun: route.recordRun,
		onProgress: route.onProgress,
		shouldReviewTurn: () => route.changedThisTurn,
		transaction: route.transaction,
	})(model, context, options)
}

export default function councilExtension(pi: ExtensionAPI): void {
	const config = readCouncilConfig()
	if (!config.enabled) return

	const owner = Symbol("council-session-route")
	let activeSessionId: string | undefined

	const recordRun = (record: CouncilRunRecord): void => {
		try {
			pi.appendEntry("council_run", sanitizeCouncilSessionRecord(record))
		} catch {
			// Session telemetry must never affect the model response.
		}
	}
	const activeProgressUI = (): CouncilProgressUI | undefined => {
		if (!activeSessionId) return undefined
		const route = sessionRoutes.get(activeSessionId)
		return route?.owner === owner ? route.progressUI : undefined
	}
	const routeForContext = (ctx?: { sessionManager?: { getSessionId(): string } }): CouncilSessionRoute | undefined => {
		const sessionId = ctx?.sessionManager?.getSessionId() ?? activeSessionId
		if (!sessionId) return undefined
		const route = sessionRoutes.get(sessionId)
		return route?.owner === owner ? route : undefined
	}
	installCouncilMutationGuard(pi, (ctx) => routeForContext(ctx)?.transaction)

	pi.on("session_start", async (_event, ctx) => {
		if (activeSessionId) {
			const previous = sessionRoutes.get(activeSessionId)
			if (previous?.owner === owner) {
				previous.progressUI?.dispose()
				await previous.transaction.abandon()
				previous.transaction.resetRunBudget()
				sessionRoutes.delete(activeSessionId)
			}
		}
		activeSessionId = ctx.sessionManager.getSessionId()
		const sessionCwd = ctx.cwd || process.cwd()
		const progressUI = ctx.mode === "tui" ? new CouncilProgressUI(ctx.ui) : undefined
		sessionRoutes.set(activeSessionId, {
			owner,
			config,
			registry: ctx.modelRegistry,
			recordRun,
			onProgress: (event) => progressUI?.handle(event),
			changedThisTurn: false,
			pendingMutatingToolCalls: new Set(),
			pendingPostApplyValidationCalls: new Map(),
			transaction: new CouncilTransactionRuntime(sessionCwd),
			progressUI,
		})
		registerCouncilTransactionTools(pi, sessionCwd, (toolContext) => routeForContext(toolContext)?.transaction)
		syncCouncilTransactionToolVisibility(pi, ctx.model)
	})
	pi.on("input", async (event, ctx) => {
		if (event.source === "extension") return
		const route = routeForContext(ctx)
		if (!route) return
		await route.transaction.resetForNewTurn()
		route.changedThisTurn = false
		route.pendingMutatingToolCalls.clear()
		route.pendingPostApplyValidationCalls.clear()
	})
	pi.on("tool_execution_start", (event, ctx) => {
		const route = sessionRoutes.get(ctx.sessionManager.getSessionId())
		if (route?.owner !== owner) return
		if (isMutatingCouncilToolCall(event.toolName, event.args)) {
			route.pendingMutatingToolCalls.add(event.toolCallId)
		}
		const command =
			event.args && typeof event.args === "object" ? (event.args as { command?: unknown }).command : undefined
		if (
			route.transaction.state === "post_apply_checks" &&
			event.toolName === "bash" &&
			typeof command === "string" &&
			isCouncilPostApplyValidationCommand(command)
		) {
			route.pendingPostApplyValidationCalls.set(event.toolCallId, command)
		}
	})
	pi.on("tool_execution_end", (event, ctx) => {
		const route = routeForContext(ctx)
		if (!route) return
		const wasMutating = route.pendingMutatingToolCalls.delete(event.toolCallId)
		if (!event.isError && wasMutating) route.changedThisTurn = true
		const validationCommand = route.pendingPostApplyValidationCalls.get(event.toolCallId)
		if (validationCommand !== undefined) {
			route.pendingPostApplyValidationCalls.delete(event.toolCallId)
			route.transaction.recordPostApplyCheck(event.toolName, validationCommand, !event.isError)
		}
	})
	pi.on("agent_start", () => activeProgressUI()?.clear())
	pi.on("before_agent_start", (_event, ctx) => syncCouncilTransactionToolVisibility(pi, ctx.model))
	pi.on("model_select", async (event, ctx) => {
		activeProgressUI()?.clear()
		const route = routeForContext(ctx)
		const model = event?.model ?? ctx?.model
		if (route && model && !isCouncilVirtualModel(model)) {
			await route.transaction.abandon()
			route.transaction.resetRunBudget()
			route.changedThisTurn = false
			route.pendingMutatingToolCalls.clear()
			route.pendingPostApplyValidationCalls.clear()
		}
		if (model) syncCouncilTransactionToolVisibility(pi, model)
	})
	pi.on("session_shutdown", async (_event, ctx) => {
		const route = routeForContext(ctx)
		const sessionId = ctx?.sessionManager?.getSessionId() ?? activeSessionId
		if (route) {
			route.progressUI?.dispose()
			await route.transaction.abandon()
			route.transaction.resetRunBudget()
		}
		if (sessionId && sessionRoutes.get(sessionId)?.owner === owner) sessionRoutes.delete(sessionId)
		activeSessionId = undefined
	})
	const streamSimple = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
		routeCouncilStream(owner, model, context, options, () => {
			if (!activeSessionId) return undefined
			const route = sessionRoutes.get(activeSessionId)
			return route?.owner === owner ? route : undefined
		})

	pi.registerProvider(COUNCIL_PROVIDER, {
		name: "Kimchi",
		// These values only expose the virtual model in the picker. Physical calls
		// resolve their own endpoint and auth through ModelRegistry.
		baseUrl: "http://kimchi-council.invalid",
		apiKey: "unused-virtual-model-key",
		authHeader: false,
		api: COUNCIL_API,
		streamSimple,
		models: COUNCIL_MODEL_IDS.map((id) => ({
			id,
			name: COUNCIL_MODEL_NAMES[id],
			reasoning: false,
			input: ["text"] as const,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262_144,
			maxTokens: applyCouncilPreset(config, presetForModel(id)).leadMaxTokens,
		})),
	})
}
