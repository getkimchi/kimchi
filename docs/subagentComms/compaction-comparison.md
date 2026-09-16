# Communication during a longer compaction repair

The board produced the strongest individual repair in this comparison. Its two outputs passed 3/6 and 6/6 supplemental lifecycle checks; ordinary worker coordination passed 3/6 and 4/6. The valid messages-only output passed 5/6. This is a positive individual result, but does not establish a repeatable advantage caused by communication. Time and output-token ordering reversed between the two board/control pairs.

Eight isolated attempts used the built Kimchi harness and bundled TMUX controller. Six completed their parent workflow. One messages attempt was cut off by a monitor defect, and one solo attempt waited for permission until its time limit. Both remain in the record.

## Results

Each process suite contains continuation and cancellation checks. The repeated suite additionally requires two effective compactions within the original request. The lifecycle column uses the corrected event fixture described below; it is supplemental and was applied after examining outputs.

| Attempt | Coordination | Workflow | Seconds | Original / repeated process checks | Lifecycle checks | Output tokens |
|---|---|---|---:|---:|---:|---:|
| 01 | Solo | Completed | 610 | 1/2 · 1/2 | 4/6 | 37,007 |
| 02 | Ordinary workers | Completed | 1,073 | 2/2 · 2/2 | 3/6 | 79,827 |
| 03 | Messages | Observer-invalid | 44 | Excluded | Excluded | 370 |
| 04 | Messages and board | Completed | 805 | 2/2 · 2/2 | 3/6 | 65,064 |
| 05 | Messages and board | Completed | 911 | 2/2 · 2/2 | 6/6 | 69,893 |
| 06 | Messages | Completed | 784 | 2/2 · 2/2 | 5/6 | 61,767 |
| 07 | Ordinary workers | Completed | 656 | 2/2 · 2/2 | 4/6 | 54,867 |
| 08 | Solo | Permission-blocked | 1,801 | 2/2 · 2/2* | 2/6* | 26,326 |

\* Attempt 08's saved code was graded after stopping. These are partial-output results, not a completed workflow or a time-to-repair measurement.

All six completed outputs passed their own tests, typechecking, formatting and build. The blocked solo snapshot passed tests, types and build but failed formatting. The known broken baseline passes 1/2 in each process suite and 0/6 lifecycle checks; the reference passes 2/2, 2/2 and 6/6.

The [evaluation record](compaction-comparison-evaluation.json) retains every attempt, frozen scores, supplemental scores, usage, launch parameters and cleanup receipts. Recorded token totals include cached input and are not billed cost.

## What improved, and what remained wrong

All five completed team outputs fixed the main continuation behavior and passed repeated real-process compaction. The completed solo output summarized successfully but sent the old context on the next request: moving compaction into the context handler missed the existing resynchronization hook for that request. Passing its own tests did not catch the integration error.

The supplemental checks still find lifecycle gaps in five of the six completed outputs. They cover incomplete pairs, abandoned calls, final-response rearming, ineffective episodes, replacement attempts and unavailable adapters. The first board repair keys pressure state to extension-context objects, although pinned Pi creates a new context for each event. The ordinary-worker outputs retain an aborting fallback when the inline adapter is absent. The messages output passes that case but fails the stale-completion fixture. The second board output passes all six tested cases; that does not establish correctness for every lifecycle path.

The initial workers kept separate edit ownership in the inspected histories. The repair worker then edited the combined result. Parents in attempts 02 and 05 made small test-fixture corrections after repair stopped; the inspected histories show no parent production repair. Protected files were preserved. This is evidence of orderly integration across all team conditions, rather than a distinguishing board benefit.

Formatting passed for every completed output. Readability was not blindly scored, and application performance was not benchmarked. The first board repair added a 360-line lifecycle helper yet retained suppression and overlap problems. Its larger implementation did not provide stronger behavior than the ordinary-worker output in that pair. The second board result used a smaller change in the existing guard and passed more checks. Those observations do not support a general style advantage for either condition.

## What communication contributed

