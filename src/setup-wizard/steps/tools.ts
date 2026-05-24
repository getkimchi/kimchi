import { note } from "@clack/prompts"
import { all as allTools } from "../../integrations/registry.js"
import type { ToolId } from "../../integrations/types.js"
import { multiselect } from "../prompt.js"
import type { WizardState } from "../state.js"

/**
 * Tools step — multi-select which tools to configure. The list is built
 * from the integrations registry, with each option's hint reflecting
 * detection state (installed / not detected). Pre-selects the tools we
 * detect as installed; users can flip individual toggles.
 *
 * Tools whose `isInstalled()` returns false are still selectable — useful
 * when the user is about to install the binary alongside.
 */
export async function runToolsStep(state: WizardState, opts: { backable: boolean }): Promise<void> {
	const tools = allTools()
	// Move Kimchi to the top of the list
	const kimchiIndex = tools.findIndex((t) => t.id === "kimchi")
	if (kimchiIndex > 0) {
		const kimchi = tools.splice(kimchiIndex, 1)[0]
		tools.unshift(kimchi)
	}
	if (tools.length === 0) {
		// Defensive: only reachable if no integration modules were imported,
		// which means the wizard was wired wrong. Bail with a clear message
		// rather than a silent empty selection.
		note("No integrations registered. This is a wiring bug; please report it.", "No tools available")
		state.cancelled = true
		return
	}

	const installed = new Set(tools.filter((t) => t.isInstalled()).map((t) => t.id))
	const initial = tools.filter((t) => installed.has(t.id)).map((t) => t.id)
	// Kimchi is always selected and cannot be unselected
	if (!initial.includes("kimchi")) {
		initial.unshift("kimchi")
	}

	const r = await multiselect<ToolId>({
		message: "Which tools should be configured?",
		options: tools.map((t) => ({
			value: t.id,
			label: t.name,
			hint: t.id === "kimchi" ? "\x1b[36minstalled\x1b[39m" : installed.has(t.id) ? "installed" : "not detected",
		})),
		initialValues: initial,
		required: false,
		backable: opts.backable,
	})

	if (r.kind === "back") {
		state.back = true
		return
	}
	if (r.kind === "cancel") {
		state.cancelled = true
		return
	}
	state.selectedTools = r.value
	// Kimchi is always selected and cannot be unselected
	if (!state.selectedTools.includes("kimchi")) {
		state.selectedTools.unshift("kimchi")
	}
}
