# Workers without execution limits or loop stops

After the accepted-answer fix, two fresh comparison pairs used identical prompts, requested budgets and background scheduling. Removing the stops improved completion but used 2.39 times the recorded output tokens. All four repairs passed the same code checks.

| Measure across two trials per policy | Capped | Uncapped |
|---|---:|---:|
| Workers with host status `completed` | 5/6 | 6/6 |
| Worker Ferment objectives `complete` | 3/6 | 5/6 |
| Repairs passing all 12 frozen cases | 2/2 | 2/2 |
| Recorded output tokens, including parent and evaluators | 45,596 | 109,007 |
| Mean active time per trial | 227 s | 439 s |

The uncapped investigations included workers needing 11 and 28 evaluations. The latter repeatedly called `update_ferment_v2` after the work was evidenced, while the evaluator requested a final text reply. Across all workers, capped runs used 13 evaluations and uncapped runs used 56. One uncapped repair still paused when the evaluator returned no parseable verdict. No operator cancellation was needed.

The traces also exposed a judgment error. The assignment asked for a final reply covering “changed behavior, check result and remaining work.” The evaluator turned those topics into a literal-output requirement and rejected an informative summary for containing explanations. More retries can therefore change completion status without improving the work. The exact accepted-draft delivery fix does not address this earlier requirement-reading error.

Both policies produced the same small conditional structure. Capped repairs matched revision `== 2`; uncapped repairs broadened it to `>= 2`. The frozen cases cover revisions 1 and 2, so they do not resolve that future-version choice. These two repetitions of one fixture establish no broader quality, readability or performance gain.

The [evaluation record](without-stops-evaluation.json), under `post_delivery_comparison`, preserves all four outcomes, matched launch receipts, the judgment error and source hashes. The isolated build and 415 focused tests passed. All owned processes were stopped and copied credentials removed. Production defaults are unchanged. Both arms include communication and the delivery fix; this is a comparison of stop policies.

## Original comparison before the delivery fix

Removing the stops let all three workers return normally in one isolated K3 comparison. Both runs produced byte-identical correct code. The experiment shows a difference in worker completion; it does not establish better code quality or justify removing every guard from production.

| Measure | Capped | Uncapped |
|---|---:|---:|
| Workers with host status `completed` | 0/3 | 3/3 |
| Worker Ferment objectives `complete` | 1/3 | 2/3 |
| Independent code checks | 12/12 | 12/12 |
| Output tokens, including parent and evaluators | 38,454 | 33,956 |
| Active elapsed time, investigation plus repair | 212.07 s | 227.05 s |

The uncapped run used 11.7% fewer output tokens and took 14.98 seconds longer. This is one small fixture. The repair ran in the background in the capped run and in the foreground in the uncapped run, so the total usage and timing are observations, not an isolated estimate of the guards' cost.

### What ran

Both runs used the same experimental binary, separate filesystem sandboxes and real TMUX sessions. Two K3 workers investigated a changed timeout contract, shared findings and deferred the fix. The parent then restarted, recovered the board and delegated the repair to one new K3 worker. Each worker used Ferment v2. Assignments were byte-identical across runs; parent instructions differed in the budget clauses. No worker was retried or resumed.

The capped investigators requested 18 turns, 4,500 output tokens and 240 seconds each. The capped repair requested 35 turns, 8,000 output tokens and 240 seconds. The uncapped run omitted these arguments and disabled their runtime defaults. Evaluators used K3 during investigation; both runs also used K2.7 after the parent restart.

The [experimental patch](../../scripts/agent-communication/without-stops.diff) disables worker turn, token, duration and inactivity stops; tool repetition checks; message repetition checks and runtime quotas; and Ferment token, unchanged-continuation and consecutive-error stops. It covers initial and resumed worker paths. Permissions, contact authorization, message correlation, input-size validation, board retention, provider transport timeouts and final-answer acceptance remain in place. The flag applied only to the isolated build; that comparison did not change production source or defaults.

### What stopped, and what kept running

Both capped investigators stopped on `token_budget`. One had already reached Ferment `complete`. The capped repair produced the correct function, then stopped on `loop_guard` while Ferment continued checking its final response. Correct code, host completion and objective completion are separate outcomes.

Without those stops, the Contract investigator exceeded its former output-token cap, reached seven evaluations and completed. The Consumer investigator made eight identical board-read calls. The repair completed with two evaluations. All workers eventually returned; no operator cancellation was needed.

