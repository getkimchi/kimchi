import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import type { StreamOptions } from "@earendil-works/pi-ai"
import { openAICodexResponsesApi } from "@earendil-works/pi-ai/api/openai-codex-responses.lazy"
import { registerApiProvider } from "@earendil-works/pi-ai/compat"
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex"
import { gatewayAuthHeaders, resolveGatewayCredentials } from "../../auth/gateway-credentials.js"
import { loadConfig } from "../../config.js"
import { CODEX_PROVIDER_ID } from "../../models.js"
import { getVersion } from "../../utils.js"

type CodexProvider = ReturnType<typeof openaiCodexProvider>

/** Header carrying the Kimchi credential next to the ChatGPT login's Bearer token. */
export const KIMCHI_KEY_HEADER = "X-API-Key"

/**
 * True when the model feed listed chatgpt rows (persisted by the models
 * refresh as the `openai-codex` block) and a Kimchi credential is present.
 * Gates the "OpenAI Codex" entry under "Use a subscription".
 */
export function isCodexGatewayAvailable(): boolean {
	if (resolveGatewayCredentials(loadConfig()).source === "none") return false
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

function withGatewayOptions<T extends { headers?: Record<string, string | null> } | undefined>(options: T) {
	const { token, organizationId } = resolveGatewayCredentials(loadConfig())
	const kimchiHeaders = token ? { [KIMCHI_KEY_HEADER]: token, ...gatewayOrgHeader(organizationId) } : {}
	// pi's Codex client defaults User-Agent to "pi (...)"; the gateway attributes traffic by `kimchi/<version>`.
	return {
		...options,
		transport: "sse" as const,
		headers: { "User-Agent": `kimchi/${getVersion()}`, ...options?.headers, ...kimchiHeaders },
	}
}

/**
 * Wrap pi's stock Codex Responses client so every request goes over SSE and
 * carries the Kimchi credential in `X-API-Key` next to the ChatGPT Bearer token
 * pi adds itself. The credential is resolved per request so a re-login or key
 * change applies without a restart. Replaces the registry entry for the
 * `openai-codex-responses` api (only the Codex provider uses it).
 */
export function registerGatewayCodexApi(): void {
	const stock = openAICodexResponsesApi()
	registerApiProvider<"openai-codex-responses", StreamOptions>(
		{
			api: "openai-codex-responses",
			stream: (model, context, options) => stock.stream(model, context, withGatewayOptions(options)),
			streamSimple: (model, context, options) => stock.streamSimple(model, context, withGatewayOptions(options)),
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

function gatewayOrgHeader(organizationId: string | undefined): Record<string, string> {
	const { Authorization: _bearer, ...org } = gatewayAuthHeaders({ token: "x", organizationId })
	return org
}
