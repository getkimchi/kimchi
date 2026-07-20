import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent"
import { applyCouncilPreset, type CouncilPreset, readCouncilConfig } from "./config.js"
import { type CouncilRunRecord, createCouncilStream, DEFAULT_COUNCIL_CONFIG } from "./runtime.js"

const COUNCIL_PROVIDER = "kimchi"
const COUNCIL_API = "kimchi-council"
const COUNCIL_MODELS = [
	{ id: "council-fast", name: "Kimchi Council Fast", maxTokens: 8_192 },
	{ id: "council", name: "Kimchi Council", maxTokens: 16_384 },
	{ id: "council-deep", name: "Kimchi Council Deep", maxTokens: 32_768 },
] as const

interface CouncilSessionRoute {
	owner: symbol
	config: ReturnType<typeof readCouncilConfig>
	registry: ModelRegistry
	recordRun: (record: CouncilRunRecord) => void
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
): AssistantMessageEventStream {
	const route = options.sessionId ? sessionRoutes.get(options.sessionId) : undefined
	if (!route) return unavailableCouncilStream(model, context, options)
	return createCouncilStream({
		config: applyCouncilPreset(route.config, presetForModel(model.id)),
		getModelRegistry: () => route.registry,
		recordRun: route.recordRun,
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
		sessionRoutes.set(activeSessionId, { owner, config, registry: ctx.modelRegistry, recordRun })
	})
	pi.on("session_shutdown", () => {
		if (activeSessionId && sessionRoutes.get(activeSessionId)?.owner === owner) {
			sessionRoutes.delete(activeSessionId)
		}
		activeSessionId = undefined
	})

	pi.registerProvider(COUNCIL_PROVIDER, {
		name: "Kimchi",
		// These values only expose the virtual model in the picker. Physical calls
		// resolve their own endpoint and auth through ModelRegistry.
		baseUrl: "http://kimchi-council.invalid",
		apiKey: "unused-virtual-model-key",
		authHeader: false,
		api: COUNCIL_API,
		streamSimple: routeCouncilStream,
		models: COUNCIL_MODELS.map((model) => ({
			...model,
			reasoning: false,
			input: ["text"] as const,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 262_144,
		})),
	})
}
