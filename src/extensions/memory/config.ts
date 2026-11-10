/**
 * Memory extension configuration: scope, digest value bar, storage paths.
 * Pure — unit-testable under Node.
 */
import { memoryDbPath } from "./backend.js"

/** The personal scope id — the always-present global store. Project scopes are keyed by owner/name (scope.ts). */
export const MEMORY_SCOPE_ID = "personal"

/** The user_id mem0 filters on within a scope's store. */
export const MEMORY_USER_ID = "personal"

/** The /resources id for the memory extension — the gate for its registration. */
export const MEMORY_RESOURCE_ID = "extensions.memory"

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

/** Record key for drain-attributed jobs whose job file predates session
 *  attribution (pre-upgrade pending jobs). Never a live session's id, so
 *  readers must skip it — it is not "some other session". */
export const UNKNOWN_CAPTURE_SESSION_ID = "(unknown-session)"

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
 * Hard dead-man switch for a whole drain. A live worker refreshes the lock
 * mtime every CAPTURE_LOCK_UPDATE_MS, so a genuinely hung worker would hold
 * the lock forever (staleness never trips). At this budget the worker
 * rejects the drain, releases the lock in its finally-block, and exits —
 * pending job files remain for the next spawn's retry (hash-ledger dedupe
 * makes overlap a no-op). Kept below the driver's respawn cadence horizon
 * and well above a realistic multi-window drain.
 */
export const MEMORY_DRAIN_HARD_TIMEOUT_MS = 12 * 60_000

/**
 * Drains a capture job with a deterministic (poison) extraction failure
 * gets before quarantine. Each drain already pays the strict-format retry
 * per poisoned window, so the second failed drain confirms determinism and
 * the job moves to failed/ — 4 wasted LLM calls per poisoned window over
 * its lifetime instead of weeks of repeats (the Oct-9 pile-up). Transient
 * failures (network, timeouts, retry-exhausted 5xx) never quarantine — the
 * 7-day sweep above stays their backstop.
 */
export const POISON_JOB_MAX_ATTEMPTS = 2

/**
 * How long quarantined jobs are kept in failed/ for post-mortems before
 * the drain sweeps them — long enough to notice and requeue after a model
 * upgrade (mv back into pending/), not so long they decay into noise.
 */
export const POISON_JOB_TTL_MS = 30 * 86_400_000

/**
 * Length bound for the assistant-capture gate: assistant turns enter capture
 * jobs only when pure text (no tool-call blocks, no thinking), ≤ this many
 * characters. Kills the ~93% work-product share of real coding sessions
 * before it costs extraction tokens; the extraction taxonomy decides
 * durability. See docs/memory-extension.md.
 */
export const MEMORY_CAPTURE_ASSISTANT_MAX_CHARS = 1_000

/**
 * Tool-turn capture lane (KIMCHI_MEMORY_CAPTURE_TOOL_TURNS): bounds for the
 * work summaries emitted instead of dropping tool-using turns whole.
 * Args carry the attempt (the command/query); results carry what the
 * environment returned. Result bodies use head+tail so a schema dump's
 * column list (head) and its final aggregate row (tail) both survive.
 */
export const MEMORY_CAPTURE_TOOL_CALL_CHARS = 400
export const MEMORY_CAPTURE_TOOL_RESULT_HEAD_CHARS = 500
export const MEMORY_CAPTURE_TOOL_RESULT_TAIL_CHARS = 200

/** Max NEW facts per progressive turn recall (per re-evaluation). */
export const TURN_RECALL_MAX_FACTS = 3

/** Per-fact character cap in turn recalls (steer messages stay compact). */
export const TURN_RECALL_MAX_FACT_CHARS = 400

/**
 * Drift-recall embedding query: characters kept from the last assistant
 * response. The response is the drift signal for terse follow-ups ("yes,
 * do that"), but in coding sessions it is mostly code — embedding it whole
 * (up to 2000 chars) dominated the per-turn gateway payload. The tail
 * carries the most recent context: questions, conclusions, next steps.
 */
export const TURN_RECALL_RESPONSE_CHARS = 400

/**
 * Total cap on the drift-recall embedding query (prompt + response tail) —
 * the per-turn bound on what memory sends to the embedding endpoint.
 */
export const TURN_RECALL_QUERY_MAX_CHARS = 1000

/**
 * Bounded wait for each detached drift search — background work that runs
 * alongside the turn's request, so it never blocks the user, but a hung
 * call must not hold the in-flight recall valve (or the indicator) forever.
 */
export const MEMORY_SEARCH_TIMEOUT_MS = 10_000

/**
 * Bound for memory work that gates the turn's start: the turn-1 digest
 * (which sits in front of the user's message echoing) and the detached
 * recall's quick legs (decision gate, searcher init) whose settling releases
 * the in-flight valve. Healthy runs measure ~1 s (digest) and ~0.25 s (gate),
 * so this is ~2× headroom: a slow gateway degrades to skip-within-this-budget
 * instead of freezing the screen — or wedging the valve — for the search
 * timeout.
 */
export const MEMORY_PRE_REQUEST_TIMEOUT_MS = 2_000

/**
 * Tag marking a captured fact as a prior DERIVATION (an interpretation,
 * judgment call, aggregation choice) rather than an external observation.
 * Owned by the KIMCHI_MEMORY_FACT_CLASSES lane: extraction elicits the
 * prefix, digest rendering splits on it. String (not schema) so no store
 * migration is needed and the tag survives valuation/dedupe untouched.
 */
export const EXTRACTION_DERIVED_TAG = "[derived]"

/**
 * Per-attempt bound for memory-owned gateway requests that go through the
 * mem0 SDK clients (embedder fetch interceptor + OpenAILLM config). The
 * OpenAI SDK default is a ~10-minute per-attempt timeout and mem0's
 * embedder constructor never sets one — one hung socket otherwise parks a
 * capture drain for tens of minutes, well past any external driver abort
 * point. Does NOT govern our own chatJson/fetchWithRetry path, which has
 * its own per-attempt timeout.
 */
export const MEMORY_REQUEST_TIMEOUT_MS = 60_000

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
