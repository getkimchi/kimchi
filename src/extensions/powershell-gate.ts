/**
 * powershell platform gate.
 *
 * Upstream registers a `powershell` builtin in the tool registry on every
 * platform. On non-Windows hosts the tool can only fail (there is no
 * PowerShell runtime to execute against), so its schema is dead weight
 * (~120 est tokens/round) plus a trap the model can wander into.
 *
 * The gate casts a visibility vote on non-Windows hosts. Profiles such as
 * `implementation-ferment` union the registry, and users can explicitly enable
 * powershell with `+powershell`; the vote keeps it out of both surfaces.
 * Hiding a tool the user never enabled is harmless.
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
