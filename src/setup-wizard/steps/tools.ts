import { log, note } from "@clack/prompts"
import { all as allTools } from "../../integrations/registry.js"
import type { ToolId } from "../../integrations/types.js"
import { multiselect } from "../prompt.js"
import type { WizardState } from "../state.js"

/**
 * Tools step — multi-select which tools to configure. Kimchi itself is
 * shown as a locked header above the list (always included, never
 * toggleable). The multiselect only contains third-party tools.
 *
 * Each option's hint reflects detection state (installed / not detected).
 * Pre-selects the tools we detect as installed; users can flip individual
 * toggles.
 *
 * Tools whose `isInstalled()` returns false are still selectable — useful
 * when the user is about to install the binary alongside.
 */
export async function runToolsStep(state: WizardState, opts: { backable: boolean }): Promise<void> {
	const tools = allTools()

	// Kimchi is always included and shown above the list as a locked item.
	const kimchi = tools.find((t) => t.id === "kimchi")
	const otherTools = tools.filter((t) => t.id !== "kimchi")

	if (otherTools.length === 0) {
		// Defensive: only reachable if no integration modules were imported,
		// which means the wizard was wired wrong. Bail with a clear message
		// rather than a silent empty selection.
		note("No integrations registered. This is a wiring bug; please report it.", "No tools available")
		state.cancelled = true
		return
	}

	// Show Kimchi as a locked header — always included, not in the list.
	if (kimchi) {
		log.step("Kimchi 🔒  already installed — will be configured")
	}

	const installed = new Set(otherTools.filter((t) => t.isInstalled()).map((t) => t.id))
	const initial = otherTools.filter((t) => installed.has(t.id)).map((t) => t.id)

	const r = await multiselect<ToolId>({
		message: "Which additional tools should be configured?",
		options: otherTools.map((t) => ({
			value: t.id,
			label: t.name,
			hint: installed.has(t.id) ? "installed" : "not detected",
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
	// Kimchi is always selected and cannot be unselected
	state.selectedTools = ["kimchi", ...r.value]
}
