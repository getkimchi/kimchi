import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { getActive } from "../ferment/state.js"
import { createSystemPromptBlocks } from "../prompt-construction/index.js"

/** Additional todo guidance that applies only while a ferment is active.
 *  Standalone block content — the system-prompt block assembler joins blocks
 *  with blank lines, so no leading separator is needed here. */
export const FERMENT_TODO_GUIDANCE =
	"When working inside a ferment step, a sub-task todo list is OPTIONAL — the running step itself is the state of record. Create one only when the step spans multiple distinct sub-actions (roughly 5+ tool calls: scaffold + implement + wire + test). For focused steps (one file, one command, one fix), skip the list and just do the work. When you do keep one: todo scope is auto-routed — while exactly one step is running, writes without a scope target that step's list; otherwise they go to the global list, which persists for the whole session. The step list is cleared when the step completes — record durable follow-ups in your step summary, not in todos. The step scope starts with the step title as its first item; update_todos replaces the entire list, so re-include that item first if you replace. IDs are per-scope — use the number shown under a scope header with mark_todo. Each sub-task should be a specific verifiable action (run a command, write a file, check an output). Do not restate the phase plan as sub-tasks: the remaining steps of the phase are already tracked by the phase-level todo list. Check off sub-tasks in one batched update_todos call when the step's verification passes or the step completes — never spend a whole turn only updating todos."

/** Dynamic system-prompt block: renders the ferment todo supplement while a
 *  ferment is active, `undefined` otherwise (the block pipeline then skips it).
 *
 *  Kept in its own file so the static `todo-guidance` registrar
 *  (`prompt-block.ts`) carries no volatile ferment-state imports — the
 *  cache-stability contract test scans whole registrar files for them
 *  (see system-prompt-stability.contract.test.ts). */
export function renderFermentTodoPromptBlock(): string | undefined {
	if (!getActive()) return undefined
	return FERMENT_TODO_GUIDANCE
}

/** Register the supplement block under owner "todos" with an id that sorts
 *  immediately after the base `todo-guidance` block (blocks render in
 *  alphabetical `(owner, id)` order, so the supplement lands directly below
 *  the base guidance in the assembled prompt). */
export function registerFermentTodoPromptBlock(pi: ExtensionAPI): void {
	createSystemPromptBlocks(pi, "todos").register({
		id: "todo-guidance-ferment",
		render: renderFermentTodoPromptBlock,
	})
}
