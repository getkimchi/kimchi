/**
 * Memory extension configuration: scope, digest value bar, storage paths.
 * Pure — unit-testable under Node.
 */
import { memoryDbPath } from "./backend.js"

/** Personal scope for the POC; project scope (`app_id`) is plumbed later. */
export const MEMORY_SCOPE_ID = "personal"

/** The user_id mem0 filters on within a scope's store. */
export const MEMORY_USER_ID = "personal"

/** Relevance bar for auto-injection: facts below this search score never enter the digest. */
export const DIGEST_SCORE_THRESHOLD = 0.3

/** Hard cap on digest facts — auto-injection must earn its tokens. */
export const DIGEST_MAX_FACTS = 5

/** Hard cap on digest size, estimated tokens (chars/4, repo convention). */
export const DIGEST_MAX_TOKENS = 2_000

const CHARS_PER_TOKEN = 4

export function tokensEstimated(chars: number): number {
	return Math.ceil(chars / CHARS_PER_TOKEN)
}

export function digestDbPath(): string {
	return memoryDbPath(MEMORY_SCOPE_ID)
}
