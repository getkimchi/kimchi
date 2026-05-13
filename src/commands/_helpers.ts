import { resolve } from "node:path"
import { readApiKeyFromConfigFile } from "../config.js"
import type { ConfigScope } from "../config/scope.js"
import { byId } from "../integrations/registry.js"
import type { ToolId } from "../integrations/types.js"
import { updateModelsConfig } from "../models.js"
import { getAvailableModels, setAvailableModels } from "../startup-context.js"
import { printBanner } from "./banner.js"

/**
 * Resolve the kimchi API key from $KIMCHI_API_KEY first, then the config
 * file. Returns null when neither is set; callers print a friendly "run
 * kimchi setup" message rather than throwing.
 */
export function resolveApiKey(): string | null {
	const env = process.env.KIMCHI_API_KEY
	if (typeof env === "string" && env.length > 0) return env
	return readApiKeyFromConfigFile() ?? null
}

/**
 * Parse a `--scope=global|project` flag out of the args list (without
 * disturbing the positional order of forwarded flags). Defaults to
 * "global". Removes the recognised flag from the array in place.
 */
export function popScope(args: string[]): ConfigScope {
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a === "--scope=project" || a === "--project") {
			args.splice(i, 1)
			return "project"
		}
		if (a === "--scope=global" || a === "--global") {
			args.splice(i, 1)
			return "global"
		}
		if (a === "--scope" && args[i + 1]) {
			const v = args[i + 1]
			args.splice(i, 2)
			if (v === "project") return "project"
			if (v === "global") return "global"
			throw new Error(`Invalid scope: ${v}`)
		}
	}
	return "global"
}

/**
 * Standard prelude for every tool subcommand: resolve the API key, look
 * up the tool in the integrations registry, print the banner. Returns
 * null + writes a stderr message when the API key isn't available, so
 * the caller can simply `return 1` from runX().
 */
export async function prepareTool(
	toolId: ToolId,
	mode: "inject" | "override",
): Promise<{
	apiKey: string
	tool: NonNullable<ReturnType<typeof byId>>
	models: readonly import("../models.js").ModelMetadata[]
} | null> {
	const apiKey = resolveApiKey()
	if (!apiKey) {
		console.error("kimchi: no API key configured. Run `kimchi setup` or set $KIMCHI_API_KEY.")
		return null
	}
	const tool = byId(toolId)
	if (!tool) {
		// Defensive — only reachable if a developer wires a subcommand for a
		// tool whose integration module isn't imported; in that case the
		// register() side effect never ran.
		console.error(`kimchi: integration "${toolId}" not registered.`)
		return null
	}
	let models = getAvailableModels()
	if (models.length === 0) {
		const agentDir = process.env.KIMCHI_CODING_AGENT_DIR
		if (!agentDir) {
			throw new Error("KIMCHI_CODING_AGENT_DIR is not set; cli.ts must be entered via entry.ts")
		}
		const result = await updateModelsConfig(resolve(agentDir, "models.json"), apiKey)
		models = result.models
		setAvailableModels(models)
	}
	printBanner({ toolId, gsdActive: byId("gsd2")?.isInstalled() ?? false, mode, availableModels: models })
	return { apiKey, tool, models }
}
