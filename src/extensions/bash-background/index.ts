/**
 * Background-bash extension entry point.
 *
 * On `session_start`, re-registers the `bash` tool with the background
 * execution definition from `./bash-background-tool.ts`. Because the
 * extension runner resolves tool-name collisions by FIRST registration
 * (runner.js `getAllRegisteredTools`: first-per-name wins, iterating
 * extensions in array order), this extension MUST be placed BEFORE
 * `bashToolGuardExtension` in the `src/cli.ts` extensions array so its
 * background `execute` wins. The description is set to the bash-tool-guard
 * steering text so the tool-selection preference composes instead of being
 * clobbered (the tool-guard's own re-registration then becomes a no-op for
 * the description — same string — and its `tool_call` steering still fires
 * because the tool name stays `bash`).
 *
 * A single session-scoped `ProcessRegistry` is created per session
 * (stored in `./session-registry.ts` so consumers don't import this
 * barrel) and shared with the background tool definition so the
 * `bash_control` companion (phase 2) can address running processes by
 * handle. The registry is drained on `session_shutdown`.
 */
import type { ExtensionAPI, SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent"
import { BASH_TOOL_DESCRIPTION } from "../bash-tool-guard.js"
import { createBackgroundBashToolDefinition } from "./bash-background-tool.js"
import { createProcessRegistry } from "./process-registry.js"
import { getSessionRegistry, setSessionRegistry } from "./session-registry.js"

export type { BackgroundBashInput, BackgroundBashToolDetails } from "./bash-background-tool.js"
export { createBackgroundBashToolDefinition } from "./bash-background-tool.js"
export type { ProcessEntry, ProcessRegistry, TailSnapshot } from "./process-registry.js"
export { createProcessRegistry } from "./process-registry.js"

/**
 * Create a background-bash extension. Registers the background `bash` tool
 * on `session_start` (carrying the bash-tool-guard steering description so
 * the two compose) and drains the process registry on `session_shutdown`.
 */
export function bashBackgroundExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event: SessionStartEvent, sessionCtx) => {
		// Fresh registry per session so handles from a previous session
		// can't be reused, and so a resumed/forked session gets a clean
		// process table.
		const registry = createProcessRegistry()
		setSessionRegistry(registry)

		// Re-register `bash` with the background execution definition.
		// The description is the bash-tool-guard steering text so the
		// tool-selection preference still reaches the system prompt even
		// though our registration wins the tool-name slot.
		const tool = createBackgroundBashToolDefinition(sessionCtx.cwd, {
			registry,
		})
		const toolWithSteering = {
			...tool,
			description: BASH_TOOL_DESCRIPTION,
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
			await registry.shutdown()
			setSessionRegistry(undefined)
		}
	})
}

export default bashBackgroundExtension
