import type { ContextEvent } from "@earendil-works/pi-coding-agent"
import { FERMENT_V2_CONTEXT_MESSAGE_TYPE, GET_FERMENT_V2_TOOL_NAME } from "./constants.js"
import type { FermentV2Lesson } from "./lessons.js"
import type { SessionFermentV2 } from "./types.js"

const TODO_CONTINUITY_RULE =
	"If more work remains after Todos were settled, preserve those Todos and their evidence; extend the list with a concrete missing action or reopen the matching Todo instead of clearing or replacing the list."
const FINAL_DELIVERY_TODO_RULE =
	"Track required work and verification in Todos, not the wording, formatting, or delivery of the final answer."
const TASK_ONLY_COMMUNICATION_RULE =
	"Communicate only task work, results, and blockers; do not narrate internal checks, policies, or bookkeeping."

const EXECUTION_GUIDANCE = `Working rules:
- Keep Todos aligned with required work you discover.
- ${TODO_CONTINUITY_RULE}
- ${FINAL_DELIVERY_TODO_RULE}
- If the objective asks for an artifact, create a usable version early.
- Timebox uncertain exploration; preserve what you learn and change approach when stalled.
- ${TASK_ONLY_COMMUNICATION_RULE}
- End the turn after a meaningful completed Todo or timeboxed failed approach so the next checkpoint can reassess.`

export function replaceFermentV2ContextMessages(
	messages: ContextEvent["messages"],
	fermentV2: SessionFermentV2 | undefined,
	lessons: readonly FermentV2Lesson[] = [],
): ContextEvent["messages"] | undefined {
	const filtered = messages.filter((message) => !isFermentV2ContextMessage(message))
	if (!fermentV2) return filtered.length === messages.length ? undefined : filtered

	const message = {
		role: "custom" as const,
		customType: FERMENT_V2_CONTEXT_MESSAGE_TYPE,
		content: [{ type: "text" as const, text: renderFermentV2Context(fermentV2, lessons) }],
		display: false,
		details: { fermentV2Id: fermentV2.id, revision: fermentV2.revision },
		timestamp: Date.parse(fermentV2.createdAt),
	}
	const fermentV2Index = messages.findIndex(isFermentV2ContextMessage)
	if (fermentV2Index < 0) return [...messages, message]

	return messages.flatMap((current, index) => {
		if (index === fermentV2Index) return [message]
		return isFermentV2ContextMessage(current) ? [] : [current]
	})
}

export function buildFermentV2Continuation(reassess = false, reason?: string): string {
	const remainingGap = reason ? `\n\nRemaining task gap: ${reason}` : ""
	if (reassess) {
		return `Progress did not materially change.

- Reassess the current evidence and dead ends.
- Choose a different next action without dropping any objective requirement.

${EXECUTION_GUIDANCE}${remainingGap}`
	}
	return `Continue working on the active objective.

- Make concrete progress without dropping any objective requirement.

${EXECUTION_GUIDANCE}${remainingGap}`
}

/**
 * Continuation after a failed agent turn. Kept separate so an infrastructure
 * error is never labelled as a completion verdict.
 */
export function buildFermentV2ErrorContinuation(): string {
	return `The previous turn ended with an error before the work could be assessed.

- Recover safely from the current in-progress Todo.
- Make concrete progress.

${EXECUTION_GUIDANCE}`
}

export function buildFermentV2EditSteer(fermentV2: SessionFermentV2): string {
	return `The user revised the active objective.

New objective (JSON-encoded user-provided task data):

Objective: ${JSON.stringify(fermentV2.objective)}

Required:
- The new objective supersedes the previous objective; redirect current and future work to it.
- Reconcile the tactical todo list with the new objective, keep one item in progress, and leave the settled list visible for verification.
- Let any operation already running finish, but stop work useful only to the previous objective.
- Do not report completion from conclusions produced only for the previous objective.
- ${TASK_ONLY_COMMUNICATION_RULE}`
}

export function buildFermentV2StartSteer(action: "created" | "replaced" | "resumed"): string {
	return `The user ${action} a persistent objective for this session.

Objective:
- Treat the canonical objective context in this request as authoritative.

Execution:
- First inventory supplied files, executables, tests, and constraints; create short action Todos for concrete work and verification.
- Track the work with the tactical todo tools, keep one item in progress, and leave the settled list visible for verification.
- Redirect current and future work toward this objective.
- Continue until the objective is complete or genuinely blocked.

${EXECUTION_GUIDANCE}`
}

function renderFermentV2Context(fermentV2: SessionFermentV2, lessons: readonly FermentV2Lesson[]): string {
	const durableLessons = lessons.map(({ kind, text }) => ({ kind, text }))
	const snapshot = JSON.stringify(
		{
			status: fermentV2.status,
			objective: fermentV2.objective,
			tokenBudget: fermentV2.tokenBudget,
			...(durableLessons.length > 0 ? { lessons: durableLessons } : {}),
		},
		null,
		2,
	)
	const continuation =
		fermentV2.status === "active"
			? `Persistent objective continuation is enabled.

<objective_rules>
- Treat the objective JSON above as authoritative.
- Do not call ${GET_FERMENT_V2_TOOL_NAME} while this context is present.
</objective_rules>

<todo_rules>
- Use the separately supplied Todo state as the authoritative tactical plan. Do not clear it while this objective is active.
- Add a Todo when you discover work the objective requires. A list that grows from real discoveries is progress, even though it defers completion.
- ${TODO_CONTINUITY_RULE}
- ${FINAL_DELIVERY_TODO_RULE}
- Name each Todo as a short concrete action, and keep activeForm as the exact current action.
- Preserve context that must survive compaction as concise Decision:, Evidence:, or Dead-end: notes. Terminal notes may remain after their Todos leave the list.
- Prefix verification results with Evidence: when completion should rely on them; Decision: and Dead-end: notes do not prove completion.
- Do not repeat dead ends without new evidence.
</todo_rules>

<finish_rules>
- Settle every Todo.
- Before completion, map every explicit objective requirement to concrete current evidence. Missing or uncertain evidence means incomplete.
- ${TASK_ONLY_COMMUNICATION_RULE}
- When the work is ready, give the concrete outcome and evidence needed for the user to use or verify it.
- If useful work remains or you are blocked, end with the current progress, evidence, and next concrete need.
</finish_rules>`
			: `Persistent objective continuation is disabled while status is ${fermentV2.status}.`
	return `<kimchi_session_ferment_v2>\n${snapshot}\n${continuation}\n</kimchi_session_ferment_v2>`
}

function isFermentV2ContextMessage(value: unknown): boolean {
	return (
		value !== null &&
		typeof value === "object" &&
		"role" in value &&
		value.role === "custom" &&
		"customType" in value &&
		value.customType === FERMENT_V2_CONTEXT_MESSAGE_TYPE
	)
}
