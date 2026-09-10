/**
 * Memory extension configuration: scope, digest value bar, storage paths.
 * Pure — unit-testable under Node.
 */
import { memoryDbPath } from "./backend.js"

/** Personal scope for the POC; project scope (`app_id`) is plumbed later. */
export const MEMORY_SCOPE_ID = "personal"

/** The user_id mem0 filters on within a scope's store. */
export const MEMORY_USER_ID = "personal"

/**
 * Relevance bar for auto-injection: facts below this search score never
 * enter the digest. 0.2 (was 0.3): the benchmark investigation confirmed a
 * needle retrieved at 0.197 was dropped by the 0.3 bar, while calibration
 * shows unrelated-query top scores at 0.142–0.231 — 0.2 is the tightest cut
 * that admits the confirmed miss. Validate the noise trade via
 * `pnpm run memory:measure` when retuning.
 */
export const DIGEST_SCORE_THRESHOLD = 0.2

/** Hard cap on digest facts — auto-injection must earn its tokens. */
export const DIGEST_MAX_FACTS = 5

/** Hard cap on digest size, estimated tokens (chars/4, repo convention). */
export const DIGEST_MAX_TOKENS = 2_000

/**
 * Max characters per capture-extraction window — the proven-safe extraction
 * size (small windows retain needles; the dilution experiment showed
 * bundled content drops them). A single message over the budget extracts
 * whole: it is coherent context and within the gateway's comfortable
 * range. See .kimchi/plans/capture-windowing-design.md.
 */
export const MEMORY_CAPTURE_WINDOW_CHARS = 2_000

/** Max NEW facts per progressive turn recall (per re-evaluation). */
export const TURN_RECALL_MAX_FACTS = 3

/** Per-fact character cap in turn recalls (steer messages stay compact). */
export const TURN_RECALL_MAX_FACT_CHARS = 400

/** Hard cap on progressive re-evaluations per session (cost bound). */
export const TURN_RECALL_MAX_EVALUATIONS = 5

/** Gate condition A: skip retrieval when this fraction of the recent
 * conversation's content words are already covered by delivered facts. */
export const GATE_MIN_COVERAGE = 0.3

const CHARS_PER_TOKEN = 4

export function tokensEstimated(chars: number): number {
	return Math.ceil(chars / CHARS_PER_TOKEN)
}

export function digestDbPath(): string {
	return memoryDbPath(MEMORY_SCOPE_ID)
}
