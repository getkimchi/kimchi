import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth"
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { loadConfig } from "../../config.js"
import { isKimchiProvider, KIMCHI_PROVIDER_ID } from "../../kimchi-provider.js"
import { chatCompletionsApi } from "../../models.js"
import { refreshBillingStatusFromConfig } from "../billing/status.js"
import { createKimchiProviderOAuth } from "./flow.js"

export default function loginExtension(pi: ExtensionAPI): void {
	const agentDir = process.env.KIMCHI_CODING_AGENT_DIR
	if (!agentDir) return

	// Builtin providers are disabled globally; explicitly restore the approved subscription provider.
	registerBunOAuthFlows()
	pi.registerProvider(openaiCodexProvider())

	// Apply a custom llmEndpoint as an in-memory baseUrl override for the kimchi-dev provider.
	// This routes chat requests to the override even when the metadata refresh falls back to the
	// cached (gateway) models.json — without persisting a project-local endpoint into the global
	// models.json. Only set when explicitly configured so the default gateway keeps flowing.
	const { customLlmEndpoint } = loadConfig()
	const kimchiOAuth = createKimchiProviderOAuth()

	const kimchiProvider: Parameters<typeof pi.registerProvider>[1] = { oauth: kimchiOAuth }
	if (customLlmEndpoint) {
		kimchiProvider.baseUrl = chatCompletionsApi(customLlmEndpoint)
	}
	pi.registerProvider(KIMCHI_PROVIDER_ID, kimchiProvider)

	// Register the same OAuth handler for every Kimchi-managed sub-provider
	// (kimchi-dev/* and kimchi-experimental) so that authStorage.getApiKey can
	// resolve their credentials (stored as type: "oauth"). This runs on every
	// session_start because sub-providers may not exist yet at initial load
	// (they're created by updateModelsConfig from the metadata API).
	pi.on("session_start", (_event, ctx) => {
		if (loadConfig().apiKey) {
			void refreshBillingStatusFromConfig({ mode: "forced" })
		}

		const subProviders = new Set(
			ctx.modelRegistry
				.getAll()
				.map((m) => m.provider)
				.filter((p) => p !== KIMCHI_PROVIDER_ID && isKimchiProvider(p)),
		)
		for (const subProviderId of subProviders) {
			pi.registerProvider(subProviderId, { oauth: kimchiOAuth })
		}
	})
}