Attempt 04 returned 79 board-entry bodies: 76 TODO work snapshots and three returns of one lifecycle finding. Two workers and the parent received that finding. The implementation had already written its inline-compaction repair before receiving it. The trace therefore cannot credit the finding with causing the core repair.

Attempt 05 returned 44 bodies: 42 work snapshots and two returns of one lifecycle finding. Both investigator and implementer received the finding before the production edits. Earlier source investigation already exposed the non-aborting primitive, and the task specified the lifecycle requirements. The finding may have helped consolidate that information, but there is no isolated causal demonstration. Neither board run sent a directed message.

Attempt 06 sent one implementation-to-parent status message with concrete type errors in the boundary investigator's tests. That investigator had already exhausted its budget; the parent assigned the remaining work to repair. This demonstrates an early failure report through the new channel. The trace does not establish that the report, rather than shared files and ordinary review, produced the higher lifecycle score. No accepted question-and-reply exchange occurred in the completed communication arms.

All five teams launched repair 43–61 seconds after the initial workers stopped. The earlier calibration took 863 seconds while the parent repeatedly waited through shell tools. The current common instruction explains yielding and explicit result retrieval, and every team reached repair. Because instructions and budgets changed together, this is an observed workflow improvement, not an isolated guidance or communication effect.

The result fits the distinction in the [research review](communication-research.md): shared code and tests already coordinate work. A board can expose a finding before it reaches those artifacts, but reading progress entries alone does not demonstrate saved investigation, a changed decision or a better final result.

## Evaluation limits and corrections

Protocol `a2d41292` fixed the task, model (`kimchi-dev/glm-5.3-flash`, low thinking), public checks and inputs before inference. Every arm could read all task source and shared artifacts. Worker Ferment was disabled. Limits were 24 million recorded tokens, 80,000 output tokens and 1,800 seconds. Investigators had 10,000 output tokens each; implementation and repair each had 20,000. Accepted launches matched the effective parameters and required initial grouping. All 74 isolation/toolchain checks passed.

The product binary came from `97d528a4`, SHA-256 `f4e2029a36c658c8bcdb57e28114c7f176e151d1cc994d7dc905b5f5a42ccbb9`. All arms used `auto` permissions. The host injected no additional instructions, approvals or restarts after submission. The two batches ran sequentially, with reversed arm order in the second batch. This is one task family, one model and very few completed observations per condition.

Attempt 03 exposed a monitor defect. A provider retry began at 40.351 seconds while the saved assistant message still contained the previous error. The monitor stopped the run at 43.988 seconds without a root settled event. Commit `26514b86` requires root settlement after the latest request, alongside worker termination. Nine runner tests pass, including retry and child-settlement regressions. Auditing the other stopped attempts found no second false settlement.

Attempt 08 reached an approval prompt for `rm -rf scratch` before its public test command executed. It then exhausted the fixed wall limit. Its stalled time cannot be interpreted as execution speed, and the saved source is reported separately from completed work. Permission behavior is part of an unattended experiment's conditions even when filesystem isolation is already in place.

The frozen lifecycle fixture also rejected valid implementation choices. It populated branch and cached messages but omitted entries/leaf access, the real `turn_end.toolResults`, matching event call IDs and the next context event. A reused context object could hide state wrongly keyed to that object. The [event supplement](../../scripts/agent-communication/event-compaction.diff) keeps the six assertions and supplies those runtime surfaces consistently, with fresh contexts. It passes 6/6 on the reference, 0/6 on the broken baseline, and typechecks on the reference. All original scores and intermediate fixture results remain retained. This is still a mocked lifecycle check; the real-process suites provide separate integration evidence.

All eight process trees stopped and their copied credential homes were removed. Artifacts remain at `/private/tmp/kimchi-compaction-arms-xryygkps`; supplemental fixtures and intermediate results remain at `/private/tmp/kimchi-event-check-dxszu68c`. Repository changes from this round are evaluation tooling and evidence. Generated repairs remain in the isolated artifacts.
