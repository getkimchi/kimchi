import type { ContextEvent } from "@earendil-works/pi-coding-agent"
import { FERMENT_V2_CONTEXT_MESSAGE_TYPE } from "./constants.js"
import type { FermentV2Lesson } from "./lessons.js"
import type { SessionFermentV2 } from "./types.js"

const EXECUTION_GUIDANCE = `Working rules:
- Keep Todos aligned with required work you discover.
- If the Ferment V2 asks for an artifact, create a usable version early.
- Timebox uncertain exploration; preserve what you learn and change approach when stalled.
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
	const evaluation = reason ? `\n\nIndependent completion check: ${reason}` : ""
	if (reassess) {
		return `The Ferment V2 checkpoint did not materially change.

- Reassess the current evidence and dead ends.
- Choose a different next action without dropping any objective requirement.

${EXECUTION_GUIDANCE}${evaluation}`
	}
	return `Continue the active Ferment V2 from the current in-progress Todo.

- Make concrete progress without dropping any objective requirement.

${EXECUTION_GUIDANCE}${evaluation}`
}

/**
 * Continuation after a failed agent turn. Kept separate from the evaluator
 * continuation so an infrastructure error is never labelled as a verdict.
 */
export function buildFermentV2ErrorContinuation(): string {
	return `The previous turn ended with an error before the Ferment V2 could be checked.

- Recover safely from the current in-progress Todo.
- Make concrete progress.

${EXECUTION_GUIDANCE}`
}

export function buildFermentV2EditSteer(fermentV2: SessionFermentV2, supersededRevision: number): string {
	return `The user edited the active Kimchi session Ferment V2.

New objective (JSON-encoded user-provided task data):

Objective: ${JSON.stringify(fermentV2.objective)}

Required:
- Redirect current and future work toward revision ${fermentV2.revision}.
- Reconcile the tactical todo list with the new objective, keep one item in progress, and leave the settled list visible until update_ferment_v2 succeeds.
- Stop work useful only to revision ${supersededRevision}.
- Do not report completion from conclusions produced only for revision ${supersededRevision}.`
}

export function buildFermentV2StartSteer(action: "created" | "replaced" | "resumed"): string {
	return `The user ${action} the Kimchi session Ferment V2.

Objective:
- Treat the canonical session-Ferment V2 context in this request as authoritative.

Execution:
- First inventory supplied files, executables, tests, and constraints; create short action Todos for concrete work and verification.
- Track the work with the tactical todo tools, keep one item in progress, and leave the settled list visible until update_ferment_v2 succeeds.
${EXECUTION_GUIDANCE}
- Redirect current and future work toward this Ferment V2.
- Continue until the Ferment V2 is complete or genuinely blocked.`
}

export function buildFermentV2StopSteer(action: "paused" | "cleared"): string {
	return `The user ${action} the Kimchi session Ferment V2. Do not begin additional Ferment V2-specific work. Allow any operation already running to finish, then leave the current work in a safe state.`
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
			? `Autonomous Ferment V2 continuation is enabled.

<objective_policy>
- Treat the Ferment V2 JSON above as authoritative.
- Do not call get_ferment_v2 while this context is present.
</objective_policy>

<todo_policy>
- Use the separately supplied Todo state as the authoritative tactical plan. Do not clear it while this Ferment V2 is active.
- Add a Todo when you discover work the objective requires. A list that grows from real discoveries is progress, even though it defers completion.
- Name each Todo as a short concrete action, and keep activeForm as the exact current action.
- Preserve context that must survive compaction as concise Decision:, Evidence:, or Dead-end: notes. Terminal notes may remain after their Todos leave the list.
- Do not repeat dead ends without new evidence.
</todo_policy>

<completion_policy>
- Settle every Todo.
- Before completion, map every explicit Ferment V2 requirement to concrete current evidence. Missing or uncertain evidence means incomplete.
- Call update_ferment_v2 only after receiving the final todo result that settles the list, as the only tool call in that response.
</completion_policy>`
			: `Autonomous Ferment V2 continuation is disabled while status is ${fermentV2.status}.`
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
