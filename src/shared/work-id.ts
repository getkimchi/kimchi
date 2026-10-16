import { randomUUID } from "node:crypto"

const WORK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** UUID identity of a saved plan, kept across its revisions and by the Ferment it starts. */
export function isWorkId(value: unknown): value is string {
	return typeof value === "string" && WORK_ID_PATTERN.test(value)
}

/**
 * The work ID of a new plan: the ID of the session writing it. The Kimchi gateway sees that ID as X-Session-Id, so it
 * links the planning session to the session that implements the plan, even when the planning session ends at the plan.
 */
export function newPlanWorkId(sessionId: string): string {
	return isWorkId(sessionId) ? sessionId.toLowerCase() : randomUUID()
}
