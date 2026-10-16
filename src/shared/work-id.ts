import { randomUUID } from "node:crypto"

const WORK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** UUID identity of a saved plan, kept across its revisions and by the Ferment it starts. */
export function isWorkId(value: unknown): value is string {
	return typeof value === "string" && WORK_ID_PATTERN.test(value)
}

/**
 * The work ID of a new plan: the ID of the request writing it, which the Kimchi gateway sees in that request's
 * `kimchi-request` tag. The gateway links the planning session to the session that implements the plan by this ID, even
 * when the planning session ends at the plan. Without a request ID, while Cost per PR is off, a fresh UUID.
 */
export function newPlanWorkId(requestId: string | undefined): string {
	return isWorkId(requestId) ? requestId.toLowerCase() : randomUUID()
}
