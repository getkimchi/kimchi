# Compaction repair budget calibration

These two setup runs are separate from the [eight-trial pilot](compaction-pilot.md). They estimate whether the workflow can finish and expose weaknesses in its checks. They do not compare communication channels.

The task, model (`kimchi-dev/glm-5.3-flash`, low thinking), product binary, worker roles and individual limits stayed fixed. Aggregate limits increased to 12 million recorded tokens and 30 minutes; the 60,000 output-token cap stayed fixed. Recorded tokens include cached input and are not billed cost. The solo and ordinary-worker trials ran concurrently in separate sandboxes through the built Kimchi TUI and bundled TMUX controller. All 20 isolation/toolchain checks passed before launch.

Protocol `9f54b13f` was frozen before inference. The product binary came from `97d528a4`, SHA-256 `f4e2029a36c658c8bcdb57e28114c7f176e151d1cc994d7dc905b5f5a42ccbb9`. The manifest retains the preparation checkout separately from the protocol and product revisions. No prompts or steering were injected after initial submission.

## Solo output

The solo run finished after 776 seconds, using 333,554 input, 5,967,040 cached-input and 38,956 output tokens. Its own 134 tests, typecheck, style check and build passed. Independent continuation and cancellation checks both passed. A supplemental real-process probe also passed two effective compactions within the original request and cancellation during summarization.

The repair remains incomplete. The frozen four-cycle adapter test observed one compaction instead of four: the implementation returns early on final assistant responses, so a successful below-threshold final response cannot rearm it. A further test from the same frozen fixture found that an abandoned tool call from an earlier run blocks compaction in a later turn. That test fails on this output and passes on the reference.

All four original adapter diagnostics failed, but that count is not four demonstrated behavioral defects. Several assertions require the reference's diagnostic event or notification behavior. Those fail before checking the rest of the scenario. Source review also found an old-context comparison after asynchronous completion and an unconditional clearing of the in-flight flag; the current diagnostic does not isolate their consequences from its notification expectation.

Passing style checks establishes formatting compatibility. It does not establish improved readability. The code's comment claiming that a stateless pairing check ignores abandoned calls conflicts with the failing behavioral test.

## Ordinary worker coordination

The three initial workers were terminal by 393 seconds. The boundary investigator and implementation owner exhausted their output budgets; the lifecycle investigator completed. The parent first called `get_subagent_result` at 982 seconds and launched the repair worker at 1,256 seconds. It repeatedly used shell sleeps and checked for an implementation note. It described the implementation stop as a timeout, although the host record says `token_budget`. The repair worker also exhausted its output budget.

This delay has a concrete delivery constraint. Agent completion notifications in `src/extensions/agents/index.ts` use `deliverAs: "followUp"`. Pinned Pi 0.84.1 queues those messages while streaming and checks the follow-up queue after the current tool loop would stop. Repeated shell calls can postpone that point. The parent could retrieve results explicitly or end its turn to receive queued notifications. The trace and source establish the delay and delivery behavior; they do not prove that changing the receipt text would solve it.

A deterministic probe of the installed Pi loop confirms this ordering: a completion queued during the first tool execution remained absent from the next two model requests. It appeared only in the request after the assistant stopped calling tools. This probe uses fake model responses and no inference; it isolates delivery timing rather than model behavior.

The team hit the 30-minute wall limit before the parent completed result collection. It used 382,716 input, 5,381,632 cached-input and 53,740 output tokens. Its saved output passes its own 130 tests, typecheck, style check and build, plus both original process checks and both supplemental process checks. It passes one of four adapter diagnostics. The stale-session diagnostic catches a success notification from an obsolete attempt. The pairing test fails with a session-branch fixture while this implementation reads cached context messages; that mismatch needs a separate integration check. The suppression diagnostic stops at an event-schema assertion, so its failure alone does not prove a suppression defect.

| Check | Solo | Ordinary workers |
|---|---|---|
| Parent workflow finished | Yes | No; wall limit |
| Own tests, types, style, build | Passed | Passed |
| Continuation and cancellation | 2/2 | 2/2 |
| Supplemental repeated-process checks | 2/2 | 2/2 |
| Adapter diagnostics, with limits above | 0/4 | 1/4 |

Both outputs improve the broken baseline's main continuation behavior. Neither meets the complete lifecycle contract. The results do not establish a communication benefit: neither setup run enabled the new channels. All trial processes stopped and both copied credential homes were removed. The [sanitized evaluation](compaction-calibration-evaluation.json) preserves limits, usage, checks and cleanup receipts.

## Grader coverage

The original process grader remains unchanged. The [supplemental fixture](compaction-repeat-preflight.json) extends it to two compactions and was tested against the known broken and fixed binaries. The broken binary fails continuation and passes cancellation; the reference passes both. It was added during calibration and is reported separately. A further historical-tool-call diagnostic was selected after source review and is also supplemental.

The first repeated-compaction fixture misidentified updated summary requests and consumed a task response as a summary. Its failed attempts are retained. Matching the summarization system instruction corrected that routing; the reference then passed. This was a test-fixture failure, not evidence against the reference.

Artifacts remain at `/private/tmp/kimchi-compaction-arms-w4mh1_g1`; supplemental preflight artifacts are at `/private/tmp/kimchi-compaction-repeat-j7_asm8x`. A completed four-arm quality comparison remains outstanding. These runs show why completion budgets, individual worker budgets and result collection need separate accounting before communication can be credited with a quality or time benefit.
