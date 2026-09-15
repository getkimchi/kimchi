import { resolve } from "node:path"
import { log, note, outro, spinner } from "@clack/prompts"
import { byId } from "../../integrations/registry.js"
import type { ToolId } from "../../integrations/types.js"
import { type ModelMetadata, updateModelsConfig } from "../../models.js"
import { type ApplyOutcome, applyToolConfigs } from "../apply-tools.js"
import type { WizardState } from "../state.js"

/** Fetch models, apply selected integrations, and summarize setup. */
export async function runDoneStep(state: WizardState): Promise<ApplyOutcome> {
	// Fetch live models before writing any tool config.
	// Throws if no key or network fails; surface the error and abort gracefully.
	const agentDir =
		process.env.KIMCHI_CODING_AGENT_DIR ?? resolve(process.env.HOME ?? "~", ".config/kimchi-coding-agent")
	const modelsJsonPath = resolve(agentDir, "models.json")
	let models: readonly ModelMetadata[] = []
	const modelSpinner = spinner()
	modelSpinner.start("Fetching available models…")
	try {
		const result = await updateModelsConfig(modelsJsonPath, state.apiKey)
		models = result.models
		modelSpinner.stop("Models fetched.")
	} catch (err) {
		const msg = (err as Error).message
		modelSpinner.stop(`Could not fetch available models: ${msg}`)
		outro("Aborted.")
		return { successes: [], failures: [{ id: "*", error: `model fetch failed: ${msg}` }] }
	}

	if (models.length === 0) {
		log.error("API returned an empty model list — is your API key valid?")
		outro("Aborted.")
		return { successes: [], failures: [{ id: "*", error: "empty model list from API" }] }
	}

	// Apply tool configurations.
	const outcome = await applyToolConfigs({
		selectedTools: state.selectedTools,
		apiKey: state.apiKey,
		scope: state.scope,
		mode: state.mode,
		telemetryEnabled: state.telemetryEnabled,
		models,
	})

	const summaryLines = [
		state.selectedTools.length > 0
			? `Mode: ${state.mode}${state.mode === "override" ? " (configs written)" : " (runtime wrapper)"}`
			: "",
		state.selectedTools.length > 0 ? `Scope: ${state.scope}` : "",
		`Telemetry: ${state.telemetryEnabled ? "enabled" : "disabled"}`,
		outcome.successes.length > 0 ? `Configured: ${outcome.successes.join(", ")}` : "",
		outcome.failures.length > 0
			? `Failed: ${outcome.failures.map((f) => byId(f.id as ToolId)?.name ?? f.id).join(", ")}`
			: "",
	].filter((l) => l.length > 0)

	note(summaryLines.join("\n"), "Summary")
	outro(outcome.failures.length === 0 ? "Done." : "Done with errors. Check above for details.")
	return outcome
}
