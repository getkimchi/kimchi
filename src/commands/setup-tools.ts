// Side-effect imports register each integration. Without these, all()
// and byId() in the integrations registry return nothing.
import "../integrations/claude-code.js"
import "../integrations/cursor.js"
import "../integrations/gsd2.js"
import "../integrations/openclaw.js"
import "../integrations/opencode.js"

import { resolve } from "node:path"
import { intro, log, note, outro, spinner } from "@clack/prompts"
import { isTelemetryExplicitlyConfigured, readTelemetryConfig } from "../config.js"
import { drain as drainPreSessionTelemetry, sendPreSessionEvent } from "../extensions/telemetry/pre-session.js"
import { all as allTools } from "../integrations/registry.js"
import { updateModelsConfig } from "../models.js"
import { applyToolConfigs } from "../setup-wizard/apply-tools.js"
import type { ConfigMode } from "../setup-wizard/state.js"
import { promptTelemetry } from "../setup-wizard/steps/telemetry.js"
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
	const telemetryConfig = readTelemetryConfig()

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

	intro("kimchi setup-tools")

	// Select tools.
	const selection = await promptToolSelection({ backable: false })
	if (selection.kind === "cancel") {
		if (telemetryConfig.enabled) {
			sendPreSessionEvent(telemetryConfig, "tools_setup_aborted", { step: "tools" })
			await drainPreSessionTelemetry()
		}
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

	// Resolve telemetry preference. If the user has already chosen (via
	// `kimchi setup`, `kimchi config telemetry`, or $KIMCHI_TELEMETRY_ENABLED)
	// we respect that. Otherwise we auto-enable and show a notice.
	let telemetryEnabled: boolean
	if (isTelemetryExplicitlyConfigured()) {
		telemetryEnabled = readTelemetryConfig().enabled
	} else {
		await promptTelemetry({ backable: false })
		telemetryEnabled = true
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
		if (telemetryConfig.enabled) {
			sendPreSessionEvent(telemetryConfig, "tools_setup_aborted", { step: "models" })
			await drainPreSessionTelemetry()
		}
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
		telemetryEnabled,
		models,
	})

	if (telemetryConfig.enabled) {
		for (const toolName of outcome.successes) {
			sendPreSessionEvent(telemetryConfig, "tool_configured", { tool_name: toolName })
		}

		sendPreSessionEvent(telemetryConfig, "tools_setup_completed", {
			tools_count: selectedTools.length,
			scope,
			mode,
			failures: outcome.failures.length,
		})
	}

	// Print summary.
	const summaryLines = [
		`Mode: ${mode}${mode === "override" ? " (configs written)" : " (runtime wrapper)"}`,
		`Scope: ${scope}`,
		`Telemetry: ${telemetryEnabled ? "enabled" : "disabled"}`,
		outcome.successes.length > 0 ? `Configured: ${outcome.successes.join(", ")}` : "",
		outcome.failures.length > 0 ? `Failed: ${outcome.failures.map((f) => f.id).join(", ")}` : "",
	].filter((l) => l.length > 0)

	note(summaryLines.join("\n"), "Summary")

	if (outcome.successes.length > 0) {
		const nextStepsLines = outcome.successes.map((name) => {
			const tool = allTools().find((t) => t.name === name)
			if (!tool) return `• ${name}`
			const launchCmd = tool.id === "claudecode" ? "claude" : tool.id
			if (mode === "override") return `• ${launchCmd}`
			return `• kimchi ${launchCmd}`
		})
		note(nextStepsLines.join("\n"), "Next steps")
	}

	outro(outcome.failures.length === 0 ? "Done." : "Done with errors. Check above for details.")

	if (telemetryConfig.enabled) {
		await drainPreSessionTelemetry()
	}

	return outcome.failures.length === 0 ? 0 : 1
}
