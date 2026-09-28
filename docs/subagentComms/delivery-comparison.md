# Delivery replay comparison

The corrected eight-run comparison found no final-correctness advantage from early messages or the board over ordinary artifacts. Both routes produced shorter continuations and less output on this fixture. Two repetitions of one small task cannot establish a general speed or quality improvement.

| Condition | Independent checks, each run | Mean worker time | Mean new output tokens |
|---|---|---:|---:|
| Ordinary artifacts | 15/15, 14/15 | 47.7 s | 3,524 |
| Early directed finding | 14/15, 15/15 | 19.4 s | 1,347.5 |
| Board finding | 15/15, 14/15 | 23.0 s | 1,583.5 |
| Delayed directed finding | 15/15, 15/15 | 35.8 s | 2,536 |

These are observed means, not estimates of repeatable savings. Time covers the worker's run, excluding build, TMUX startup and later grading. The three failing candidates all accepted an outcome for an attempt that had not started while the job had an older running attempt. Supplied tests and saved worker-authored tests passed when rerun, so those checks did not establish complete correctness.

## What was held fixed

Each continuation started from a copy of the same saved recipient session and unchanged workspace. All source files remained accessible. The task was to repair one event-projection function, with producer lifecycle rules and examples in `producer.py`. The checkpoint worker read only `TASK.md` and `consumer.py`; it already suspected cancellation and attempt-ordering defects. The replay therefore tests delivery of a verified finding to a partly informed recipient, not discovery of an entirely unknown bug.

The model was `kimchi-dev/glm-5.3-flash`, low reasoning, with Ferment disabled throughout. Each worker had the same 35-turn, 10,000-output-token and 600-second limits. Conditions ran as artifacts, early, board, delayed, then in reverse order. No candidate reached its limit.

The source was a queued, evaluator-controlled worker record. Test-only instrumentation sent the same finding through the real authorized message broker or board. The source performed no inference; neither did the parent. The finding described a completion followed by a cancellation request and supplied a reproduction. This is a delivery experiment, not evidence that workers autonomously discover and share useful facts.

The diagnostic uses a disposable built Kimchi binary and the bundled TMUX controller. Production modules in the working checkout were not changed. [Commands and implementation](../../scripts/agent-communication/README.md#delivery-diagnostic) and [aggregate evidence](delivery-evaluation.json) accompany this report.

## What recipients did

Both early messages appeared in the first provider request. Both board findings were read and appeared in requests 3 and 2 respectively, before the first consumer edit. Delayed messages appeared in request 5 of each run, after the first observed edit at tool completion. Controls received no finding body. Exact body checks distinguish these observations from board hints and accepted send receipts.

Every recipient read the producer contract and made exactly one consumer edit. Every edit already fixed the late-cancellation example. Both delayed recipients had passed all 15 checks before receiving the finding and made no subsequent code change. There was no observed consumer-code rework for communication to prevent in these runs.

Most of the time difference occurred after the first edit. Mean time to that edit was 8.6 seconds for artifacts, 6.0 for early messages, 5.4 for the board and 8.8 for delayed messages. Verification and reporting varied. The shorter early-message and board runs are a useful observation, but this sample does not separate reliable delivery savings from model variation or differences in verification effort. It provides no evidence about the generated code's execution performance, broad readability, or cohesion across components.

## Calibration and verification

Eight earlier continuations exposed two problems in the evaluation. The original grader expected `running` after a cancellation request, while the public contract left room for an intermediate nonterminal status. It also omitted a future outcome arriving before its own attempt started for an already-known job. The original 14-case scores and a separately applied regression check remain in the evidence file; they are not merged into the corrected comparison.

Version 2 made the status rule explicit and added the missing case before its checkpoint and eight continuations. Its frozen grader scores the original broken implementation 7/15 and the reference 15/15. A partial cancellation fix still fails other requirements, and syntax errors are reported as failures. This remains bounded coverage of the supplied contract.

The report verifies identical checkpoint hashes and tool schemas, actual provider model and reasoning settings, protected-file hashes, complete edit capture, and inference confined to the recipient. It reconciles saved assistant usage with native totals. Native totals include cloned checkpoint history; the report subtracts that history from each continuation. Corrected continuations used 63,495 input, 17,982 output and 358,976 cache-read tokens. Their shared checkpoint separately used 3,097 input, 470 output and 10,496 cache-read tokens. These are reported token counts, not a billing estimate.

One earlier checkpoint attempt stopped before inference because the sandbox preflight inherited the protected repository directory. The binary succeeded from the allowed trial directory, and the driver now uses that directory. The failed attempt was retained. All completed trial sessions were stopped, their final files captured, and temporary credential homes removed. The fixture and body-detection self-checks, timing regression and repository lint/typecheck passed; lint retained one unrelated existing unused-import warning.

Local captures are `/private/tmp/kimchi-delivery-d9wlxwp3` for the corrected cohort, `/private/tmp/kimchi-delivery-k501vwqo` for calibration, and `/private/tmp/kimchi-delivery-575cbsgj` for the failed preflight. Temporary captures may expire; the aggregate evidence preserves hashes, scores, usage and delivery observations.

The diagnostic makes native delivery and its costs observable. Testing long-work value still requires a costly discovery or a changed agreement that affects another worker's unfinished work, as described in the [research write-up](communication-research.md#when-earlier-decisions-stop-being-valid).
