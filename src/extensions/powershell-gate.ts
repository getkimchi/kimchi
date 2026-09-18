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
	// Upstream activates builtins asynchronously during extension load and
	// runtime (re)builds: at session_start time powershell may not yet be in
	// the active list even though it lands there before the first prompt is
	// rendered. Vote defensively at both points — the visibility handle
	// dedupes repeat disables, and the prompt builder runs after all
	// before_agent_start handlers, so a vote here still takes effect.
	const hideIfActive = () => {
		if (pi.getActiveTools().includes("powershell")) {
			visibility.disable(["powershell"])
		}
	}
	pi.on("session_start", hideIfActive)
	pi.on("before_agent_start", hideIfActive)
}
