import { resolve } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { clearApiKey, loadConfig, writeApiKey } from "../../config.js"
import { chatCompletionsApi, updateModelsConfig, validateApiKey } from "../../models.js"
import { refreshBillingStatusFromConfig } from "../billing/status.js"
import { KIMCHI_PROVIDER_ID, setKimchiAuthToken } from "./flow.js"

const KIMCHI_LOGOUT_PATCHED = Symbol("kimchi.logoutPatched")

export default function loginExtension(pi: ExtensionAPI): void {
	const agentDir = process.env.KIMCHI_CODING_AGENT_DIR
	if (!agentDir) return
	const modelsJsonPath = resolve(agentDir, "models.json")

	pi.on("session_start", (_event, ctx) => {
		const authStorage = ctx.modelRegistry.authStorage

		// Re-read config every session start (not once at load): the API key can change mid-process
		// after a `/login` writes it, and each new session must pick up the latest key. This is a
		// separate read from the load-time customLlmEndpoint lookup below — do not dedupe them.
		const configKey = loadConfig().apiKey
		if (configKey) {
			setKimchiAuthToken(ctx.modelRegistry, configKey, "oauth")
			void refreshBillingStatusFromConfig()
		}

		const patchedAuthStorage = authStorage as typeof authStorage & { [KIMCHI_LOGOUT_PATCHED]?: boolean }
		if (patchedAuthStorage[KIMCHI_LOGOUT_PATCHED]) return

		const originalLogout = patchedAuthStorage.logout.bind(patchedAuthStorage)
		patchedAuthStorage.logout = (provider: string) => {
			originalLogout(provider)
			if (provider === KIMCHI_PROVIDER_ID) {
				clearApiKey()
				void refreshBillingStatusFromConfig()
			}
		}
		patchedAuthStorage[KIMCHI_LOGOUT_PATCHED] = true
	})

	// Apply a custom llmEndpoint as an in-memory baseUrl override for the kimchi-dev provider.
	// This routes chat requests to the override even when the metadata refresh falls back to the
	// cached (gateway) models.json — without persisting a project-local endpoint into the global
	// models.json. Only set when explicitly configured so the default gateway keeps flowing.
	const { customLlmEndpoint } = loadConfig()
	const kimchiProvider: Parameters<typeof pi.registerProvider>[1] = {
		oauth: {
			name: "Kimchi",
			login: async (callbacks) => {
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
				void refreshBillingStatusFromConfig()
				return { access: key, refresh: "", expires: Number.MAX_SAFE_INTEGER }
			},
			refreshToken: (credentials) => Promise.resolve(credentials),
			getApiKey: (credentials) => credentials.access,
		},
	}
	if (customLlmEndpoint) {
		kimchiProvider.baseUrl = chatCompletionsApi(customLlmEndpoint)
	}
	pi.registerProvider(KIMCHI_PROVIDER_ID, kimchiProvider)
}
