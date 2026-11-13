/**
 * Memory extension configuration: scope, digest value bar, storage paths.
 * Pure — unit-testable under Node. Holds the storage-path helpers so that
 * backend.ts stays the import leaf (backend imports config, never the
 * reverse).
 */
import { homedir } from "node:os"
import { join } from "node:path"

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
// Per-window character budget for extraction. 8k chars (~2k tokens) is
// nothing against extraction-model context windows and lets one call see a
// complete episode arc — hypothesis, attempts, outcome, conclusion —
// instead of fragments cut before a conclusion was visible.
export const MEMORY_CAPTURE_WINDOW_CHARS = 8_000

/**
 * Length cap for a single stored fact, enforced before the store add —
 * the embedder's context is 8192 tokens and an extraction occasionally
 * emitted monster facts (an observed 8193-token embed input caused a
 * deterministic 400 loop). The extraction contract says short
 * self-contained sentences; anything over this is skipped and counted,
 * never truncated (a truncated fact risks storing a misleading
 * half-sentence). ≈500 tokens at typical tokenization.
 */
export const MEMORY_FACT_MAX_CHARS = 2_000

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
 * Per-job COMMIT parallelism inside a drain (phase C): jobs write disjoint
 * fact sets to pre-created backends, and the per-fact embedder round-trips
 * dominate the commit wall time — serial commits turn a big catch-up drain
 * into minutes of idle HTTP. Bounded; no LLM involved, just embedder +
 * sqlite. Override: KIMCHI_MEMORY_DRAIN_COMMIT_CONCURRENCY.
 */
export const MEMORY_DRAIN_COMMIT_CONCURRENCY = 4

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
// Mid-loop increment: how many uncaptured messages accrue before the next
// capture job spawns. ~30 spans a fuller episode arc — windows see
// hypothesis→outcome→conclusion, which is what extraction needs; much
// smaller and each window is mid-deliberation with nothing complete to
// extract.
export const MEMORY_CAPTURE_INCREMENTAL_MESSAGES = 30

/** Record key for drain-attributed jobs whose job file predates session
 *  attribution (pre-upgrade pending jobs). Never a live session's id, so
 *  readers must skip it — it is not "some other session". */
export const UNKNOWN_CAPTURE_SESSION_ID = "(unknown-session)"

/**
 * Max captured messages per shutdown job: long sessions split their
 * remainder into bounded jobs instead of one monolith. Smaller jobs
 * mean a worker crash or poisoned window drops only its own span
 * (quarantined), and the backlog keeps draining job by job.
 */
export const MEMORY_CAPTURE_JOB_MAX_MESSAGES = 30

/**
 * Tool steps between mid-episode recall evaluations in agent loops (the
 * step-budget trigger). Same constant also defines the cross-trigger
 * suppression window: a recall injected by ANY path within the window
 * blocks the step trigger. KIMCHI_MEMORY_STEP_RECALL_INTERVAL env
 * overrides for bench tuning.
 */
export const MEMORY_STEP_RECALL_INTERVAL = 25

/** Chars of the latest assistant response kept as the reasoning head of a mid-loop recall query. */
export const MEMORY_STEP_REASONING_HEAD_CHARS = 400

/** Chars of each retained tool-result state tail kept for a mid-loop recall query. */
export const MEMORY_STEP_ENV_TAIL_CHARS = 600

/**
 * Total character budget for a mid-loop recall query. Separate from
 * TURN_RECALL_QUERY_MAX_CHARS (1,000): the loop query must carry the
 * reasoning head PLUS observable context; at 1,000 the embedding
 * collapsed to an input-echo line and recalls landed topic-broad.
 */
export const MEMORY_STEP_QUERY_MAX_CHARS = 2_000

/** Characters retained per kept receipt-side state slice (head+tail total, before truncation). */
export const MEMORY_STEP_ENV_RECEIPT_KEEP_CHARS = 4_096

/**
 * Recent message texts (user/assistant summaries) embedded as recall
 * facets alongside the reasoning head and receipts — thinking-less turns
 * otherwise collapse the query to bare receipt echoes. 0 disables.
 */
export const MEMORY_LOOP_CONTEXT_TURNS = 6
export function loopContextTurns(env: NodeJS.ProcessEnv = process.env): number {
	const raw = Number.parseInt(env.KIMCHI_MEMORY_LOOP_CONTEXT_TURNS ?? "", 10)
	return Number.isFinite(raw) && raw >= 0 ? raw : MEMORY_LOOP_CONTEXT_TURNS
}

/** Chars of each recent message text kept as a recall facet. */
export const MEMORY_LOOP_CONTEXT_TURN_CHARS = 160

/** Max distinct state fingerprints remembered per session for state-revisit detection; env override. */
export const MEMORY_STATE_FINGERPRINT_CAP = 512
export function stateFingerprintCap(env: NodeJS.ProcessEnv = process.env): number {
	const raw = Number.parseInt(env.KIMCHI_MEMORY_STATE_FINGERPRINT_CAP ?? "", 10)
	return Number.isFinite(raw) && raw > 0 ? raw : MEMORY_STATE_FINGERPRINT_CAP
}

