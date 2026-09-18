/**
 * powershell platform gate.
 *
 * Upstream registers a `powershell` builtin in the tool registry on every
 * platform; it only becomes active when a settings `defaultTools` list or a
 * session option opts the full builtin set in. On non-Windows hosts the tool
 * can only fail (there is no PowerShell runtime to execute against), so any
 * activation is dead schema weight (~120 est tokens/round) plus a trap the
 * model can wander into.
 *
 * The gate casts a visibility vote when — and only when — powershell is
 * actually in the active tool list at session_start. When it was never
 * activated (the default), the extension stays completely out of the way, so
 * the tool-exposure drift guard sees no phantom vote.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { createToolVisibility } from "./prompt-construction/tool-visibility.js"

export default function powershellGateExtension(pi: ExtensionAPI): void {
	if (process.platform === "win32") return
	const visibility = createToolVisibility(pi)
	pi.on("session_start", () => {
		if (pi.getActiveTools().includes("powershell")) {
			visibility.disable(["powershell"])
		}
	})
}
