# Memory extension

Opt-in persistent memory for kimchi sessions (the `extensions.memory` resource, off by default: `kimchi resources enable extensions.memory`, or `KIMCHI_ENABLE_RESOURCES=extensions.memory` for a transient enable). Facts about the user and their projects are captured from session transcripts in the background, stored locally in Mem0 OSS SQLite stores, and recalled into later sessions through a value-gated digest, a `memory_search` tool, and drift-triggered recall.

Facts are stored locally; extraction and embedding run through the kimchi gateway — the same endpoint as the chat model (`llm.kimchi.dev/openai/v1`).

## Storage layout

```
~/.config/kimchi/memory/
├── personal/memory.db                 # the global (personal) store
├── projects/<owner>/<name>/memory.db  # one store per repository
├── captured-hashes.json               # shared message-hash ledger
├── pending/                           # capture job files
└── capture.lock                       # drain serialization lock
```

Each store directory also holds `memory-history.db` (mem0's history manager). Stores use Mem0 OSS with its SQLite `MemoryVectorStore` — hybrid BM25 + entity + semantic retrieval — and remote embeddings (`bge-m3`, 1024 dims) via the gateway. The langchain adapter is semantic-only, which is why the SQLite store is load-bearing; this was settled in the phase-0 spike.

The project scope derives from the git remote (`owner/name`; GitLab subgroups kept whole). A fact captured inside a repository routes to that repository's store or the personal store — never both, because a project fact in the global store is recalled into every other project.

Both mem0 components require `better-sqlite3`, which does not load under Bun. The `shims/better-sqlite3` package (installed via pnpm override) reimplements it over `bun:sqlite`, with WAL and a 5s busy timeout for concurrent access. Upstream tracking: oven-sh/bun#36712.

## Capture pipeline

Four capture producers feed the pipeline, all sharing one runtime-local increment mark: an incremental job spawns once ≥30 uncaptured messages accumulate (the span covers a fuller episode arc — hypothesis, outcome, conclusion — which is what extraction needs to find anything durable), evaluated at `before_agent_start` (extension turn handler), `turn_end`, and after every `tool_result` — so long single-prompt tool loops drain mid-loop instead of accumulating a session-sized backlog; plus `session_before_compact` (the compacted-away span) and `session_shutdown` (only the tail past the increment mark, so nothing lands twice in the queue). The shutdown tail splits into bounded jobs of at most 30 messages each, so a failed job costs its own span rather than the session backlog. Each producer writes a small JSON job file into `pending/` (named by content hash plus the persistent session ID, so identical content in the same scope overwrites rather than queues) and spawns a detached worker; a write failure leaves the mark untouched, so the span is re-offered at shutdown rather than silently lost. The job's `dedupeSession` ID is distinct from its `session` ID (the per-runtime capture ID used for completion attribution), so resuming a session does not reprocess its history under a new runtime UUID and saved counts still read from the same runtime record.

The worker acquires `capture.lock` (proper-lockfile, mtime refreshed while held) and drains **all** pending jobs, oldest first. One drain at a time makes the concurrent-worker ledger race impossible, and a failed run's job file is retried by the next spawn. Jobs older than 7 days are swept at drain start. A holder records its pid in `capture.lock.pid`: a competing worker that sees the holder process dead breaks the lock on its next 5s poll (the break removes the lock dir directly — the drain is ledger-idempotent against an overlapped overlap); without a sidecar, a crashed worker's lock is stealable after 15 minutes without an mtime refresh.

Per job:

1. **Filter** — messages already in the shared hash ledger are dropped; empty jobs are deleted.
2. **Window** — messages are packed into windows by an 8,000-character budget, chronological order preserved. A single oversized message extracts whole; there is no message-count cap.
3. **Extract** — two LLM passes per window: user-stated facts, then a cautious pass for assistant-established facts. User-stated coverage includes possessions and resources the user acquires or starts using, captured WITH their stated purpose or use (the retrieval anchor: "got a Suica card for getting around Tokyo" matches a Tokyo-transit question where a bare name does not), and per-occurrence enumeration — each class, purchase, or item is its own dated fact, never merged or dropped; an event described in a dated update carries that update's date. Assistant turns pass a structural gate first (pure text only — no tool-call or thinking blocks, truncated at 1,000 characters), which removes ~93% of a real coding session's work-product share before it costs extraction tokens. The assistant pass captures a statement only when the window shows the user engaged with it: asked, accepted, thanked, acted on, or referred back to it.
4. **Tag** — each fact is scoped personal or project. The unsure default is asymmetric: unsure → project, because a project fact in the wrong store is recoverable while a project fact in the global store pollutes every other project. When no project scope exists, the choice is not offered — the LLM still tags "project" if given the option, a finding from the 95-fact classification audit.
5. **Store** — `add(infer: false)` per store, after three deterministic quality gates (no extra LLM or embedding calls — the extraction prompts carry the same categories as negatives and decide first; these gates are the floor):
   - **Redaction** — every fact passes through the session-export PII redactor (`redactText` from `src/extensions/pii-redaction/redactor.ts`: emails, phones, SSNs, credit cards, IBANs, API/Bearer/OAuth/AWS/GitHub keys, `castai_v1_`, local auth paths), applied before dedupe so with/without-credential forms normalize identically. A credential never reaches the store (audit finding: an `sk-proj-…` OpenAI key had been captured; the redactor's custom patterns now cover that format for exports and memory alike).
   - **Durability filter** — session state is never a fact: PR/MR statuses, pipeline and test-run states, working-tree state (`wip`, `uncommitted`), environment inspection (`agents configured`, `variables injected`, `not installed`, `thinking:max`), debug state (`failing to load`), tool-output fragments (`Bash(…`), the placeholder stamps `as of the conversation`/`as of today`, and bare single-token fragments. Each pattern is pinned to a real store entry from the 2026-09-24 audit; skips are counted and logged per drain.
   - **Dedupe** — skip when the normalized text already exists (one local `getAll` read; idempotent adds, so a crash between add and hash-mark cannot double-add on retry). Additionally, an attribution-aware near-duplicate skip collapses the assistant pass's "the user's … per the assistant's …" twins onto the user pass's plain fact: only facts carrying the attribution marker are similarity-checked (token-Jaccard ≥ 0.5 on the attribution-stripped core, vs stored facts and this drain's adds), so plain "I …" facts are never risked.
6. **Supersede** — mem0's write path is add-only, so a new fact that changes a stored value would leave the stale row behind. After the chunk's adds, related memories are judged against the new facts and the explicitly-replaced ones are deleted (force-DELETE+ADD). The judge deletes only on explicit changed-value evidence; a fact that only considers, questions, or wants something is deleted when a later fact records the decision or approval for that same subject; identical facts are never deleted; the prompt's chronological rule keeps within-chunk value changes directionally correct.
7. **Mark** — hashes of fully-processed windows are written to the shared ledger (merged with whatever is on disk), and the job file is removed.

For incremental wave-replay/pilot checks, the opt-in `KIMCHI_MEMORY_SQLITE_LEDGER=1` uses the existing `capture-jobs.db` `message_hashes` table: each job's newly captured hashes are inserted before the job file is removed, and one compatible `captured-hashes.json` snapshot is exported at wave end. Pilot mode requires an explicit store root. Pre-enqueue filtering and downgrade imports use the legacy snapshot plus SQLite's current hashes. Defaults remain full JSON read/merge/write checkpoints and no stale snapshot gets hidden.

`KIMCHI_MEMORY_DEFERRED_BATCH_SIZE` optionally reduces a deferred-supersede prefix from the default 64 to 1–64 facts. Invalid input retains 64. Prefix advancement still requires every entry in that prefix to resolve successfully; legacy journals retain their established ordering, failed entries never claim completion, and legacy files without a cursor start at zero. This changes batch size, never semantic eligibility or authored correction protection.

For bounded canaries, `KIMCHI_MEMORY_DRAIN_ONE_WAVE=1` stops after one bounded job batch, after that batch's commit and semantic-cleanup phases, rather than immediately starting another wave. Only literal `1` enables this; the default still re-drains until pending work is exhausted. Other pending jobs, staged extractions, captured hashes and deferred evidence remain for the next worker.

Extraction runs at temperature 0 — at the gateway's default temperature, the same haystack produced different facts per run. Facts are **date-stamped when the conversation explicitly states or implies a date** ("As of 2023-05-26, planning a trip to Seattle"): the prompt mines dates from the conversation text, resolving relative expressions against the conversation's own stated dates and context. **Recording time never enters the LLM's input** — the extraction transcript is deliberately date-prefix-free and `CaptureMessage` carries no date: a session entry timestamp is a proxy that diverges from conversation time on replayed or imported history, and any instruction anchoring to it launders the proxy into fact text where the judge can no longer distinguish it from conversation dates. Undated facts stay undated and order internally via the drain's chronological commit order. The extraction prompts also ban the placeholder stamp "As of the conversation" outright — a real date from the conversation, or no date at all. The supersede judge encodes explicit-over-proxy precedence: a conversation-dated fact is never superseded by an undated fact or by recording time alone, unless the other fact explicitly says it supersedes ("up from", "replaced", "now"). The model is deepseek-v4-flash-0731 (benchmarks showed it is the only suitable model for extraction), resolved against the gateway's live model list at worker start; the auto router was removed from the extraction path after benchmarking showed it picks models suited to conversation rather than strict-JSON extraction at temperature 0. `memoryExtraction.model` in the kimchi config file overrides (authoritative — used as-is, without the gateway-list check the pinned default gets). HTTP retry uses the shared gateway reliability contract (`src/utils/http.ts`): 429 plus the Cloudflare 5xx family, jittered backoff, retry-after honoring, a 300s per-attempt ceiling above the edge's ~100s cutoff.

## Drain tracing and the extraction dashboard

Each drain is one logical JSONL record, partitioned by bytes rather than becoming thousands of individual drains. A collector groups its ordered partitions for readers. Compact tracing is the default: phase, decision, latency, counts, delivery outcome (`selected`, `attachedToTurn`, `steered`), `recall_id`, stable fact IDs and text hashes, without raw prompts or responses. `KIMCHI_MEMORY_TRACE_EXCHANGES=full` opts into full exchanges with the shared redactor by default; `KIMCHI_MEMORY_TRACE_REDACT=0` explicitly preserves raw values for local debugging only.

Writers are bounded: at most 128 queued events, a 262,144-byte per-file cap before rolling into ordered `.part-N.jsonl` partitions, bounded flush waits, and an 8 MiB aggregate byte budget. Ring retention keeps the newest 50 drains / 100 recalls, also by logical record. Workers flush at the end of a drain with a 50ms budget; stalled writers leave explicit dropped, failed, and unflushed counts rather than falsely reporting complete history. Each append has its own deadline, and timed-out attempts are reported as `timedOut`. A bounded flush does not claim completion of pending or in-flight writes. JSONL readers retain partial-line tolerance and legacy record compatibility. Every new fact write also carries versioned `MemoryMetadata` (lifecycle kind, source, optional episode/validity/confidence/derived/canonical/support fields, and a normalized text hash); legacy rows become `unclassified`, never invisible or silently upgraded into observations.

`kind`/`trigger`/`conclusion` are filterable at `/api/recalls`. The UI has a text outcome filter and a table column showing the latest canonical outcome, rather than treating an initial selection or an attach as evidence on its own.

`kimchi memory dashboard [--port N] [--no-open]` serves a loopback-only web UI over the queue and traces (rejects non-loopback peers): the pending queue with per-job state, quarantine, and capture-lock state; drains with summary stats; recalls with per-event hit/injection/gate/latency stats; and drill-down per drain/job/window to the full API exchanges and per-question decision probabilities, and per recall to the query, scored hits (injected ones marked), gate answers, and injected facts. It auto-refreshes every 5s (pausable) and runs until Ctrl+C. It is a sessionless op — it works with the memory feature disabled and is terminal-only (in-session `/memory dashboard` points you at the terminal command).

## Injection policy

Auto-injected context must earn its tokens:

- **Value gate.** The retrieval query is the session's opening prompt. With the decision gates on (the default), the d3 selector's per-candidate inject/skip judgment is the relevance check (embedding rank alone admitted rank-1 echoes and topic twins — the 0.2 threshold stays as the fallback when the selector is unavailable); at most 5 facts and 2,000 estimated tokens regardless. An empty digest is the normal outcome for unrelated sessions.
- **Enabled notice.** A constant `## Memory` section goes out on every start whenever memory is enabled — even when the digest is empty — telling the model that capture is automatic and that `memory_search` is the retrieval path. With the authored lane off (the default), there is no write tool; with it enabled, `save_memory` is actually registered and the corresponding notice says so. Constant bytes, so the prefix stays stable.
- **Cache contract.** Turn 1 awaits the digest within the existing deadline, then reuses the resulting prefix bytes on every later turn. An immediate digest stays attached verbatim; an empty, failed, or timed-out result selects the notice-only prefix and never retries prefix injection. Late facts arrive through progressive recall's conversation-tail messages. Compaction, a memory toggle, or a successful `/memory reset` starts a new prefix epoch.
- **Progressive recall.** From turn 2, each new prompt plus the tail of the last assistant response (400 chars, 1,000 total — code-heavy bodies stay out of the embedding payload) is a drift signal. A free lexical-coverage gate (≥30% of content words already covered by delivered facts means skip) decides whether a retrieval is worth an embedding call; new, diverse facts deliver as hidden steer messages appended to the conversation tail — never the prefix. The default is three; redundant paraphrases do not fill additional tie slots. Recall runs on every drifted user message with one in-flight evaluation at a time; latest drift coalesces, while only explicit lifecycle resets invalidate an earlier generation. One shared deduping embedder serves the personal and project stores, so each lookup embeds its query once.
- **Mid-loop recall triggers.** Single-prompt agent loops never re-enter `before_agent_start`, so two additional triggers evaluate the same gated recall pipeline (`recall.ts: runRecall`) mid episode, injecting as the same hidden steer. Trace records carry the trigger: `user-turn` | `step-budget` | `state-revisit`.
  - **Step budget** — every `MEMORY_STEP_RECALL_INTERVAL` (default 25; env `KIMCHI_MEMORY_STEP_RECALL_INTERVAL`) tool steps, count windowed from the last consumption (an injection OR a completed evaluation). Query = a structured generic `RecallNeed`: objective/blocker, the latest observable evidence, and optionally one distinct recent context facet. At most three facets share one 5s deadline; unchanged needs do not re-embed. Raw rumination is not a mandatory domain schema. Coalescing: one evaluation in flight at a time; a window that falls eligible during an in-flight evaluation is picked up by the post-completion re-check, anchored to the scheduling-time step count.
  - **State revisit** — every tool result is fingerprinted: whitespace-normalized lines with volatile counters stripped (a counter keyword + narrow phrasing bridge + its number; lines carrying numbers without counter phrasing keep them, so distinct states never collide). A repeated fingerprint fires **once per state** through the same chain with the repeated state's tail as its query; a strictly-monotonic session fires none. Fingerprint sets cap at `MEMORY_STATE_FINGERPRINT_CAP` (default 512) per session.
  - **Cross-path suppression.** Any injected recall — from any trigger — opens one full budget window before the step trigger may fire again (K = the interval, one shared constant); revisit evaluations are not interval-gated (a repeat is per-state-fatal anyway). Mid-loop state (counter, fingerprint sets, pending evaluation) resets on `session_compact` and on session-toggle flips, mirroring the delivered-ledger resets, and queued evaluations self-invalidate via a generation counter; while memory is disabled the triggers no-op entirely. The failure valve is shared with user-turn recall: one pipeline failure disables recall for the session.
- **Recall trace + dashboard.** Recall trace records include the `trigger` field (additive — the tolerant JSONL reader and old files are unaffected). The dashboard's Recalls panel renders a trigger column; the pending queue's job names drill into a read-only `/api/job` endpoint returning the raw pending-job JSON (`<pre>` view; names resolve only as exact files present in the pending dir).

- **`memory_search`.** The pull-based supplement for anything the digest did not surface; results carry a `[project]` provenance label when they come from the project store.
- **Status-line segment.** Every delivery also sets the extension status `memory` to the number of recalled facts currently in context (the delivery ledger's length) — cleared when the ledger empties (session-toggle flip, compaction) and on `/memory disable`. The `memory` status-line segment renders from that status, only after the first delivery — off by default, shown when pinned via `/customize-status-line`; ACP clients receive the same key/text through the `setStatus` bridge.
- **Capture feedback.** Each drain merge-writes a per-session completion record (`capture-completions.json` under the memory root, capped at the 50 most recent sessions; attribution by capture-session id — one per extension instance, so ACP servers hosting concurrent sessions keep separate counts). The extension reads it each agent start and keeps the segment's `· N saved` half current for this session's own stored facts (each half renders only when its value is present: `memory: 2 recalled · 1 saved`). Session-end capture (the bulk) surfaces in the `/memory` overview instead: "Last session: stored N memories", the most recent other session's entry.

## Decision gates (d3)

Five judgment calls run on the platform decision model (`d3` via `/typesafe/v1/systemone`): non-generative (per-option probabilities, `output_tokens=0`), questions batched ≤30 per call, usage tag `memory:decision`. The division of labor is unchanged — extraction facts still come from the chat model, retrieval still from embeddings; d3 only judges each candidate against a fixed, verbatim criteria text. Production wiring: `decision-gate.ts` (client), `gates.ts` (flag parsing + criteria builders — criteria text is pinned by `gates.test.ts` and changes only with a fresh calibration run; the spike was burned twice by paraphrasing).

| Gate | Insertion point | Judgment | Rule | Degrade on gate failure |
| --- | --- | --- | --- | --- |
| triage | capture, after windowing | window contains ≥1 durable fact? — FIVE per-window questions in one call (`user_stated_durable`, `engaged_assistant_answer`, `plan_or_dated_event`, `learned_conclusion`, plus the trace-only `insight_worth_future_self`) | skip extraction when EVERY gate class scores p(yes) < 0.3 (`TRIAGE_DURABLE_MIN_P`), else extract; the skip carries the argmax class + per-class probabilities into the drain trace | extract the window (fail-open) |
| valuation | capture, after redaction + durability filter, before store adds | keep this extracted fact? | discard only when d3 says `discard` at p ≥ 0.9 (`VALUATION_DISCARD_MIN_P`) | keep the job's facts |
| supersede | capture, one batched judge per store | does a new fact explicitly replace this memory? | d3 judge replaces the chat judge (E7: matched it 4/5 and caught the preference reversal it missed) | per-batch catch keeps all |
| digest | turn 1, after retrieval | does this candidate earn an injection slot for this prompt? | selector replaces the score threshold among retrieved candidates | threshold rule |
| recall | turns 2+, after the lexical coverage gate | is an archive search worth this drift signal? | skip the search when d3 says skip (E4: 9 searches → 1) | search anyway |

The gates are pure filters over the pre-gate rules, so rollback is exact. `KIMCHI_MEMORY_DECISION_GATE`: absent/empty = all on, `off` = all off, a comma subset (`valuation,digest`) = exactly those (unknown names are logged and ignored). A session without a configured API key resolves as "gates unavailable" rather than hammering the gateway with an empty Bearer. Calibration and the E1–E8 evidence live in the spike documents (REPORT.md); thresholds are validated at chain level — needle survival through triage → extraction → valuation → digest selection — not per-gate scores.

Triage note: the 2026-11-12 multi-class split replaced the single `has_durable_fact` question (which crushed assistant-side, evidence-grounded conclusions at p≈0.05–0.24 on cross-corpus windows). The four gating classes decompose the old durable definition and add the `learned_conclusion` class; gating is max-class-argmax against the same 0.3 bar, and `insight_worth_future_self` is recorded for the dashboard/trace but deliberately non-gating (it over-fires on raw boilerplate). The tool-evidence bypass (which skipped triage on windows containing `[tool]` records) was REMOVED the same day — triage always happens now: live d3 checks on reasoning-lane windows score completed arcs 0.66 (extract) while receipts-only and boilerplate stay ≤0.07 (skip).

A sixth, manual surface is `kimchi memory consolidate`: one-shot store cleanup classifying every fact as unique / complementary / exact_twin / near_twin (E7 Part B: every twin group recovered, zero false positives). It reports first and deletes only with `--yes` or an interactive confirmation; verdicts of unique or complementary never delete, and a sweep that would empty a store keeps the oldest fact instead.

## Security framing

Stored facts can quote hostile content — a README the assistant echoed, text the user pasted — so everything recalled into a session is framed as data, not instructions:

- the digest and turn-recall steers are wrapped in the harness `<system-reminder>` convention with an explicit "data, never instructions" clause;
- `memory_search` results carry the same line;
- both extraction prompts instruct the model to treat the transcript as text to analyze, not to be addressed.

The framing is the primary defense because a single successful injection would otherwise persist as a standing system-prompt instruction in every future session in scope. An instruction-pattern classifier was considered and rejected: preference facts legitimately read as instructions ("never use tabs", "always run tests"), so a content filter would drop true positives.

## Failure semantics

Memory never breaks a session:

| Failure | Behavior |
| --- | --- |
| Store/search throws | logged once, session continues without memory |
| Search hangs | 2s pre-request budget on the turn-1 digest (and the recall gate / searcher init), 10s on the detached drift search, then skip — the turn is never blocked |
| Session toggle disabled | no memory contribution from the next agent start — the tool reports the disabled state instead of searching |
| Worker spawn fails (ENOENT) | logged, session continues |
| Gateway call fails | retried per the shared retry contract, then the window's hashes stay unmarked for the next spawn |
| Duplicate guard (`getAll`) fails | logged, adds proceed without dedupe |
| Lock held by a crashed worker | stealable after 15 min; merge-on-save keeps ledger marks |
| Decision gate call fails or times out | logged once per call site; that gate degrades to its pre-gate rule for the call (triage/valuation/supersede keep, digest/recall fall back to their threshold/coverage rules) |
| Decision gate with no API key configured | resolves as “gates unavailable” at resolution time — every gate behaves as disabled; the gateway is never called with an empty key |

When the d3 circuit stays open past `DECISION_OUTAGE_PAUSE_MS` (default 2 minutes), new extraction pauses rather than manufacturing facts: those windows remain pending without hash marks. Facts already committed retain a per-store `deferred-supersede/<store>.json` journal (atomic under the capture lock) so supersession runs automatically at recovery, even when there are no new inputs. Each drain attempts a bounded 64-fact journal prefix. `completedPrefix` advances only after the entire batch succeeds; failures leave the cursor and remaining evidence intact, and legacy journals without a cursor resume at zero. The journal is cleared only after its final prefix completes. `/memory`, `/api/queue`, and `memory_status` expose deferred counts/state; malformed deferred state files fail loudly instead of disappearing.

## Tuning constants

All in `src/extensions/memory/config.ts`.

| Constant | Value | Why |
| --- | --- | --- |
| `DIGEST_SCORE_THRESHOLD` | 0.2 | a needle retrieved at 0.197 was dropped by the earlier 0.3 bar, while unrelated-query top scores measured 0.142–0.231 — 0.2 is the tightest cut that admits the confirmed miss. Re-measure with `pnpm run memory:measure` when retuning |
| `DIGEST_MAX_FACTS` / `DIGEST_MAX_TOKENS` | 5 / 2,000 | digest cost bound |
| `MEMORY_CAPTURE_WINDOW_CHARS` | 8,000 | extraction window budget — 2,000 measured too tight for reasoning-lane windows (1–2k aborted slices extracted zero); 8k carries full arcs |
| `MEMORY_DRAIN_CONCURRENCY` / `MEMORY_SUPERSEDE_BATCH_FACTS` | 6 / 40 | drain-wide extraction parallelism; facts per batched supersede judge call (one chronological view per store across the drain) |
| `SUPERSEDE_SEARCH_TOPK` | 8 | candidate search width per new fact for the supersede judge |
| `MEMORY_CAPTURE_INCREMENTAL_MESSAGES` / `MEMORY_CAPTURE_JOB_MAX_MESSAGES` | 30 / 30 | mid-session increments spawn past the wiring-owned mark; every job — increments and shutdown tails alike — is bounded at 30 messages (10 measured under-threshold: mid-deliberation slices with no completed arc extract zero) |
| `MEMORY_CAPTURE_ASSISTANT_MAX_CHARS` | 1,000 | an answer's key statement sits at its start — truncate, don't exclude |
| `TURN_RECALL_RESPONSE_CHARS` / `QUERY_MAX_CHARS` / `MAX_FACTS` / `MAX_FACT_CHARS` | 400 / 1,000 / 3 / 400 | drift-query bounds (response tail, total query) and steer size |
| `GATE_MIN_COVERAGE` | 0.3 | below this coverage, retrieval is likely to add value |
| `MEMORY_STEP_RECALL_INTERVAL` | 25 (`KIMCHI_MEMORY_STEP_RECALL_INTERVAL`) | tool steps between mid-loop recall evaluations; ALSO the cross-trigger suppression window — a fresh injection (any path) re-opens the window |
| `MEMORY_STEP_REASONING_HEAD_CHARS` / `MEMORY_STEP_ENV_TAIL_CHARS` | 400 / 600 | mid-loop query composition: reasoning head (text lane, else thinking lane) + per receipt head 200 + tail 400 |
| `MEMORY_STEP_QUERY_MAX_CHARS` / `MEMORY_STEP_ENV_RECEIPT_KEEP_CHARS` | 2,000 / 4,096 | mid-loop query total budget; per-receipt retention cap before per-use slicing (supercedes the earlier tail-only 600 + 1,000 total, measured nearly empty on live loop queries) |
| `MEMORY_STATE_FINGERPRINT_CAP` | 512 | distinct state fingerprints remembered per session for revisit detection |
| `TRIAGE_DURABLE_MIN_P` / `VALUATION_DISCARD_MIN_P` (gates.ts) | 0.3 / 0.9 | triage floor and valuation discard bar — chain-calibrated on LongMemEval; 0.35+ started dropping needle windows |
| `DECISION_BATCH_SIZE` / `DECISION_QUESTION_CAP` (decision-gate.ts) | 30 / 64 | questions per d3 call; the gateway hard-rejects >64 (spike-verified) |
| `MEMORY_PRE_REQUEST_TIMEOUT_MS` | 2,000 | bound for memory work that gates the turn's start: the turn-1 digest (pre-echo) and the detached recall's gate/searcher-init legs |
| `MEMORY_SEARCH_TIMEOUT_MS` | 10,000 | bound on each detached drift search — background work, never blocks the turn |
| `CAPTURE_LOCK_STALE_MS` / `CAPTURE_LOCK_UPDATE_MS` | 15 min / 30 s | staleness must exceed the worst-case legitimate drain |
| `PENDING_JOB_MAX_AGE_MS` | 7 days | the reaper |

## Embedding model

The embedder defaults to `bge-m3` at 1024 dims — the phase-1 embedding study's choice (best open-weight, within 0.8pp of the closed baseline). The model and dimensions are configurable in `~/.config/kimchi/config.json`:

```json
{
	"memoryEmbedding": {
		"model": "text-embedding-3-large",
		"dims": 3072
	}
}
```

Both fields are optional and validated (model: non-empty string; dims: positive integer — invalid values fall back to the defaults). The pair must move together — the vector store schema is built from the dims — so stores created with one dimension cannot be searched with another; reset them (`kimchi memory reset`) when switching. The dims size the store schema only: the embeddings request never carries OpenAI's `dimensions` truncation parameter (bge-m3 rejects it), so the configured dims must equal the model's native output. The A/B testing surface from the study (`MEMORY_EMBEDDING_*`, `OPENROUTER_API_KEY`) has been removed and is ignored if set; stores created with the old 1536-dim default must be reset.

The usage-tracking tag (`memory:embedding`) is gateway-only — requests are matched by origin, so a request to any other host never receives it. The extraction LLM defaults to `deepseek-v4-flash-0731` and is overridable via the config file's `memoryExtraction.model` (authoritative — used as-is, without the gateway-list check the pinned default gets).

Dependency footprint: mem0ai's peer `natural` is stubbed out (`shims/natural`, version-matched to the peer range) — its only use is a lazy PorterStemmer lookup that degrades to the built-in simpleStem. Both runtimes resolve the stub: dev via a pnpm override, the compiled binary by bundling it. It must not be externalized: in a cwd with no `node_modules` up-tree, Bun auto-installs the real `natural` from npm at runtime, and its sylvester→node-lapack→ffi chain throws under Bun (`require('ffi')` resolves to the builtin `bun:ffi`, which has no `Library`), printing a native-module diagnostic onto the TUI. Stubbing it removes natural's transitive tree (mongoose, mongodb, redis, memjs, wordnet-db, stopwords-iso) from every install. `pg` stays installed (eagerly imported by mem0's bundle). `compromise` is a real package in dev (truthiness-guarded in the search-path entity extraction, where an empty stub would throw instead of degrade); the binary externalizes it, so the lookup fails into that guard — except in `node_modules`-less cwds, where Bun silently auto-installs it.

## Management

`kimchi memory` (or the in-session `/memory` command — same grammar) manages what is stored:

```
kimchi memory                       overview: storage path, per-store stats, pending jobs
kimchi memory list [--scope local|personal|project|all] [--project <owner/name>]
                    [--limit N|all] [--offset N] [--json]
kimchi memory search <query>        [--scope ...] [--json]
kimchi memory delete <id> [...]
kimchi memory reset --scope all|personal|project [--project <owner/name>] [--yes]
kimchi memory consolidate [--scope ...] [--yes]   d3-assisted twin/trivial-redundancy cleanup — report first
kimchi memory explain <id>        lifecycle, provenance, support and recent recalls
kimchi memory edit <id> [--text <text>] [--kind <kind>] [--confidence <0..1>]
                   [--note <note>] [--scope personal|project|all] [--project <owner/name>]
                   [pin|unpin] --yes
kimchi memory maintain [audit|dedupe] [--scope personal|project] [--yes]
kimchi memory maintain rollback <checkpoint.json> --scope personal|project --yes
kimchi memory dashboard [--port N] [--no-open]   web dashboard over the capture queue and drain traces (terminal only)
kimchi memory enable | disable      (in-session /memory only — see the session toggle)
```

- `list` and `search` default to the local scope — the personal store plus the current project's (personal only outside a repository), the same scoping retrieval uses; `--scope all` sees every store, `--scope local` spells the default out, and `--project` pairs with `--scope project` only (every other scope rejects it).
- `list` shows the newest 50 facts, scope-labeled, with the ids that `delete` takes; `--limit all` lists everything.
- `delete` resolves ids across all stores, so no `--scope` is needed.
- `reset --scope personal` or `--scope project` wipes that store via mem0 `deleteAll` (the hash ledger is kept — already-captured sessions never re-capture). `--scope all` wipes the whole memory root — stores, history, ledger, pending — under the capture lock, keeping only the lock artifacts. Interactive confirmation unless `--yes`.
- `consolidate` runs the manual redundancy sweep from the decision-gates section: classification under the same criteria set, report-first, deletion only on `--yes`/confirmation, under the capture lock.
- `explain` shows the exact fact's scope, lifecycle metadata, support references and recent recall evidence. Legacy text-only evidence is labelled separately from stable fact-ID links.
- `edit` changes only an explicit ID through mem0 update, with `--yes` and the capture lock. Text is PII-redacted; `kind`, zero-to-one `confidence`, namespaced notes, and `pin|unpin` are supported. Pinning a hypothesis requires an explicitly verified kind. Authored edits are protected from passive supersession.
- `maintain audit` is report-only and creates a snapshot, counting exact/normalized duplicates, near clusters, lifecycle coverage, queue duplicates, invalid jobs, bytes, and oldest pending file age. `maintain dedupe --yes` collapses exact normalized duplicates only, retains canonical/support links, and preserves near-duplicate evidence. `maintain rollback --yes` restores vectors and mem0 history tables after validating every artifact. Both lock against capture; a resumable checkpoint is allowed only if the store matches expected or snapshot state; corrupt artifacts abort before mutation.
- Personal-store maintenance defaults to audits and snapshot-backed repairs, not resets. Disposable benchmark homes may be reset only by their owning harness — never by inferring a repository or benchmark path.
- Destructive changes are user-controlled, not model tools. With the authored lane off, there is no advertised or registered `save_memory`. The pull-based `memory_search` tool remains read-only.
- In-session, `list` and `search` open an interactive browser: page through facts with ↑↓/j/k (PgUp/PgDn, g/G), inspect the selection's evidence with `i` (PgUp/PgDn scrolls long evidence), delete it with `d`, quit with q/Esc/Ctrl+C — no need to copy ids for a separate delete. Other output renders as a read-only widget capped at the TUI's widget height; single-line results appear as notifications, and the view clears when you resume chatting. ACP clients use the custom `memory_get` and `memory_update` methods for equivalent inspection and exact-ID editing instead of driving the TUI browser.

## Session toggle and ACP control

Memory has two control layers:

1. **The feature switch** — the `extensions.memory` resource (`kimchi resources enable|disable extensions.memory`, or the ACP `set_resource_enabled` ext-method). Persistent, per-machine, and restart-required: it gates whether the memory extension is loaded at all.
2. **The session toggle** — `/memory enable` and `/memory disable` inside a session. Runtime state only: it flips memory for the *current session* (capture, digest injection, turn recall, and the `memory_search` tool) from that session's next agent start, and resets on restart. No flags, no scope — there is no persistent variant (that is the feature switch). The in-session overview shows the state ("Memory: disabled (this session)"); the `memory_search` tool answers with a "currently disabled" message instead of a misleading miss. A mid-session flip is a deliberate prefix change: earlier turns keep what was already injected (an accepted cache break), and the digest/ledger recompute on re-enable.

Over ACP the surface is custom ext-methods (`_kimchi.dev/…`, advertised in `_meta["kimchi.dev"]`), so IDE clients build their own memory UI instead of driving the TUI-oriented slash command. The store ops are sessionless — they manage the on-disk stores regardless of the feature switch; the state ops resolve a session:

| Method | Params | Notes |
| --- | --- | --- |
| `list_resources` | — | every resource with its effective state (the /resources machinery) |
| `set_resource_enabled` | `{ resourceId, enabled }` | persistent override; response carries `restartRequired`. Unknown ids rejected |
| `memory_status` | `{ sessionId }` | `{ featureEnabled, sessionOverride, sessionActive, stores, pendingJobs, … }` — `sessionActive` is the conjunction of both layers (false whenever the feature is off) |
| `set_memory_enabled` | `{ sessionId, enabled }` | flips the session toggle; rejected when the feature is off |
| `memory_get` | `{ id, scope?, project?, cwd? }` | `{ id, fact }` with the exact fact's lifecycle, support and recall evidence; unknown/ambiguous ids return `fact: null` |
| `memory_update` | `{ id, scope?, project?, cwd?, text?, kind?, confidence?, note?, canonical?, confirm: true }` | `{ corrected, deleted: [] }` for a partial exact-ID edit; client confirms, never infers scope from the server cwd |
| `memory_list` | `{ scope?, project?, limit?, offset?, cwd? }` | paginated facts, newest first (default limit 50) |
| `memory_search` | `{ query, scope?, project?, cwd? }` | ranked hits with scores |
| `memory_delete` | `{ ids: string[] }` | across all stores; unknown ids come back in `notFound` |
| `memory_reset` | `{ scope, project?, confirm: true }` | destructive — `confirm: true` required (the client owns its confirmation UI); `local` is not a valid reset scope |

The store ops share these params, which follow the admin grammar's scope semantics:

For exact-ID get/update, omitting `scope` searches all stores rather than guessing either a personal or server-project target. The returned `fact`, when present, includes its explicit `scope`. Unknown or ambiguous update IDs are `invalidParams` errors with `{ id, reason: "unknown-id" }`; capture contention is an `internalError` with `{ id, reason: "busy", retryable: true }`, not a successful edit.

| Param | Values | Notes |
| --- | --- | --- |
| `scope` | `local` (default) \| `personal` \| `project` \| `all` | `local` is the personal store plus the `cwd`'s project (personal-only outside a repository) |
| `project` | `owner/name` | pairs with `scope: "project"` only; rejected with any other scope |
| `cwd` | non-empty string | anchors `local`/default resolution; without one, local degrades to personal-only — never the ACP server's process cwd (a long-lived process unrelated to any session) |

`memory_reset` takes `scope` and `project` but no `cwd` — its target is fully determined by scope and project. The session toggle is keyed by the session's manager (`src/extensions/memory/session-toggle.ts`) — the same identity the extension reads — so `set_memory_enabled` lands exactly in the session the client named.

## Remote usage and outcome telemetry

When telemetry is enabled, memory emits content-free operational events through the harness's existing OTLP logs pipeline. This is separate from the local traces above and `usage.jsonl`: traces support debugging, the ledger answers local model-spend questions, and remote events measure adoption, queue health, capture yield, recall reach, explicit-tool usage, latency, and bounded failures.

- **Adoption:** `harness_launched` includes `config.memory_enabled`; live `memory.session_state` records initial/toggle active state and the authored-lane flag. The launch denominator is necessarily limited to users who consented to telemetry at launch — enabling telemetry later cannot reconstruct older launches.
- **Capture:** `memory.capture.schedule` and `memory.capture.spawn` distinguish durable enqueue/coalescing/backpressure/already-captured outcomes from asynchronous worker startup. Every bounded drain wave produces `memory.capture.wave` with duration, job/stored/filter/discard/quarantine counts, and queue depth/age; a fatal worker error produces `memory.capture.failed` with a bounded failure class. Worker summaries use pre-session device identity and `event.`-prefixed fields, with bounded pre-session drain before process exit and no originating pi session correlation.
- **Recall:** `memory.recall.completed` has one terminal record per digest/progressive evaluation, including empty, covered, no-searcher, failed, cancelled, timed-out, and stale outcomes, gate degradation, delivery kind/counts, composition, and duration. `selected_count` is not accepted delivery; cached digest reattachments do not inflate `delivered_count`, and digest search failure is not reported as `no_hits`.
- **Explicit tools:** `memory.tool.completed` records `memory_search` hits/no-hits/disabled/failure and `save_memory` saved/duplicate/length/disabled/failure outcomes, duration, and retrieval counts. Unexpected save errors still throw; memory search still degrades to its explicit unreachable-store result. Generic `claude_code.tool.*` accounting continues unchanged.

Producer domains publish only curated enums, booleans, durations, and counts, and the telemetry handler validates/allowlists each field. No fact or query text, fact IDs, project names, paths, PID, job names, raw errors, or tool arguments/results leave the process. Telemetry failures warn but never break capture, recall, tools, or the agent turn; ACP adds no client-facing events or replay entries.

Ai-optimizer stores every typed record in its dedicated `memory_events` ClickHouse family for Grafana. `session_id` identifies live sessions, `device_id` identifies worker/pre-session records, nullable event-variant columns distinguish absence from zero, and deterministic IDs deduplicate retried ingestion (use `FINAL` or ID-aware aggregation). PostHog receives reduced product summaries only: launch/memory state, scheduling outcome/message count, capture outcome/job/stored counts, fatal failure class, recall kind/trigger/outcome/delivered count, and tool/outcome/returned count. Spawn-only and detailed queue/gate/filter/discard diagnostics stay out of PostHog and are not forwarded at all.

The complete record schema and representative Grafana queries live in `src/extensions/telemetry/README.md`. Roll out ai-optimizer's migration and receiver before new producers; a ClickHouse insert failure follows the receiver's bounded detached-insert/retry contract. Dashboard JSON/provisioning is a human/ops follow-up once representative data exists. Model cost/token attribution remains on the existing gateway tags and local ledger, never this event path.

## Verification

- `pnpm run test` — unit tests (co-located `*.test.ts` next to each module).
- `pnpm run memory:check` — PART A is offline SQLite work. PARTS B and C require configured gateway credentials and may incur remote embedding costs; run that command only with explicit approval. For offline maintenance acceptance, use `bun run src/extensions/memory/maintenance.check.ts` (vectors, mem0 history, dedupe, rollback, and checksum preflight).
- `pnpm run memory:measure` — value-gate injection/no-injection rates over a sample session.
- `pnpm run memory:queue-scale` — offline Bun migration/restart/downgrade drill: 100,000 pending jobs, 1,000,000 captured hashes, two failed jobs, and a corrupt legacy file, with indexed reads, requeue/poison checks, and a 300-second bound. `KIMCHI_QUEUE_SCALE_JOBS` and `KIMCHI_QUEUE_SCALE_HASHES` support smaller dry runs. `KIMCHI_QUEUE_PRESERVE=1` preserves the temporary scale report.
