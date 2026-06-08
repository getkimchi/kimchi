import { log, spinner } from "@clack/prompts"
import type { ConfigScope } from "../config/scope.js"
import { byId } from "../integrations/registry.js"
import type { ToolId } from "../integrations/types.js"
import type { ConfigMode } from "./state.js"

export interface ApplyOutcome {
	successes: string[]
	failures: Array<{ id: string; error: string }>
}

/**
 * Apply each selected tool's writer with the resolved scope + API key.
 * Failures are collected rather than thrown so a single broken tool
 * doesn't abort the rest.
 *
 * In `inject` mode we deliberately skip the per-tool writers — the
 * tools work via env vars that the launcher subcommands set per-process.
 * The summary still lists which tools the user chose so they know what
 * `kimchi <tool>` will be wired to launch.
 */
export async function applyToolConfigs(options: {
	selectedTools: ToolId[]
	apiKey: string
	scope: ConfigScope
	mode: ConfigMode
	telemetryEnabled: boolean
	models: readonly import("../models.js").ModelMetadata[]
}): Promise<ApplyOutcome> {
	const { selectedTools, apiKey, scope, mode, telemetryEnabled, models } = options
	const outcome: ApplyOutcome = { successes: [], failures: [] }

	for (const id of selectedTools) {
		const tool = byId(id)
		if (!tool) {
			outcome.failures.push({ id, error: "integration not registered" })
			continue
		}
		if (mode === "inject") {
			// No disk writes in inject mode — the launcher sets env per-process.
			outcome.successes.push(tool.name)
			// 'claudecode' is the tool ID but the CLI command is 'claude'
			const launchCmd = id === "claudecode" ? "claude" : id
			log.info(`${tool.name}: ready — launch via \`kimchi ${launchCmd}\``)
			continue
		}
		const s = tool.interactiveWrite ? null : spinner()
		if (s) {
			s.start(`Configuring ${tool.name}…`)
			// Yield briefly so clack can render the first spinner frame before
			// potentially blocking sync work (e.g. spawnSync calls).
			await new Promise<void>((resolve) => setTimeout(() => resolve(), 80))
		} else {
			log.info(`Configuring ${tool.name}…`)
		}
		try {
			await tool.write(scope, apiKey, models, { telemetryEnabled })
			outcome.successes.push(tool.name)
			if (s) s.stop(`${tool.name}: configured`)
			else log.info(`${tool.name}: configured`)
		} catch (err) {
			const msg = (err as Error).message
			outcome.failures.push({ id, error: msg })
			if (s) s.stop(`${tool.name}: ${msg}`)
			else log.error(`${tool.name}: ${msg}`)
		}
	}

	return outcome
}
