/**
 * Memory extension configuration: scope, digest value bar, storage paths.
 * Pure — unit-testable under Node.
 */
import { memoryDbPath } from "./backend.js"

/** The personal scope id — the always-present global store. Project scopes are keyed by owner/name (scope.ts). */
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
 * range. See docs/memory-extension.md.
 */
export const MEMORY_CAPTURE_WINDOW_CHARS = 2_000

/**
 * Parallel extraction calls across the whole drain (the pipelined worker's
 * phase B) — the LLM phase is the throughput bottleneck, so windows from
 * ALL pending jobs extract in one bounded-concurrency queue instead of
 * per-job chunks. The benchmark's dominant failure cause was serialized
 * capture (~24s/job) outrunning the drain budget. Override:
 * KIMCHI_MEMORY_DRAIN_CONCURRENCY.
 */
export const MEMORY_DRAIN_CONCURRENCY = 6

/**
 * Facts per batched supersede judge call (the pipelined worker's phase C):
 * one judge pass per store across the whole drain, the facts listed
 * chronologically — bounds the judge prompt size while keeping a single
 * cross-session view (per-chunk judges never saw two sessions' conflicting
 * facts side by side).
 */
export const MEMORY_SUPERSEDE_BATCH_FACTS = 40

/**
 * Candidate search width per new fact for the supersede judge — the old
 * value must surface as a candidate before the judge can delete it; 8 (was
 * 5) widens the net for near-miss similarity scores.
 */
export const SUPERSEDE_SEARCH_TOPK = 8

/**
 * Uncaptured user messages needed before an incremental mid-session
 * capture spawns — drains content as it accumulates instead of saving
 * everything for shutdown, shrinking the next-session staleness race to the
 * last few turns.
 */
export const MEMORY_CAPTURE_INCREMENTAL_MESSAGES = 10

/**
 * Capture drain lock staleness: a held lock whose mtime is older than this
 * is considered compromised and stealable. Must exceed the worst-case
 * legitimate drain duration (several jobs, minutes each).
 */
export const CAPTURE_LOCK_STALE_MS = 15 * 60_000

/** Mtime refresh interval while the capture drain lock is held. */
export const CAPTURE_LOCK_UPDATE_MS = 30_000

/** Pending capture jobs older than this are swept at drain start (the reaper). */
export const PENDING_JOB_MAX_AGE_MS = 7 * 86_400_000

/**
 * Length bound for the assistant-capture gate: assistant turns enter capture
 * jobs only when pure text (no tool-call blocks, no thinking), ≤ this many
 * characters. Kills the ~93% work-product share of real coding sessions
 * before it costs extraction tokens; the extraction taxonomy decides
 * durability. See docs/memory-extension.md.
 */
export const MEMORY_CAPTURE_ASSISTANT_MAX_CHARS = 1_000

/** Max NEW facts per progressive turn recall (per re-evaluation). */
export const TURN_RECALL_MAX_FACTS = 3

/** Per-fact character cap in turn recalls (steer messages stay compact). */
export const TURN_RECALL_MAX_FACT_CHARS = 400

/** Hard cap on progressive re-evaluations per session (cost bound). */
export const TURN_RECALL_MAX_EVALUATIONS = 5

/**
 * Bounded wait for memory searches on the user-visible critical path (the
 * turn-1 digest and drift recalls) — a hung gateway call degrades to
 * no-memory instead of stalling the first prompt.
 */
export const MEMORY_SEARCH_TIMEOUT_MS = 10_000

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