/** Tool steps between mid-loop recall evaluations; env override. */
export function stepRecallInterval(env: NodeJS.ProcessEnv = process.env): number {
	const raw = Number.parseInt(env.KIMCHI_MEMORY_STEP_RECALL_INTERVAL ?? "", 10)
	return Number.isFinite(raw) && raw > 0 ? raw : MEMORY_STEP_RECALL_INTERVAL
}

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
 * Final livelock backstop for a whole drain. The primary watchdog is the
 * inactivity one below: a live worker heartbeats on every settled window
 * and committed job, so a healthy catch-up drain over a big backlog can
 * run long. Only a drain that keeps heartbeating but never finishes (a
 * livelock) trips this. Kept generous on purpose — the old flat 12min
 * budget aborted healthy catch-up drains mid-flight, which seeded the
 * backlog death spiral on high-throughput bench runs.
 */
export const MEMORY_DRAIN_HARD_TIMEOUT_MS = 60 * 60_000

/**
 * Inactivity watchdog: the drain aborts ONLY when no window has settled
 * and no job has committed for this long. Replaces the fixed re-list cap:
 * the drain now re-lists until the pending/ queue is EMPTY.
 */
export const MEMORY_DRAIN_INACTIVITY_MS = 240_000

/**
 * Drains a capture job with a deterministic (poison) extraction failure
 * gets before quarantine. Each drain already pays the strict-format retry
 * per poisoned window, so the second failed drain confirms determinism and
 * the job moves to failed/ — 4 wasted LLM calls per poisoned window over
 * its lifetime instead of weeks of repeats (the Oct-9 pile-up).
 */
export const POISON_JOB_MAX_ATTEMPTS = 2

/**
 * Cross-drain attempt cap for a WHOLly-transient failing job: a sustained
 * gateway outage (retry-exhausted 5xx) makes every drain re-run the same
 * windows and the drain gate blocks on pending-until-empty forever — the
 * transient livelock #1709-4523798599 flagged. Cap is generous (10 ≈ ~10
 * minutes of storms across drains; well under the 7-day sweep) and the
 * job JSON is preserved in failed/ for a deliberate requeue — the sweep
 * no longer has to be the only backstop. In-window retry jitter already
 * exists inside fetchWithRetry (computeRetryDelayMs), so no drain-level
 * pacing knob is needed.
 */
export const TRANSIENT_JOB_MAX_ATTEMPTS = 10

/**
 * Drains a capture job with a failing COMMIT (add/embedder — the store
 * side, not extraction) gets before quarantine. Higher than the poison
 * cap: extraction staging already made a retry a cheap re-add (no LLM
 * re-paid), and commit failures are likelier transient (embedder
 * outages, timeouts) than deterministic — the October incident's
 * unbounded re-drain loop is bounded here instead. Quarantined jobs keep
 * their staged facts in failed/ for the same manual mv-back requeue as
 * poison jobs.
 */
export const ADD_FAILURE_MAX_ATTEMPTS = 5

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

/** Default max NEW facts per progressive turn recall (per re-evaluation); env override. */
export const TURN_RECALL_MAX_FACTS = 5
export function turnRecallMaxFacts(env: NodeJS.ProcessEnv = process.env): number {
	const raw = Number.parseInt(env.KIMCHI_MEMORY_TURN_RECALL_MAX_FACTS ?? "", 10)
	return Number.isFinite(raw) && raw > 0 ? raw : TURN_RECALL_MAX_FACTS
}

/** Score window around the last kept rank that still counts as a tie —
 * tied visualizations of the same state are co-selected, not dropped. */
export const TURN_RECALL_SCORE_TIE_EPSILON = 0.02

/** Absolute hard cap on injected facts per recall, tie extension included. */
export const TURN_RECALL_HARD_FACTS_CAP = 8

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

/**
 * Drain traces kept under `traces/` (ring buffer, newest first) — the
 * `kimchi memory dashboard` data source. Tracing is always-on and
 * fail-soft; KIMCHI_MEMORY_TRACE_DRAINS overrides this, 0 disables
 * tracing entirely. A drain file is typically a few hundred KB (raw
 * windows + prompts), so 50 drains covers days-to-weeks of activity
 * within a bounded footprint.
 */
export const TRACE_DRAINS_KEPT = 50

/**
 * Recall traces kept under `traces/` (ring buffer, newest first) — the
 * retrieval-side companion to drain traces: one small JSONL per digest
 * computation, turn recall, or memory_search call. Files are a few KB
 * (query + hit list), so a hundred covers days of interactive sessions.
 * KIMCHI_MEMORY_TRACE_RECALLS overrides this; 0 disables recall tracing.
 */
export const TRACE_RECALLS_KEPT = 100

const CHARS_PER_TOKEN = 4

export function tokensEstimated(chars: number): number {
	return Math.ceil(chars / CHARS_PER_TOKEN)
}

export function digestDbPath(): string {
	return memoryDbPath(MEMORY_SCOPE_ID)
}

export function defaultMemoryDir(): string {
	return join(homedir(), ".config", "kimchi", "memory")
}

/** Scope ids interpolate into filesystem paths — allowlist strictly. */
const SCOPE_ID_RE = /^[a-z0-9-]+$/

export function memoryDbPath(scopeId: string): string {
	if (!SCOPE_ID_RE.test(scopeId)) {
		throw new Error(`invalid memory scope id: ${JSON.stringify(scopeId)} (allowed: ${SCOPE_ID_RE})`)
	}
	return join(defaultMemoryDir(), scopeId, "memory.db")
}
