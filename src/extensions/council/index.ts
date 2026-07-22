import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent"
import { applyCouncilPreset, type CouncilPreset, DEFAULT_COUNCIL_CONFIG, readCouncilConfig } from "./config.js"
import { createCouncilStream } from "./coordinator.js"
import { COUNCIL_API, COUNCIL_MODEL_IDS, COUNCIL_PROVIDER } from "./model.js"
import type { CouncilRunRecord } from "./types.js"

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
	onProgress: (label: string | undefined) => void
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

function routeCouncilStream(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions = {},
	fallbackRoute?: () => CouncilSessionRoute | undefined,
): AssistantMessageEventStream {
	const exactRoute = options.sessionId ? sessionRoutes.get(options.sessionId) : undefined
	const route = exactRoute ?? fallbackRoute?.()
	if (!route) return unavailableCouncilStream(model, context, options)
	return createCouncilStream({
		config: applyCouncilPreset(route.config, presetForModel(model.id)),
		getModelRegistry: () => route.registry,
		recordRun: route.recordRun,
		onProgress: route.onProgress,
	})(model, context, options)
}

export default function councilExtension(pi: ExtensionAPI): void {
	const config = readCouncilConfig()
	if (!config.enabled) return

	const owner = Symbol("council-session-route")
	let activeSessionId: string | undefined

	const recordRun = (record: CouncilRunRecord): void => {
		try {
			pi.appendEntry("council_run", record)
		} catch {
			// Session telemetry must never affect the model response.
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (activeSessionId && sessionRoutes.get(activeSessionId)?.owner === owner) {
			sessionRoutes.delete(activeSessionId)
		}
		activeSessionId = ctx.sessionManager.getSessionId()
		sessionRoutes.set(activeSessionId, {
			owner,
			config,
			registry: ctx.modelRegistry,
			recordRun,
			onProgress: (label) => ctx.ui?.setStatus("council", label),
		})
	})
	pi.on("session_shutdown", () => {
		if (activeSessionId) sessionRoutes.get(activeSessionId)?.onProgress(undefined)
		if (activeSessionId && sessionRoutes.get(activeSessionId)?.owner === owner) {
			sessionRoutes.delete(activeSessionId)
		}
		activeSessionId = undefined
	})
	const streamSimple = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) =>
		routeCouncilStream(model, context, options, () => {
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