The uncapped Consumer investigator still ended with Ferment `paused`, despite an evaluator verdict of `met`. It rewrote the accepted 1,150-character draft into a 1,524-character final response. Ferment requires the accepted draft to be returned verbatim; the changed text triggered `final_answer_delivery_failed` in [the delivery check](../../src/extensions/ferment-v2/index.ts#L2328). The diagnosis remained correct. Removing execution and repetition stops did not resolve that delivery failure.

### Evidence

The [evaluation record](without-stops-evaluation.json) preserves launch arguments, session IDs, source and binary hashes, all worker outcomes, repeated calls, usage and draft/final hashes. The bundle changes several stop mechanisms together, so it cannot attribute the result to one of them.

The experimental build and 221 focused tests passed, including two checks of the experiment flag. Both outputs passed the existing verifier and an independent 12-case check covering contract revisions 1 and 2, seconds and milliseconds, and timeout values 0, 2.5 and 2500. Protected contract and verifier files remained unchanged. Both sandboxes passed isolation checks; owned processes were stopped and copied credentials removed.

The remaining failure pointed to the accepted-answer delivery path: Ferment approves a draft, then asks the model to reproduce it exactly.

## Delivery fix

The follow-up changes [message finalization](../../src/extensions/ferment-v2/index.ts#L1711) to deliver the accepted draft when the final model response succeeds with nonempty text and no tool calls. The existing hook updates the screen, saved journal and worker result together. Errors, aborts, empty replies and stale drafts keep their existing handling. The final model request still runs; execution limits and evaluator checks remain unchanged.

The rewrite regression failed before the fix. Afterward, 366 Ferment tests, 12 compiled TUI workflows and 28 smoke tests passed. Forced-rewrite tests verify that the model's changed wording reaches neither the screen nor the journal. Build, lint and typechecking passed, with one pre-existing unused-import warning.

One fresh K3 worker completed the timeout repair with normal guards enabled: host `completed`, Ferment `complete`, two evaluations, and the exact accepted 783-character answer saved. The parent run settled in 32.53 seconds; all 12 independent code checks passed. Its isolated process and copied credentials were cleaned up. This is a delivery smoke check, not a matched quality or performance comparison. The [evaluation record](without-stops-evaluation.json) retains it separately under `delivery_fix`.

## Response requirement fix

The [evaluator](../../src/extensions/ferment-v2/evaluator.ts) now distinguishes requested response topics from an explicitly prescribed literal answer. It also omits Ferment control messages from its next check. The captured failure included a previous judge's instruction that the reply “must be exactly” the topic list. Feeding that instruction back into the judge let the invented requirement persist. User messages, other context and tool evidence remain in the evaluator input, with their original evidence IDs.

Changing the prompt alone corrected one of two replays of the rejected summary. A second comparison included the feedback filter. Each comparison used four frozen cases, two repetitions and real K2.7 calls through an isolated compiled harness in TMUX; the second repetition reversed prompt order. The final comparison produced these model judgments:

| Case, two responses per version | Original | Prompt and feedback fix |
|---|---:|---:|
| Complete summary accepted with no invented literal | 0/2 | 2/2 |
| Incomplete summary rejected for missing content | 0/2 | 2/2 |
| Exact `OK` accepted | 2/2 | 2/2 |
| Extra text around `OK` rejected by the model | 0/2 | 0/2 |

The original judge rejected the incomplete summaries too, but imposed the invented literal string. One original complete-summary response was unparseable. Both versions incorrectly returned `met` for the extra-text cases while retaining `expectedAnswer: "OK"`; the unchanged host equality check rejects those answers. The table measures model judgments, including their binding to the complete candidate, rather than host completion. All 32 responses from both comparisons are retained under `response_requirement_fix` in the [evaluation record](without-stops-evaluation.json).

A fresh K3 worker using the combined fix passed all 12 code checks but still ended with Ferment `paused`. Its four evaluator responses treated the summary topics correctly, yet invented a proposed answer while the worker kept calling `update_ferment_v2`. The worker produced no tool-free final text, so the host rejected those responses. The earlier prompt-only worker also paused. This change improves the tested requirement interpretation; it does not establish reliable worker completion or better code quality.

Both regressions failed before their fixes. All 367 Ferment tests, the isolated build, lint and typechecking passed, with the existing unused-import warning. All four owned TMUX sessions were stopped and their copied credentials removed. Execution guards and final-answer equality checks are unchanged.
