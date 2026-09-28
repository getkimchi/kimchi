# Independent review: communication versus ordinary work

These runs do not establish a code-quality advantage for the board over ordinary workers. In 12 completed Kimi K3 comparisons across two repairs, ordinary workers and board-enabled workers each passed one of two frozen OAuth comparisons; no mode completed the compaction contract. The board used fewer output tokens than ordinary workers on compaction and about the same on OAuth. Both team modes used substantially more than solo.

| Mode | Compaction: full checks passed | OAuth: frozen checks passed | Compaction output tokens, two runs | OAuth output tokens, two runs |
|---|---:|---:|---:|---:|
| Solo | 0/2 | 0/2 | 58,484 | 29,183 |
| Ordinary workers | 0/2 | 1/2 | 149,941 | 88,874 |
| Board and messages | 0/2 | 1/2 | 119,575 | 88,267 |

Each workload used the same source, model (`kimchi-dev/kimi-k3`, low thinking), public checks, independent grader and budget ceilings across modes. All modes received the [independent-review brief](../../scripts/agent-communication/evidence-review-brief.md), selected from the [research review](coordination-policy-research.md). Ordinary workers retained shared files and parent coordination. Worker Ferment was off. The second block reversed the mode order. Tools and their guidance were removed together in the controls, so this compares the available workflow, not transport alone.

The brief itself was not compared against a concurrent no-brief control. It remains experimental. These are two repetitions on previously observed tasks, not evidence of general equivalence or a universal best workflow. Token totals include reasoning and are not billed cost. Elapsed times share host resources and are descriptive, not an application-performance benchmark. Detailed outcomes, usage, manifests, hashes, receipts and failures are in the [evaluation record](evidence-review-evaluation.json).

## What the independent checks found

Five compaction outputs pass their public tests, typecheck, style, build and both real-process probes: 2/2 original and 2/2 repeated continuation/cancellation checks. The ordinary-worker repeat fails its own tests, types, style and build; its independent process and lifecycle checks cannot run.

| Mode | Compaction lifecycle: first / repeat | OAuth late fallback: first / repeat |
|---|---|---|
| Solo | 3/6 / 2/6 | Fail / fail |
| Ordinary workers | 3/6 / unbuilt | Pass / fail |
| Board and messages | 3/6 / 2/6 | Fail / pass |

Every first-block compaction repair returns early for a final assistant response before using its token usage to clear suppression. They therefore miss repeated pressure after a successful final response and rearming after relief. Solo and board also retain an aborting fallback when the inline adapter is missing; ordinary workers instead fail the late-completion notification check. The buildable repeats still miss rearming and the missing-adapter check: solo additionally fails abandoned-call handling, while board fails late-completion notification. Their added tests did not establish these behaviors.

All six OAuth outputs pass the 53 public tests, types, style and independent refresh-discovery check. The delayed-fallback check separates them: solo fails twice, ordinary workers pass the first run, and board passes the repeat. A further diagnostic asks whether fallback starts after the total deadline has expired. It fails on both frozen-score winners and on the historical reference. That diagnostic remains separate from the frozen score; it identifies a weakness the reference also has.

All outputs preserve protected files. Worker budgets materially affected compaction: all three initial workers stopped at their token limits in the first block; all four ordinary workers exhausted their limits in the repeat. Both board repair workers completed. The ordinary parent performed formatting cleanup in its first run despite worker ownership of production repairs. The solo compaction repeat received one recorded approval after the permission checker saw a truncated edit; the observer read the full edit before approving it. No budget was extended. These deviations remain recorded. Formatting success does not establish readability, and application performance was not measured.

## What communication changed

The first compaction board run made no manual post or directed-message call. A worker read three automatic work entries. The repeat made two accepted finding posts and one accepted peer message, after an aborted send and a schema rejection. The recipient had recorded the recommended inline-compaction design before delivery; it then read the board finding and shared note as confirmation. The trace establishes an exchange, not a unique improvement caused by it.

