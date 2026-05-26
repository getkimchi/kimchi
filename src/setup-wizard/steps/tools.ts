import { note } from "@clack/prompts"
import { all as allTools } from "../../integrations/registry.js"
import type { ToolId } from "../../integrations/types.js"
import { multiselect } from "../prompt.js"

/**
 * Standalone prompt for tool selection. Can be used both inside the setup
 * wizard and by the `setup-tools` standalone command.
 *
 * The list is built from the integrations registry, with each option's
 * hint reflecting detection state (installed / not detected). Pre-selects
 * the tools we detect as installed; users can flip individual toggles.
 *
 * Tools whose `isInstalled()` returns false are still selectable — useful
 * when the user is about to install the binary alongside.
 *
 * Returns the raw outcome so callers decide what to do with back/cancel.
 */
export async function promptToolSelection(opts: {
	backable: boolean
}): Promise<{ kind: "next"; value: ToolId[] } | { kind: "back" } | { kind: "cancel" }> {
	const tools = allTools()
	if (tools.length === 0) {
		// Defensive: only reachable if no integration modules were imported,
		// which means the wizard was wired wrong. Bail with a clear message
		// rather than a silent empty selection.
		note("No integrations registered. This is a wiring bug; please report it.", "No tools available")
		return { kind: "cancel" }
	}

	const installed = new Set(tools.filter((t) => t.isInstalled()).map((t) => t.id))
	const initial = tools.filter((t) => installed.has(t.id)).map((t) => t.id)

	return await multiselect<ToolId>({
		message: "Which tools should be configured?",
		options: tools.map((t) => ({
			value: t.id,
			label: t.name,
			hint: installed.has(t.id) ? "installed" : "not detected",
		})),
		initialValues: initial,
		required: false,
		backable: opts.backable,
	})
}
