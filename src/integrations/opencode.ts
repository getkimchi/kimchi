import { readJson, writeJson } from "../config/json.js"
import type { ConfigScope } from "../config/scope.js"
import { resolveScopePath } from "../config/scope.js"
import type { ModelMetadata } from "../models.js"
import { PROVIDER_NAME } from "./constants.js"
import { detectBinaryFactory } from "./detect.js"
import { resolveModelRole } from "./models.js"
import { openCodeProviderConfig } from "./provider/opencode.js"
import { register } from "./registry.js"

const OPENCODE_CONFIG_PATH = "~/.config/opencode/opencode.json"

async function writeOpenCode(scope: ConfigScope, apiKey: string, models: readonly ModelMetadata[]): Promise<void> {
	if (!apiKey) {
		throw new Error("API key not configured")
	}

	if (!models || models.length === 0) {
		throw new Error("No models available — is the API key valid?")
	}

	const path = resolveScopePath(scope, OPENCODE_CONFIG_PATH)
	const existing = readJson(path)

	existing.$schema = "https://opencode.ai/config.json"

	const providers =
		existing.provider && typeof existing.provider === "object" && !Array.isArray(existing.provider)
			? (existing.provider as Record<string, unknown>)
			: {}
	providers[PROVIDER_NAME] = openCodeProviderConfig(apiKey, models)
	existing.provider = providers

	const main = resolveModelRole(models, "main")
	existing.model = `${PROVIDER_NAME}/${main?.slug ?? models[0].slug}`

	if (!("compaction" in existing)) {
		existing.compaction = { auto: true }
	}

	// Strip any @kimchi-dev/opencode-kimchi entry (string or array form) from
	// the plugin list. The plugin is no longer maintained — we only wrote it
	// to inject telemetry config, which is now gone. Other plugin entries are
	// preserved untouched.
	const KIMCHI_PLUGIN = "@kimchi-dev/opencode-kimchi"
	const plugin = (existing as Record<string, unknown>).plugin
	if (Array.isArray(plugin)) {
		const filtered = plugin.filter((entry) => {
			if (!entry) return true
			if (typeof entry === "string") {
				return !(entry === KIMCHI_PLUGIN || entry.startsWith(`${KIMCHI_PLUGIN}@`))
			}
			if (Array.isArray(entry) && typeof entry[0] === "string") {
				const pkgName = entry[0]
				return !(pkgName === KIMCHI_PLUGIN || pkgName.startsWith(`${KIMCHI_PLUGIN}@`))
			}
			return true
		})
		if (filtered.length === 0) {
			existing.plugin = undefined
		} else {
			existing.plugin = filtered
		}
	} else if (plugin === KIMCHI_PLUGIN || (typeof plugin === "string" && plugin.startsWith(`${KIMCHI_PLUGIN}@`))) {
		existing.plugin = undefined
	}

	writeJson(path, existing)
}

register({
	id: "opencode",
	name: "OpenCode",
	description: "Agentic coding CLI",
	configPath: OPENCODE_CONFIG_PATH,
	binaryName: "opencode",
	isInstalled: detectBinaryFactory("opencode"),
	write: writeOpenCode,
})