The OAuth board runs used the channels more fully. The first had two accepted posts, an accepted peer status and an accepted parent handoff; a send to a finished peer was unavailable, and a later answer on the closed handoff thread was rejected. The repeat had two accepted posts and three peer questions, each with an accepted answer. Those exchanges checked whether failing tests reflected ongoing edits and whether a new test's type error was already fixed. No parent board read returned bodies in either workload. Channel activity therefore occurred, but it did not produce a repeatable advantage over ordinary workers.

The unavailable-peer recovery hint did work in a native continuation. After receiving it, a worker called `list_agent_contacts`, found no peers, and sent a handoff through the existing parent route. The parent received it. This confirms a usable recovery path in that case; the final code still failed the late-fallback check. Routing recovery and code quality are different outcomes.

One worker's apparent SDK evidence was also wrong. It claimed a client could not reconnect after a failed connection, but its fake transport's `close()` never invoked `onclose`. A separate check using pinned MCP SDK 1.29.0 and the real HTTP transport, with injected HTTP responses and no network calls, successfully reconnected the same client after closing. The original probe and counterexample are recorded. This post-inspection check does not change the frozen score or prove the complete fallback path correct; it rejects the worker's general SDK claim.

## Changes retained and verified

Two product/capture fixes came from earlier observed failures. An unavailable peer receipt now suggests refreshing exact contact IDs and reporting to the parent if the peer is absent, while preserving existing routing and error hints. The runner caches host-created TMUX metadata before inference and restores it atomically if workspace cleanup deletes or replaces it. Parent settlement time stays separate from delayed observer cleanup. Unit regressions and a live metadata-deletion check verify these behaviors; the peer fallback above adds native follow-through evidence.

The experiment runner now reads the model from its frozen manifest for parent launches, worker prompts and launch enforcement. `--model` selects a configured model when preparing a fresh cohort; defaults preserve the earlier GLM protocol. Its regressions fail before the change and pass afterward: 12 runner tests, four protocol tests and lint/typechecking pass. Prior retained-fix validation also includes 161 agent tests, 12 trace tests, the binary build and three built TUI workflows. Existing unused-import and Node-version warnings did not fail those checks.

All K3 comparisons used binary SHA-256 `c326cc08ca534446e5ea542454c547678c763887c1d4f47e61382e18df01a2db`. Parent and worker histories confirm the selected model. Each workload passed all 56 isolation checks and reproduced its baseline/reference grader results before inference. Final input hashes were verified, all owned sessions stopped, and all 12 temporary credential homes removed. Captures: `/private/tmp/kimchi-compaction-arms-yyvf3hhm` (compaction) and `/private/tmp/kimchi-compaction-arms-qla_i5qg` (OAuth).

## Earlier GLM attempts

The earlier GLM cohort remains separate: 13 started attempts, three completed OAuth workflows and ten provider failures. Ordinary workers passed the frozen OAuth checks; solo and board missed late fallback. Those three completed runs used binary `78d847ed39d789217f8c4f51d6da6300f09917d124bc62f0b461e4b3c679c21b`, before the recovery fixes.

One later GLM solo attempt produced a partial compaction repair before failing after 825 seconds. It passes its tests, types, build and process probes, but fails style and four of six lifecycle checks. It received one scoped test-command approval. That interrupted artifact is diagnostic evidence, not a completed solo score. Captured provider diagnostics identify `overloaded_error` / `no_available_workers`, including HTTP-200 responses. Small and full-context readiness requests succeeded between failures, so readiness did not establish capacity for a complete repair.

All attempts, unstarted cancellations and cleanup receipts remain recorded. Captures: `/private/tmp/kimchi-compaction-arms-hpe9bwww`, `/private/tmp/kimchi-compaction-arms-6v5lkdgb`, `/private/tmp/kimchi-compaction-arms-fm6y53xu`, and the prepared but unstarted OAuth cohort `/private/tmp/kimchi-compaction-arms-hhas_8p0`. All their credential homes were removed before the model change.

Keep communication optional and retain the verified recovery fixes. This evidence does not justify mandatory board reviews, promoting the experimental brief, or adding another coordinator.
