import { resolve } from "node:path"
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth"
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { loadConfig, writeApiKey } from "../../config.js"
import { chatCompletionsApi, updateModelsConfig, validateApiKey } from "../../models.js"
import { refreshBillingStatusFromConfig } from "../billing/status.js"
import { KIMCHI_PROVIDER_ID } from "./flow.js"

export default function loginExtension(pi: ExtensionAPI): void {
	const agentDir = process.env.KIMCHI_CODING_AGENT_DIR
	if (!agentDir) return
	const modelsJsonPath = resolve(agentDir, "models.json")

	// Builtin providers are disabled globally; explicitly restore the approved subscription provider.
	registerBunOAuthFlows()
	pi.registerProvider(openaiCodexProvider())

	// Apply a custom llmEndpoint as an in-memory baseUrl override for the kimchi-dev provider.
	// This routes chat requests to the override even when the metadata refresh falls back to the
	// cached (gateway) models.json — without persisting a project-local endpoint into the global
	// models.json. Only set when explicitly configured so the default gateway keeps flowing.
	const { customLlmEndpoint } = loadConfig()
	const kimchiOAuth = {
		name: "Kimchi",
		login: async (callbacks: { onPrompt: (p: { message: string; placeholder?: string }) => Promise<string> }) => {
			const key = await callbacks.onPrompt({
				message:
					"You need an API key to use Kimchi's open-source models.\nTo create one:\n\n  1. Open https://app.kimchi.dev\n  2. Go to API Keys → Create API Key\n  3. Paste the key below\n\nYou'll be prompted to log in if you don't have an account.\n\nAPI Key:",
				placeholder: "Enter your Kimchi API key",
			})
			try {
				await validateApiKey(key)
			} catch {
				throw new Error("Invalid API key. Please check your key and try again.")
			}
			writeApiKey(key)
			await updateModelsConfig(modelsJsonPath, key)
			void refreshBillingStatusFromConfig({ mode: "forced" })
			return { access: key, refresh: "", expires: Number.MAX_SAFE_INTEGER }
		},
		refreshToken: (credentials: { access: string; refresh: string; expires: number }) => Promise.resolve(credentials),
		getApiKey: (credentials: { access: string; refresh: string; expires: number }) => credentials.access,
	}

	const kimchiProvider: Parameters<typeof pi.registerProvider>[1] = { oauth: kimchiOAuth }
	if (customLlmEndpoint) {
		kimchiProvider.baseUrl = chatCompletionsApi(customLlmEndpoint)
	}
	pi.registerProvider(KIMCHI_PROVIDER_ID, kimchiProvider)

	// Register the same OAuth handler for all kimchi-dev/* sub-providers so that
	// authStorage.getApiKey can resolve their credentials (stored as type: "oauth").
	// This runs on every session_start because sub-providers may not exist yet
	// at initial load (they're created by updateModelsConfig from the metadata API).
	pi.on("session_start", (_event, ctx) => {
		if (loadConfig().apiKey) {
			void refreshBillingStatusFromConfig({ mode: "forced" })
		}

		const subProviders = new Set(
			ctx.modelRegistry
				.getAll()
				.map((m) => m.provider)
				.filter((p) => p.startsWith("kimchi-dev") && p !== KIMCHI_PROVIDER_ID),
		)
		for (const subProviderId of subProviders) {
			pi.registerProvider(subProviderId, { oauth: kimchiOAuth })
		}
	})
}
