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
 * A single session-scoped state ({registry, coordinator, limitSeconds}) is
 * created per session (stored in `./session-registry.ts` so consumers
 * don't import this barrel). The registry owns process lifecycle and the
 * harness safety limit (`--bash-process-limit`, default one hour); the
 * coordinator owns the cohort's single review clock. Both are torn down
 * on `session_shutdown`.
 */
import type { ExtensionAPI, SessionShutdownEvent, SessionStartEvent } from "@earendil-works/pi-coding-agent"
import { resolveBashProcessLimitSeconds } from "../../cli-args.js"
import { bashToolDescription } from "../bash-tool-guard.js"
import { createBackgroundBashToolDefinition } from "./bash-background-tool.js"
import { createProcessRegistry, DEFAULT_BASH_PROCESS_LIMIT_SECONDS } from "./process-registry.js"
import { createReviewCoordinator } from "./review-coordinator.js"
import { getSessionState, setSessionState } from "./session-registry.js"

/**
 * Create a background-bash extension. Registers the background `bash` tool
 * on `session_start` (carrying the bash-tool-guard steering description so
 * the two compose) and tears down the cohort on `session_shutdown`.
 */
export function bashBackgroundExtension(pi: ExtensionAPI): void {
	pi.on("session_start", (_event: SessionStartEvent, sessionCtx) => {
		// Fresh state per session so handles from a previous session can't
		// be reused, and so a resumed/forked session gets a clean process
		// table and review clock.
		const registry = createProcessRegistry()
		const limitSeconds = resolveBashProcessLimitSeconds() ?? DEFAULT_BASH_PROCESS_LIMIT_SECONDS
		const coordinator = createReviewCoordinator({
			registry,
			// The bash-control extension installs `deliverReview` on its own
			// session_start; deferring through the state object dodges the
			// extension registration-order dependency.
			onReviewDue: () => getSessionState()?.deliverReview?.(),
		})
		setSessionState({ registry, coordinator, limitSeconds, cwd: sessionCtx.cwd })

		// Re-register `bash` with the background execution definition.
		// The description is the bash-tool-guard steering text so the
		// tool-selection preference still reaches the system prompt even
		// though our registration wins the tool-name slot.
		const tool = createBackgroundBashToolDefinition(sessionCtx.cwd, {
			state: getSessionState(),
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
		const state = getSessionState()
		if (state) {
			// Unpublish BEFORE draining: shutdown() kills pending processes,
			// which settles their whenExited promises — and a still-published
			// registry would let bashControlExtension's exit watcher emit an
			// "exited on its own" notice into the closing session.
			setSessionState(undefined)
			state.coordinator.dispose()
			await state.registry.shutdown()
		}
	})
}

export default bashBackgroundExtension
