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

	// Remove stale plugin field that was written by the now-unmaintained
	// @kimchi-dev/opencode-kimchi package.
	existing.plugin = undefined

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
