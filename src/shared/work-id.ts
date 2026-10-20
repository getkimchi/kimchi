import { randomUUID } from "node:crypto"

const WORK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** UUID identity of a saved plan, kept across its revisions and by the Ferment it starts. */
export function isWorkId(value: unknown): value is string {
	return typeof value === "string" && WORK_ID_PATTERN.test(value)
}

/**
 * A new plan's work ID: the ID of the request writing it, which the gateway sees in its tag and uses to link the
 * plan's sessions. A random UUID while Cost per PR sends no request IDs.
 */
export function newPlanWorkId(requestId: string | undefined): string {
	return isWorkId(requestId) ? requestId.toLowerCase() : randomUUID()
}
