import type { ExtensionAPI, ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent"
import { isAgentWorker } from "../agent-worker-context.js"
import { registerTodoStatePersistence } from "./context-state.js"
import { registerFermentTodoPromptBlock } from "./ferment-prompt-block.js"
import { getWriteTodosDetails } from "./session.js"
import { restoreTodoStoreFromDetails } from "./store.js"
import { registerTodosTool } from "./tool.js"

/**
 * Minimal todos core — ferment-internal todo machinery ONLY.
 *
 * The user-facing todo feature (## Todos system-prompt guidance, `/todos`
 * command, F7 overlay widget, early/staleness nudges) was removed: normal
 * adhoc/TUI/oneshot sessions get no todo surface. What remains here is the
 * infrastructure ferment (and ACP plan mirroring) still depends on:
 *
 * - `registerTodosTool` — REGISTERED ONLY IN WORKER SESSIONS (subagents run
 *   ferment steps and need the tools from birth). In top-level sessions the
 *   five todo tools are registered lazily via `ensureTodoToolsRegistered`:
 *   ferment v1 registers them when it applies a non-idle tool profile,
 *   ferment-v2 registers them on activation. A new adhoc session never sees
 *   them registered at all.
 * - `registerTodoStatePersistence` — writes hidden `todo-state` session
 *   entries on store changes so ferment todo state survives restore.
 * - `registerFermentTodoPromptBlock` — ferment-only guidance block (renders
 *   `undefined`, i.e. nothing, when no ferment is active).
 * - Store restore on session_start / session_tree.
 *
 * No prompt guidance, no nudges, no widget, no slash command, no shortcut.
 */
export default function todosCoreExtension(pi: ExtensionAPI): void {
	if (isAgentWorker()) registerTodosTool(pi)
	registerTodoStatePersistence(pi)
	registerFermentTodoPromptBlock(pi)

	const replay = (sessionManager: Pick<SessionManager, "getBranch" | "getSessionId">) => {
		restoreTodoStoreFromDetails(
			sessionManager
				.getBranch()
				.map(getWriteTodosDetails)
				.filter((details) => details !== undefined),
			sessionManager.getSessionId(),
		)
	}

	pi.on("session_start", (_event, ctx: ExtensionContext) => replay(ctx.sessionManager))
	pi.on("session_tree", (_event, ctx: ExtensionContext) => replay(ctx.sessionManager))
}
