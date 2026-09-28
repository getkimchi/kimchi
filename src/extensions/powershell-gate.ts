/**
 * powershell platform gate.
 *
 * Upstream registers a `powershell` builtin in the tool registry on every
 * platform. On non-Windows hosts the tool can only fail (there is no
 * PowerShell runtime to execute against), so its schema is dead weight
 * (~120 est tokens/round) plus a trap the model can wander into.
 *
 * The gate casts a visibility vote whenever powershell is REGISTERED on a
 * non-Windows host. Voting on registration (not activation) is required:
 * the tool-profile snapshot layer (tool-profile-manager.ts) rebuilds the
 * active set from the full *registered* list, so a registered-but-inactive
 * powershell would otherwise be resurrected into the API payload on every
 * turn. A visibility vote is exactly what filters it out of that snapshot
 * (getDisabledToolNames), and it is harmless when powershell never becomes
 * active — hiding an inactive tool changes nothing.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { createToolVisibility } from "./prompt-construction/tool-visibility.js"

export default function powershellGateExtension(pi: ExtensionAPI): void {
	if (process.platform === "win32") return
	const visibility = createToolVisibility(pi)
	pi.on("session_start", () => {
		if (pi.getAllTools().some((tool) => tool.name === "powershell")) {
			visibility.disable(["powershell"])
		}
	})
}
