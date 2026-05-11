import { resolve } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { clearApiKey, loadConfig, writeApiKey } from "../../config.js"
import { updateModelsConfig, validateApiKey } from "../../models.js"

export default function loginExtension(pi: ExtensionAPI): void {
	const agentDir = process.env.KIMCHI_CODING_AGENT_DIR
	if (!agentDir) return
	const modelsJsonPath = resolve(agentDir, "models.json")

	pi.on("session_start", (_event, ctx) => {
		const authStorage = ctx.modelRegistry.authStorage

		const configKey = loadConfig().apiKey
		if (configKey) {
			authStorage.set("kimchi-dev", { type: "oauth", access: configKey, refresh: "", expires: Number.MAX_SAFE_INTEGER })
		}

		const originalLogout = authStorage.logout.bind(authStorage)
		authStorage.logout = (provider: string) => {
			originalLogout(provider)
			if (provider === "kimchi-dev") {
				clearApiKey()
			}
		}
	})

	pi.registerProvider("kimchi-dev", {
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
				return { access: key, refresh: "", expires: Number.MAX_SAFE_INTEGER }
			},
			refreshToken: (credentials) => Promise.resolve(credentials),
			getApiKey: (credentials) => credentials.access,
		},
	})
}
