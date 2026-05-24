import { resolve } from "node:path"
import { log, note, outro, spinner } from "@clack/prompts"
import { byId } from "../../integrations/registry.js"
import type { ToolId } from "../../integrations/types.js"
import { updateModelsConfig } from "../../models.js"
import { installRtk } from "../../resources/rtk-install.js"
import { exportEnvToShellProfile } from "../shell-profile.js"
import type { WizardState } from "../state.js"

const KIMCHI_API_KEY_ENV = "KIMCHI_API_KEY"

interface ApplyOutcome {
	successes: string[]
	failures: Array<{ id: string; error: string }>
	warnings: Array<{ id: string; error: string }>
	rtkInstalled: boolean
}

/**
 * Apply each selected tool's writer with the resolved scope + API key.
 * Failures are collected rather than thrown so a single broken tool
 * doesn't abort the rest of the install.
 *
 * In `inject` mode we deliberately skip the per-tool writers — the
 * tools work via env vars that the launcher subcommands set per-process.
 * The summary still lists which tools the user chose so they know what
 * `kimchi <tool>` will be wired to launch.
 *
 * Once writes finish, we also append `export KIMCHI_API_KEY=…` to the
 * user's shell profile so the key is available to future shells without
 * having to run `kimchi setup` again.
 */
export async function runDoneStep(state: WizardState): Promise<ApplyOutcome> {
	const outcome: ApplyOutcome = { successes: [], failures: [], warnings: [], rtkInstalled: false }

	// Fetch live models before writing any tool config.
	// Throws if no key or network fails; surface the error and abort gracefully.
	const agentDir =
		process.env.KIMCHI_CODING_AGENT_DIR ?? resolve(process.env.HOME ?? "~", ".config/kimchi-coding-agent")
	const modelsJsonPath = resolve(agentDir, "models.json")
	let models: readonly import("../../models.js").ModelMetadata[] = []
	const modelSpinner = spinner()
	modelSpinner.start("Fetching available models…")
	try {
		const result = await updateModelsConfig(modelsJsonPath, state.apiKey)
		models = result.models
		modelSpinner.stop("Models fetched.")
	} catch (err) {
		const msg = (err as Error).message
		modelSpinner.stop(`Could not fetch available models: ${msg}`)
		outcome.failures.push({ id: "*", error: `model fetch failed: ${msg}` })
		outro("Aborted.")
		return outcome
	}

	if (models.length === 0) {
		log.error("API returned an empty model list — is your API key valid?")
		outcome.failures.push({ id: "*", error: "empty model list from API" })
		outro("Aborted.")
		return outcome
	}

	for (const id of state.selectedTools as ToolId[]) {
		const tool = byId(id)
		if (!tool) {
			outcome.failures.push({ id, error: "integration not registered" })
			continue
		}
		if (state.mode === "inject") {
			// No disk writes in inject mode — the launcher sets env per-process.
			outcome.successes.push(tool.name)
			// 'claudecode' is the tool ID but the CLI command is 'claude'
			const launchCmd = id === "claudecode" ? "claude" : id
			log.info(`${tool.name}: ready (launch via 'kimchi ${launchCmd}')`)
			continue
		}
		const s = spinner()
		s.start(`Configuring ${tool.name}…`)
		// Yield briefly so clack can render the first spinner frame before
		// potentially blocking sync work (e.g. spawnSync calls).
		await new Promise<void>((resolve) => setTimeout(() => resolve(), 80))
		try {
			await tool.write(state.scope, state.apiKey, models, { telemetryEnabled: state.telemetryEnabled })
			outcome.successes.push(tool.name)
			s.stop(`${tool.name}: configured`)
		} catch (err) {
			const msg = (err as Error).message
			outcome.failures.push({ id, error: msg })
			s.stop(`${tool.name}: ${msg}`)
		}
	}

	if (state.installRtk) {
		const s = spinner()
		s.start("Installing RTK...")
		try {
			const result = await installRtk()
			outcome.rtkInstalled = true
			s.stop(`RTK ${result.version}: ready at ${result.linkPath}`)
		} catch (err) {
			const msg = (err as Error).message
			outcome.warnings.push({ id: "rtk", error: msg })
			s.stop(`RTK: ${msg}`)
		}
	}

	// Best-effort: persist KIMCHI_API_KEY to the user's shell profile so
	// it's available in future shells. We never fail the wizard on this —
	// the API key already lives in ~/.config/kimchi/config.json, the env
	// var is just a convenience.
	const shellExport = state.apiKey ? exportEnvToShellProfile(KIMCHI_API_KEY_ENV, state.apiKey) : { path: null }
	if (shellExport.path) {
		log.info(`${KIMCHI_API_KEY_ENV} exported to ${shellExport.path}`)
	} else if (shellExport.error) {
		log.warn(`Could not export ${KIMCHI_API_KEY_ENV} to shell profile: ${shellExport.error}`)
	}

	const summaryLines = [
		`Mode: ${state.mode}${state.mode === "override" ? " (configs written)" : " (runtime wrapper)"}`,
		`Scope: ${state.scope}`,
		`Telemetry: ${state.telemetryEnabled ? "enabled" : "disabled"}`,
		outcome.successes.length > 0 ? `Configured: ${outcome.successes.join(", ")}` : "",
		outcome.rtkInstalled ? "RTK: installed" : "",
		outcome.warnings.length > 0 ? `Warnings: ${outcome.warnings.map((f) => f.id).join(", ")}` : "",
		outcome.failures.length > 0
			? `Failed: ${outcome.failures.map((f) => byId(f.id as ToolId)?.name ?? f.id).join(", ")}`
			: "",
		shellExport.path ? `${KIMCHI_API_KEY_ENV}: exported to ${shellExport.path}` : "",
	].filter((l) => l.length > 0)

	note(summaryLines.join("\n"), "Summary")
	outro(outcome.failures.length === 0 ? "Done." : "Done with errors. Check above for details.")
	return outcome
}
