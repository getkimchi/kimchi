import { resolve } from "node:path"
import { log, note, outro, spinner } from "@clack/prompts"
import { updateModelsConfig } from "../models.js"
import { applyToolConfigs } from "../setup-wizard/apply-tools.js"
import type { ConfigMode } from "../setup-wizard/state.js"
import { promptToolSelection } from "../setup-wizard/steps/tools.js"
import { popScope, resolveApiKey } from "./_helpers.js"

/**
 * `kimchi setup-tools` — interactive wizard to configure multiple coding
 * tools (Cursor, OpenCode, Claude Code, OpenClaw, GSD2) in one pass.
 *
 * This command extracts the "tools" step that used to be part of
 * `kimchi setup`, so users can re-run tool configuration without going
 * through the full setup flow again.
 */
export async function runSetupTools(args: string[]): Promise<number> {
	// Parse flags.
	let mode: ConfigMode = "override"
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--inject") {
			mode = "inject"
			args.splice(i, 1)
			i -= 1
		}
	}
	const scope = popScope(args)

	// Resolve API key.
	const apiKey = resolveApiKey()
	if (!apiKey) {
		console.error("kimchi: no API key configured. Run `kimchi setup` or set $KIMCHI_API_KEY.")
		return 1
	}

	// Select tools.
	const selection = await promptToolSelection({ backable: false })
	if (selection.kind === "cancel") {
		outro("Cancelled.")
		return 1
	}
	if (selection.kind === "back") {
		// backable is false, so this should never happen — handle defensively.
		outro("Cancelled.")
		return 1
	}

	const selectedTools = selection.value
	if (selectedTools.length === 0) {
		outro("No tools selected. Nothing to do.")
		return 0
	}

	// Fetch live models.
	const agentDir =
		process.env.KIMCHI_CODING_AGENT_DIR ?? resolve(process.env.HOME ?? "~", ".config/kimchi-coding-agent")
	const modelsJsonPath = resolve(agentDir, "models.json")
	let models: readonly import("../models.js").ModelMetadata[] = []
	const modelSpinner = spinner()
	modelSpinner.start("Fetching available models…")
	try {
		const result = await updateModelsConfig(modelsJsonPath, apiKey)
		models = result.models
		modelSpinner.stop("Models fetched.")
	} catch (err) {
		const msg = (err as Error).message
		modelSpinner.stop(`Could not fetch available models: ${msg}`)
		outro("Aborted.")
		return 1
	}

	if (models.length === 0) {
		log.error("API returned an empty model list — is your API key valid?")
		outro("Aborted.")
		return 1
	}

	// Apply tool configs.
	const outcome = await applyToolConfigs({
		selectedTools,
		apiKey,
		scope,
		mode,
		telemetryEnabled: false,
		models,
	})

	// Print summary.
	const summaryLines = [
		`Mode: ${mode}${mode === "override" ? " (configs written)" : " (runtime wrapper)"}`,
		`Scope: ${scope}`,
		outcome.successes.length > 0 ? `Configured: ${outcome.successes.join(", ")}` : "",
		outcome.failures.length > 0 ? `Failed: ${outcome.failures.map((f) => f.id).join(", ")}` : "",
	].filter((l) => l.length > 0)

	note(summaryLines.join("\n"), "Summary")
	outro(outcome.failures.length === 0 ? "Done." : "Done with errors. Check above for details.")
	return outcome.failures.length === 0 ? 0 : 1
}
