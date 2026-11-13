import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { StreamOptions } from "@earendil-works/pi-ai"
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy"
import { registerApiProvider } from "@earendil-works/pi-ai/compat"
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex"
import { resolveGatewayCredentials } from "../../auth/gateway-credentials.js"
import { loadConfig } from "../../config.js"
import { CODEX_PROVIDER_ID, chatCompletionsApi } from "../../models.js"
import { getVersion } from "../../utils.js"
import { codexRequestMetadata } from "./codex-request-context.js"

type CodexProvider = ReturnType<typeof openaiCodexProvider>

/** Header carrying the Kimchi credential next to the ChatGPT login's Bearer token. */
export const KIMCHI_KEY_HEADER = "X-API-Key"

/**
 * True when the model feed listed chatgpt rows (persisted by the models
 * refresh as the `openai-codex` block) and the session uses a Kimchi API key.
 * The ChatGPT login takes `Authorization`, and the gateway reads `X-API-Key`
 * only as an API key, so SSO sessions cannot reach it.
 * Gates the "OpenAI Codex" entry under "Use a subscription".
 */
export function isCodexGatewayAvailable(): boolean {
	if (resolveGatewayCredentials(loadConfig()).source !== "api-key") return false
	const agentDir = process.env.KIMCHI_CODING_AGENT_DIR
	if (!agentDir) return false
	const modelsPath = resolve(agentDir, "models.json")
	if (!existsSync(modelsPath)) return false
	try {
		const parsed = JSON.parse(readFileSync(modelsPath, "utf-8")) as {
			providers?: Record<string, { models?: unknown[] }>
		}
		return (parsed.providers?.[CODEX_PROVIDER_ID]?.models?.length ?? 0) > 0
	} catch {
		return false
	}
}

/** Drops "OpenAI Codex" from a provider list unless the gateway offers it. */
export function filterCodexSubscription<T extends { id: string }>(providers: T[]): T[] {
	const codexOffered = isCodexGatewayAvailable()
	return providers.filter((provider) => provider.id !== CODEX_PROVIDER_ID || codexOffered)
}

/** Originator the gateway logs for Kimchi traffic (Codex CLI sends its own). */
const CODEX_ORIGINATOR = "kimchi"

/**
 * Correlation data Codex CLI sends, for one request of a session: headers plus
 * the `client_metadata` body field. Keys are fixed; nothing about the machine,
 * workspace or git state is included.
 */
export function codexCorrelation(sessionId: string): {
	headers: Record<string, string>
	clientMetadata: Record<string, string>
} {
	const meta = codexRequestMetadata(sessionId)
	return {
		headers: {
			"thread-id": meta.threadId,
			"x-codex-window-id": meta.windowId,
			"x-codex-turn-metadata": JSON.stringify({
				session_id: meta.sessionId,
				thread_id: meta.threadId,
				turn_id: meta.turnId,
				request_kind: meta.requestKind,
				window_id: meta.windowId,
				window_number: meta.windowNumber,
			}),
		},
		clientMetadata: {
			session_id: meta.sessionId,
			thread_id: meta.threadId,
			turn_id: meta.turnId,
			"x-codex-window-id": meta.windowId,
		},
	}
}

/**
 * Gateway options for a Codex request: SSE, the kimchi user agent and the
 * Kimchi key. Only for a model whose baseUrl is the configured gateway and an
 * API key session; anything else (e.g. an old Codex login pointing at
 * chatgpt.com) is left untouched so the Kimchi key never leaves the gateway.
 */
export function withGatewayOptions<T extends Pick<StreamOptions, "sessionId" | "onPayload" | "headers"> | undefined>(
	model: { baseUrl: string },
	options: T,
) {
	const config = loadConfig()
	const { token, source } = resolveGatewayCredentials(config)
	if (source !== "api-key" || model.baseUrl !== chatCompletionsApi(config.customLlmEndpoint)) return options
	// pi's Codex client defaults User-Agent to "pi (...)"; the gateway attributes traffic by `kimchi/<version>`.
	const correlation = options?.sessionId ? codexCorrelation(options.sessionId) : undefined
	const callerOnPayload = options?.onPayload
	return {
		...options,
		transport: "sse" as const,
		headers: {
			"User-Agent": `kimchi/${getVersion()}`,
			...options?.headers,
			originator: CODEX_ORIGINATOR,
			...correlation?.headers,
			[KIMCHI_KEY_HEADER]: token,
		},
		...(correlation && {
			onPayload: async (payload: unknown, m: Parameters<NonNullable<typeof callerOnPayload>>[1]) => ({
				...(((await callerOnPayload?.(payload, m)) ?? payload) as object),
				client_metadata: correlation.clientMetadata,
			}),
		}),
	}
}

/**
 * Wrap pi's stock Codex Responses client so gateway requests go over SSE and
 * carry the Kimchi key in `X-API-Key` next to the ChatGPT Bearer token pi adds
 * itself (see withGatewayOptions). The credential is resolved per request so a re-login or key
 * change applies without a restart. Replaces the registry entry for the
 * `openai-codex-responses` api (only the Codex provider uses it).
 */
export function registerGatewayCodexApi(): void {
	const stock = openAICodexResponsesApi()
	registerApiProvider<"openai-codex-responses", StreamOptions>(
		{
			api: "openai-codex-responses",
			stream: (model, context, options) => stock.stream(model, context, withGatewayOptions(model, options)),
			streamSimple: (model, context, options) => stock.streamSimple(model, context, withGatewayOptions(model, options)),
		},
		"kimchi-codex-gateway",
	)
}

/**
 * Pi's stock `openai-codex` provider (login flow), re-labelled, with no
 * hardcoded models: the models come from the gateway feed (models.json).
 */
export function createGatewayCodexProvider(): CodexProvider {
	return {
		...openaiCodexProvider(),
		name: "OpenAI Codex",
		getModels: () => [],
		getAllModels: () => [],
	}
}
