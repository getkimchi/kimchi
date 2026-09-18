/**
 * Background-bash extension entry point.
 *
 * On `session_start`, re-registers the `bash` tool with the background
 * execution definition from `./bash-background-tool.ts`, carrying the tool-
 * selection steering description from `./bash-description.ts`.
 *
 * A single session-scoped `ProcessRegistry` is created per session
 * (stored in `./session-registry.ts` so consumers don't import this
 * barrel) and shared with the background tool definition so the
 * `bash_control` companion (phase 2) can address running processes by
 * handle. The registry is drained on `session_shutdown`.
 */
import type { ExtensionAPI, SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent"
import { createBackgroundBashToolDefinition } from "./bash-background-tool.js"
import { bashToolDescription } from "./bash-description.js"
import { createProcessRegistry } from "./process-registry.js"
import { getSessionRegistry, setSessionRegistry } from "./session-registry.js"

export type { BackgroundBashInput, BackgroundBashToolDetails } from "./bash-background-tool.js"
export { createBackgroundBashToolDefinition } from "./bash-background-tool.js"
export type { ProcessEntry, ProcessRegistry, TailSnapshot } from "./process-registry.js"
export { createProcessRegistry } from "./process-registry.js"

/**
 * Create a background-bash extension. Registers the background `bash` tool
 * on `session_start` and drains the process registry on `session_shutdown`.
 */
export function bashBackgroundExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event: SessionStartEvent, sessionCtx) => {
		// Fresh registry per session so handles from a previous session
		// can't be reused, and so a resumed/forked session gets a clean
		// process table.
		const registry = createProcessRegistry()
		setSessionRegistry(registry)

		// Re-register `bash` with the background execution definition, carrying
		// the tool-selection steering description.
		const tool = createBackgroundBashToolDefinition(sessionCtx.cwd, {
			registry,
		})
		const toolWithSteering = {
			...tool,
			description: bashToolDescription(),
			// The promptSnippet is the one-line "Execute bash commands..."
			// summary used in the Available tools section. Keep the
			// upstream/wrapped snippet so the system prompt still lists bash.
			promptSnippet: tool.promptSnippet,
		}
		pi.registerTool(toolWithSteering)
	})

	pi.on("session_shutdown", async (_event: SessionShutdownEvent) => {
		const registry = getSessionRegistry()
		if (registry) {
			// Unpublish BEFORE draining: shutdown() kills pending processes,
			// which settles their whenExited promises — and a still-published
			// registry would let bashControlExtension's exit watcher emit an
			// "exited on its own" steer into the closing session.
			setSessionRegistry(undefined)
			await registry.shutdown()
		}
	})
}

export default bashBackgroundExtension
