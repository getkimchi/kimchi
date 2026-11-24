# Ferment V2 runtime guide

Ferment V2 is an experimental, session-branch-scoped objective controller. It keeps one objective active across turns and uses the ordinary Todo tools for tactical work. It does not create Ferment V1 phases, workers, or worktrees.

Enable `extensions.ferment-v2` under `/resources` → **Experimental**, then restart Kimchi. It is disabled by default. The extension does not activate in an agent-worker process, and a run requires every Ferment V2 and Todo tool to be available.

## Journal state

V2 persists through the native session journal using custom type `kimchi_ferment_v2_state`. The schema-v1 entries are:

- `put`: a complete `fermentV2` snapshot.
- `clear`: a tombstone containing the current ID and revision.

Create, edit, status changes, accounting, evaluations, and guard counters append `put` entries. Clear appends a matching tombstone. Replay ignores malformed entries and only applies a clear when its ID and revision match the current state.

The persisted state includes:

- `id`, `revision`, `objective`, and `status` (`active`, `paused`, `blocked`, `budget_limited`, or `complete`);
- optional blocked reason, self-reported completion confidence, and last evaluation;
- optional baseline snapshot (`baseline: { commit, capturedAt }` — see below), preserved across objective edits;
- consecutive-error and unchanged-continuation counters;
- assistant token usage, optional token budget, active time, and timestamps.

Objectives are trimmed. Mutations are fenced by both ID and revision, so a stale turn cannot update an edited or replaced objective.

## Commands

| Command | Behavior |
| --- | --- |
| `/ferment-v2 <objective>` | Create an active revision 1 and queue a hidden start steer. An unfinished replacement asks for interactive confirmation; headless replacement is rejected. A completed run can be replaced directly. |
| `/ferment-v2 --tokens 50k <objective>` | Set a positive per-run token budget. `--tokens` overrides `fermentV2.defaultTokenBudget`. |
| `/ferment-v2` | Show status, blocked reason, revision, objective, active time, evaluations, latest verdict/reason, and currently valid commands. |
| `/ferment-v2 edit [objective]` | Immediately checkpoint active time, increment the revision, reset error/stall counters, abort an evaluator, and queue a steer to the new objective. The current agent operation may finish and its usage is accounted, but old-revision prose stays hidden and a not-yet-started Todo write is blocked. A retained Todo list must be reconciled for the new revision. |
| `/ferment-v2 pause` | Persist `paused` and stop automatic continuation after active agent work settles. |
| `/ferment-v2 resume` | Reactivate a paused or blocked run, reset guard counters, and queue a hidden start steer. If evaluation already accepted the run, retry only final-answer delivery. Exhausted budgets and completed runs cannot resume. |
| `/ferment-v2 clear` | Append a clear tombstone and remove the current run from the selected branch after active agent work settles. |

Management mutations are serialized per session. Edit commits the next revision immediately, aborts only a running evaluator, and queues its steer behind the operation already in flight. Revision fencing prevents the old turn from evaluating or mutating the new revision. Other state and Todo mutations wait for active agent work to settle; V2 then reads an updated Todo list before continuing. Read-only commands remain immediate.

Creating or explicitly resuming a V2 run from Plan mode switches the session to Auto so the run can use write tools. Entering Plan mode while V2 is active pauses the run; `/ferment-v2 resume` switches back to Auto and continues it.

Editing a paused run leaves it paused. Editing a completed run reopens it as paused; explicitly resume to start work. An edit replaces the objective, including any approved-plan instruction and title. Editing a blocked or budget-limited run preserves that stop condition; replacing a budget-limited run is required to get a new budget.

### Approved plans

With V2 enabled, approving a plan with **Execute** starts the same persistent controller and switches Plan to Auto. The initial objective keeps the exact approved Markdown; the saved plan is a reference copy, so changing or deleting that copy does not change the approved requirements. With V2 disabled, approval retains the legacy execution path.

The footer displays `◈ Plan execution: running · <name>` for approved plans and `◈ Ferment V2: running · <name>` for direct objectives. Each run gets a persisted name from the plan heading or objective, limited to six words and 36 display columns without another model request. Editing the objective refreshes its name; older sessions derive one on replay. `/ferment-v2` shows the approved plan's path without repeating the full Markdown. The footer changes to `verifying · <model> · <elapsed> · file edits may be reverted` while the executing verifier runs, and shows paused, blocked, complete, or budget-limited state. Narrow terminals shorten it to the state. There is no extra plan title or gradient in the prompt editor.

An explicit edit of a plan-derived run saves the full revised instructions to a fresh file under `.kimchi/plans` and stores only a read-file instruction. Reopening the editor loads that file. Verification resolves that instruction when it runs, so the file must stay available. Earlier files remain untouched. Reopening the editor still requires the edited file to be available. Ordinary manual objectives remain inline.

The existing optional Plannotator adapter feeds the same approval path, so browser approval and TUI **Execute** both start V2 when enabled. The adapter forwards plan-review requests to the external extension and maps its approved/rejected result back to the shared decision handler; rejection requests rework or passes feedback. Browser results must match the current review ID and source, and adapter subscriptions are cleared at session boundaries to reject stale approvals. The first decision from either surface wins. This does not install Plannotator: without the external extension, use the TUI review popup. The browser adapter is inactive in headless, oneshot and subagent sessions.

## Settings

Under the `fermentV2` key in `~/.config/kimchi/harness/settings.json`, the defaults are `autoResume: true`, `maxUnchangedContinuations: 3`, `maxConsecutiveErrors: 3`, `defaultTokenBudget: unset`, `evaluationTimeoutMs: unset`, `evaluatorModels: ["kimchi-dev/glm-5.3", "kimchi-dev/kimi-k3"]`, and `verifierThinking: "high"` (the verifier subagent's thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`).

`autoResume` affects only the interactive session-start kick; invalid or missing values fall back to these defaults. An explicit command-line `--tokens` value overrides `defaultTokenBudget`.

`evaluationTimeoutMs` is an optional wall-clock cap on the evaluator run. The default is **no overall cap**: the evaluator runs until it returns a verdict, with no turn or duration limit, because a thorough verification (build, tests, inspections) legitimately takes a long time. Set a positive value to bound each evaluation in milliseconds; a timed-out verifier run is **not** retried and pauses the ferment as `unavailable` with failure type `timeout`.

`evaluatorModels` is an ordered list of model refs used directly by the executing verifier; no model-role lookup is involved. A ref is usable when it resolves in the model registry and the registry can authenticate it. V2 picks the first usable entry that is not the implementer's session model (compared by canonical `provider/id`, so alias-shaped refs of the implementer are recognized); if every usable entry is the implementer, the first usable one; if none is usable, the session model. When the chosen model is the implementer's own — configured that way, or via the session fallback — the user gets a one-time warning per ferment naming the cause (only one model configured, every configured model being the implementer's own, no usable independent model because a configured ref did not resolve or authenticate, or, for the session fallback, no configured model available) and the fix, `/ferment-v2` marks the verifier model as "same as implementer", and the `ferment-v2:evaluated` event records `sameModelAsImplementer` and `modelFallback`.

## Runtime flow

```text
create / edit / resume
        │ append active snapshot + hidden steer
        ▼
turn_start → work and Todo writes → turn_end
                                      │
                        checkpoint time and assistant usage
                        budget reached? → budget_limited, stop
                                      ▼
                         agent_end captures conversation
                                      ▼
                         agent_settled gate
                                      │
                 explicit `update_ferment_v2 complete` claim?
             ┌──────────────┴──────────────┐
             ▼                             ▼
             no claim                     claim
       deterministic continuation     single executing Verifier
       (no model call): keep working,  (independent session; unlimited turns)
       or settle Todos and submit     ┌──────────────┼──────────────┬──────────────┐
       with update_ferment_v2        ▼              ▼              ▼              ▼
                                  continue          met       impossible      unavailable
                                hidden follow-up  + complete    blocked          paused
                                                  Todo → final answer → complete
                                                  delivery failure → paused
```

Verification is claim-driven: the evaluator runs only after the implementer explicitly claims completion with `update_ferment_v2 {status: "complete"}`. A stop without a matching claim never calls the evaluator — no evaluation record, `EVALUATED` event, or evaluation count is produced. Instead the host queues a deterministic continuation (no model call) telling the agent to keep working and, once every requirement is done and verified, to settle its Todos and submit with `update_ferment_v2`. Todo state never triggers verification; the visible Todo list only gates claims. A `continue` verdict reuses the same deterministic continuation path with the evaluator's remaining gap as the reason and consumes the claim, so the next verification needs a fresh explicit claim.

The core agent marks a run inactive before dispatching `agent_settled`. V2 therefore treats an in-flight evaluator as busy even though the core context reports idle.

At `turn_start`, V2 records the active session/ID/revision, starts active-time accounting, and captures a progress fingerprint. At `turn_end`, it accounts the assistant message and detects budget, abort, or error. `agent_end` stores the full conversation for the settled check. At `agent_settled`, V2 continues or evaluates only if the run is still active and the captured marker still matches.

## Prompt and Todo contract

V2 has no `before_agent_start` handler and does not mutate the system prompt. Its `context` handler removes stale V2 snapshots and inserts one hidden `kimchi_ferment_v2_context` message containing status, objective, token budget, and bounded durable lessons. The ordinary Todo extension injects current Todo state separately in the transient request context; neither injection becomes a permanent transcript message.

The active context tells the agent to:

- keep one visible tactical Todo list and leave it visible;
- add Todos when objective-required work is discovered;
- preserve settled Todos and their evidence when more work is found, extending the list or reopening the matching item;
- preserve compact `Decision:`, `Evidence:`, or `Dead-end:` notes for compaction;
- settle every Todo and map every objective requirement to current evidence before finishing; and
- communicate only task work, results, and blockers; give the concrete outcome and evidence when ready, otherwise state the next concrete need.

Todo writes use normal scope resolution. Omitted scope is auto-routed; agent workers use global scope. V2 accepts observations only from the currently resolved scope and binds them to the current session, V2 ID, and revision. A visible list is required for completion, and every item must be completed for the `complete` gate. An explicit `blocked` update is immediate.

Terminal Todo notes become at most five bounded durable lessons. Only lessons prefixed `Evidence:` are evaluator evidence; unprefixed completed notes are decisions, and blocked notes are dead ends.

`update_ferment_v2 complete` records the runtime-only completion claim and terminates the working turn; it is the only trigger for verification. Assistant prose is buffered while it streams and released at `message_end`: only the message carrying a completion claim stays hidden, so an unverified claim never reaches TUI, print, JSON, ACP, or the working journal; an in-memory copy of it is available only to the evaluator. Ordinary work output — including a text-only stop after settling the Todo list — remains visible and receives the deterministic continuation at the next checkpoint instead of an evaluation. Thinking and already-running tool activity are not suppressed. After an edit, however, prose from the assistant message that began under the old revision remains hidden, and a Todo write emitted by that stale message is blocked before execution. The claim is not proof and is consumed by the verdict it triggered: a `continue` verdict clears it, so the next verification needs a fresh explicit claim; a `met` verdict copies its self-reported confidence forward. A `met` verdict queues one final-answer turn and headless mode waits for it; tool calls are blocked and answer text is buffered during that turn, then released without outer whitespace after it settles. Interactive mode still requires a completed visible Todo list before delivery; headless mode has no visible Todo widget and may proceed directly from an evidenced `met` verdict. The run becomes `complete` and emits its completion event only after that turn delivers non-empty text without aborting or erroring; otherwise it becomes resumably `paused`. Restart and explicit resume recover an accepted-but-undelivered answer from the persisted `met` verdict and, in interactive mode, completed Todo state. If pause, edit, clear, or a Todo command mutation invalidates an already queued delivery, its hidden control message is removed from provider context; Todo mutation also clears the stale accepted evaluation before work resumes. `update_ferment_v2 blocked` persists immediately and records its reason.

## Settled evaluation — the executing verifier

Verification runs only on an explicit completion claim. A stop without a matching `update_ferment_v2 complete` claim never reaches the verifier: the host queues the deterministic continuation described above, produces no evaluation record or `EVALUATED` event, and leaves the evaluation count unchanged.

When the implementer claims completion, the host spawns a single **Verifier**: a hidden `Verifier` persona (`read`, `bash`, `grep`, `find`, `ls`, a confined `write` for its own probes, and the report tools `report_finding`, `retract_finding`, `resolve_finding`, `submit_verdict`; no edit, no extensions, no skills; thinking from `fermentV2.verifierThinking`) that runs in the real working tree with **no turn limit**. Its inactivity watchdog is model-only — time spent inside a running tool is never counted as inactivity, so a silent long build or test suite cannot stall-abort the verifier, while genuine model silence still steers and then aborts. The verifier session is persisted alongside the parent session and runs with `visibility: "system"` (hidden from the agent list on both surfaces). Verifier tool calls follow the main session's permission mode and rules, read live, like any other in-process subagent (see [subagent-permissions.md](subagent-permissions.md)): the evaluator passes its permission options with the inline factories, and the runner folds them into the subagent's single permission gate instead of loading a second one. Because the child cannot prompt, read-only commands are accepted while every other `bash` command goes through the classifier (fail closed). The report tools and the verifier's confined writes — a new file inside the repository, or any file inside the baseline worktree — are pre-approved (permission source `preapproved`, after deny rules and the plan gate).

The verifier model is resolved from `fermentV2.evaluatorModels` as described under Settings — the first usable configured model that is not the implementer's session model, with the session model as the fallback when none is usable. If no model is available at all, the run becomes `unavailable` with failure type `no_model`. The task prompt puts the objective first ("the only authority"), then host-gathered git facts (against the ferment baseline when one exists — see below — and against HEAD otherwise), then the open findings of earlier reviews, the implementer's Todos, the proposed final answer, and the previous gap. When PII redaction is enabled the prompt is redacted first; a redaction failure makes the run `unavailable` instead of sending raw input. The persona disables extensions, so redaction also rides along as an inline factory inside the child session — registered before the guard, so the tool results the guard stamps are already redacted — keeping file reads, shell output, and the persisted verifier transcript scrubbed just like the prompt.

The persona frames the review as breaking the delivery within the boundaries the objective sets. Before executing anything it plans its attacks: for each requirement, the inputs and failure modes most likely to break it and the code paths that look weakest. A `<defects>` section defines what counts as a finding — a requirement missing, partly implemented, or wrong for some input within the objective's scope; missing or wrong required error behavior; a requirement that works only through a helper, not the required entry point; a regression of behavior the objective does not ask to change; a deviation from a delegated specification — and what does not: style, naming, structure, or performance unless required, inputs outside the objective, details it leaves open, and hardening, tests, or docs it does not ask for. When the attacks are exhausted without such a failure, the verdict is `met`.

The verifier's task tells it to spend its effort on objective clauses and behavior the delivery's own tests exercise thinly or not at all, looking for wrong or missing behavior a user would hit rather than missing tests or polish. On a re-review it also says that fixed findings are not evidence the rest of the objective is met, and points the review at what earlier reviews likely did not reach; the re-check of each open finding is unchanged.

### Baseline, facts, and the baseline worktree

When a ferment is created or replaced (approved-plan starts included), the host captures a **baseline**: a snapshot commit of the working tree including untracked, non-ignored files, taken through a temporary index — `git status`, the real index, refs, and HEAD stay byte-identical. The baseline is stored on the ferment state (`baseline: { commit, capturedAt }`), round-trips through the journal, and survives objective edits. Outside a git repository — or when the snapshot fails (snapshot git commands are capped at 60s, other git commands at 15s) — the ferment runs without one: no baseline facts, no flags, no baseline worktree, and the verifier's prompt says so explicitly; verification still runs.

Before every verifier run the host gathers **facts against the baseline** — or, through the same gatherer, against the before-run HEAD commit when the ferment has no baseline (the prompt names the basis it is seeing and that pre-objective uncommitted changes are then included): changed files (added, modified, deleted, renamed — untracked-at-start files included, since both snapshots carry them), a diff stat, git state (branch, HEAD, commits since baseline, uncommitted file count — each untracked file counted individually via `--untracked-files=all`, so a fresh directory is not collapsed to one record and a repository's `status.showUntrackedFiles=no` cannot hide them), and **test-inventory flags**, each with a host-assigned `f1, f2, …` ID. All comparisons run from the repository root with root-relative paths, so a session opened inside a subdirectory sees the same facts. The marker scan forces textual, untransformed, uncolored diffs (`--text --no-color --no-ext-diff --no-textconv`, with literal pathspecs), so repository diff configuration cannot conceal a marker — a `.gitattributes` `-diff` line, an external diff driver, or a textconv filter would otherwise turn the scan into a binary difference, and a `color.ui=always` would prefix every added line with ANSI escapes the scan cannot read — and it reaches paths containing (or starting with) a colon, both in the pathspec scan and in the rename scan's `<commit>:<path>` blob comparison. The flag inventory is complete — every changed test file and Rust source is scanned and no flag is dropped — because host validation checks `met` verdicts against it; only the changed-file list and diff stat are capped for prompt size (marked as truncated). When git fails mid-collection — the baseline test-file enumeration or a marker diff — the facts are instead marked `testInventoryIncomplete` and the prompt says so, so the flag list is never mistaken for a complete one. When the before-run snapshot or the whole comparison fails (a git error, or a garbage-collected baseline commit), the prompt reports the facts as unavailable — there is no flag list on that path — and tells the verifier to inspect the changes with read-only git commands itself.

- `test_file_deleted` / `test_file_renamed` / `test_file_modified` — a pre-existing test file (matched against `__tests__/`, `tests?/`, `spec/`, `*.test|spec.[cm]?[jt]sx?`, `*_test.go|py`, `test_*.py`, `*_spec.rb`, `*Tests?.(java|kt|cs)`) removed, moved, or changed;
- `skip_marker_added` — an added line matching a skip/only marker: `(it|test|describe).(skip|only|todo)(`, `(it|test).fail(`, `xit(`/`xtest(`/`xdescribe(`, `@pytest.mark.(skip|xfail)`, `t.Skip`, `#[ignore]` (with or without a reason string), `@Disabled`/`@Ignore` — in changed test files, in Rust sources (the canonical `#[cfg(test)] mod tests` layout keeps tests inline in production `src/*.rs` files that no path heuristic identifies, so every changed `.rs` file is scanned), and in rename destinations, where the marker scan compares the destination against its baseline source so a rename cannot conceal an added marker — a rename is scanned when either side is scan-eligible, so moving a test file out of every path heuristic (e.g. `tests/a.ts` to `cases/a.ts`) cannot hide one either;

Deleting, renaming, or skipping pre-existing tests is the classic way to make a suite green without making it pass, so the flags are rendered as facts in the verifier's prompt, which asks it to run the original version of modified, deleted, or renamed tests (available in the baseline worktree) against current code. The host does not require a check per flag: a failing original test that should block completion is a finding. An incomplete or unavailable inventory is reported in the prompt so the verifier inspects the changed test files itself.

The host also reserves a lazy, disposable **baseline worktree** for source inspection and optional comparisons. It is checked out on first reference and disposed on verdict, error, or cancellation; existing abandoned-worktree cleanup is unchanged. Execution there is **not isolated**: shared `node_modules` links, editable installs, and generated artifacts may resolve candidate code. A baseline cwd alone is not proof that old production code ran. The prompt makes this limitation explicit; no dependency reconstruction or additional install is performed.

### Reporting and evidence rules

Every verification tool result is stamped by the host with a sequential evidence ID such as `[e12]` (report tool results are metadata and are not stamped). The verifier reports through host-bound tools, not a final JSON object, so a malformed report is rejected while the session still has its context:

- `report_finding({clause, evidence, observed, expected, why})` records an objective violation as soon as it is observed. `evidence` must name `[eN]` IDs stamped in this review (`e25` and `[e25]` are accepted). Findings are kept even if the session later fails.
- `retract_finding({id, reason})` withdraws a new, non-carried finding whose expectation proved wrong; it stays in the record with the reason. Findings carried from an earlier review after `still_failing` or `dispute_rejected` cannot be retracted; they stay open and continue to block `met`.
- `submit_verdict({verdict, summary, finalAnswer?})` ends the review: the session terminates once the submission is accepted. `met` is refused while any finding is active; `continue` and `impossible` need at least one active finding (an `impossible` blocker is recorded as a finding with evidence).

The report tools run sequentially, so a finding batched with `submit_verdict` is recorded before the verdict is checked. There are no rules on passing checks: no per-pass evidence, failure modes, categories, methods, or per-flag coverage. What blocks completion is an active finding with executed evidence that names a violated objective clause.

**Final-answer checks** keep the literal host comparison. `finalAnswer` lists exact-output requirements — only when the objective prescribes the text of the implementer's final reply (`{clause, expected}`, with `expected: null` for a format-only constraint). On `met`, a missing proposed answer or a mismatch with a string `expected` turns the verdict into a host `continue` naming the requirement; a match makes the proposed answer the evaluated draft delivered verbatim, so callers orchestrating a ferment get a predictable final output.

The task-facing reason for `continue` is built from the active findings: `<clause>: expected <expected>; observed <observed>.` (numbered when there are several), followed by the summary. Transcript-only judgment is gone: there is no transcript digest and no `completeSimple` call.

**Getting a submission.** Finishing the review matters more than strict limits:

| Cause | Handling |
| --- | --- |
| The session ended without calling `submit_verdict` | Resume it with "call `submit_verdict` now", at most twice (`correctionCount`) |
| The optional `evaluationTimeoutMs` cap is reached | One grace turn asking only for submission based on what was verified, with its own 120-second deadline; the result records `submittedAfterLimit` |
| Transport or provider error | Retried as below; a fresh session carries the interrupted attempt's active findings, which must be confirmed. Only non-carried findings may be retracted when their expectation proves wrong |
| User cancellation | Immediate, with no resume or grace turn |
| Still no submission | Recorded findings yield `continue` (`incompleteReview`); no findings is `unavailable` with failure type `incomplete_review` (or `timeout`), never implementation work. Earlier open findings without a resolution stay open with their previous `observedTree`, because omission is not a re-check |

### Meaningful verification guidance

The verifier persona carries concise operational guidance targeting observed false-completion shapes, without additional reviewers or human gates:

- **Sourced expectations** — establish the input, expected result, and its source before executing a behavioral check; the candidate's output never establishes an expectation. Exercise the required public entry point; a helper check alone does not prove integration.
- **Distinguishing inputs** — choose boundaries, negative cases, interacting combinations of conditions, and every distinct way a dependency can fail (a returned error value, a synchronous throw, a rejected promise, a failure partway through iteration). Where an output space is small, check a property over generated inputs rather than a few hand-picked examples.
- **Meaningful execution** — confirm the intended test was discovered, completed, and reached an assertion: zero selected tests, skipped tests, unawaited async work, or a swallowed assertion establish nothing. Mocks may isolate external dependencies, never the behavior under evaluation; implementer-authored or modified tests are not independent evidence.
- **Preserved observations** — record the observed mismatch; retract a finding only when its expectation is shown wrong, never because the candidate disagrees. Passing checks elsewhere never cancel an observed violation.
- **Regressions** — a failing original assertion is presumed a regression unless it also fails on the baseline or a quoted objective requirement necessarily contradicts it and the replacement behavior was executed.

### Review findings across iterations

Findings keep their IDs (`F1`, `F2`, …) until a later review closes them. A finding never closes just because a later review didn't look at it again.

- **Settle.** When a review settles with `continue` or `impossible`, its active findings become the ferment's `openFindings`. `met` clears them, and an objective edit discards them.
- **Implementer.** The task-facing reason names each finding by ID, and the context block lists the open ones. The implementer answers each with `respond_to_ferment_v2_finding`:
  - `fixed`, with the change and the check that now passes;
  - `disputed`, with the objective text, repository contract, or specification that shows the expectation is wrong or out of scope.
- **Next review.** It receives every open finding with its response and must settle each one with `resolve_finding` before `submit_verdict` is accepted:
  - `fixed` or `still_failing`, each with the `[eN]` evidence of a re-run;
  - for a disputed finding, `dispute_accepted` or `dispute_rejected`.

  - **Accepting a dispute** requires an exact quote and its source: `objective`, `repository` (with the file path), or `specification`. The host checks that an objective quote appears in the objective text and a repository quote in the named file, ignoring whitespace and case. A repository quote must come from a test, documentation, or a schema or specification file: production code shows what the code does, not what it must do, so it cannot settle a dispute. A specification quote is external, so it is recorded as given.
  - **Rejecting a dispute:** disputes that rest on feasibility (what the code, engine, or library can do), on the objective's silence when the expectation follows from a clause's plain reading, on the delivered behavior, or on the implementer's word are rejected. So is a dispute whose quote supports the finding.
  - The accepted quote is kept with the resolution.
- **Still open.** A finding that is still failing, or whose dispute was rejected, stays active under its ID, and blocks `met` like any finding. Its rejected disputes are counted (`disputesRejected`). There is no user escalation: a contested finding simply stays open, and the existing continuation limits apply.
- **Incomplete reviews.** An earlier open finding absent from the review's resolutions is not closed by omission. It remains open even when the review produced other active findings but no verdict, and its previous `observedTree` is preserved.
- **No fix without a change.** Each open finding remembers the working-tree snapshot it was last observed failing on (`observedTree`), and `fixed` is refused while the tree is unchanged.
- **Numbering.** New findings continue the numbering.


A `fixed` resolution must rest on a re-check of the finding itself. At least one cited result must be an executed check (`bash` or `bash_control`). The resolution also quotes the finding's failing input as `reproduction`, and the host requires that text to appear in a cited command, its output, or a probe file the verifier wrote or edited. Reading the code, or re-running unrelated probes, does not close a finding.
### Integrity guard

The verifier executes in the real working tree, so the host enforces workspace integrity around every run:

- **Before the run**: the host probes the workspace's git state and snapshots the working tree through a temporary index (`git add -A` against a copy of the real index, then `write-tree`/`commit-tree`). The real index, tree, and refs are never touched. A confirmed non-git workspace runs without snapshot-based integrity. When git cannot answer or the snapshot fails (snapshot git commands are capped at 60s), the verifier still runs, with integrity unenforced: its prompt tells it not to write to the working tree, the result carries `integrity.unenforced`, and the user is notified once per ferment that verifier file changes will not be reverted — so a large or unusual repository never makes completion impossible. An unresolvable HEAD only disables HEAD-move detection. Untracked nested repositories without a checked-out HEAD are excluded from the parent snapshot because Git cannot index them; their internal files have their own Git boundary and are outside the parent snapshot's protection.
- **During the run**: a child-session guard extension stamps every tool result with its `[eN]` ID and accumulates the session's usage (including cost) as assistant messages complete and as context compactions run, so later compaction — which rewrites the session's messages — cannot erase already-consumed tokens, and the compaction's own summarization completion is counted too (it produces no assistant message). It also confines `write`/`edit`: anything inside the disposable baseline worktree, and only *new* files inside the repository (probes, baseline copies of flagged tests) — an existing repository file, a path outside both roots, or any `.git` metadata path is blocked before it is touched. The verifier is told never to delete files; the post-run restore removes everything it added.
- **After the run** (including on abort): the host snapshots again, restores every modified or deleted pre-existing file from the before-run snapshot, removes every file the verifier added, and detects HEAD moves without git surgery — a different commit or symbolic ref, a branch switch or detachment even at the same commit, or a transition between a resolved and an unborn HEAD (for example `git checkout --orphan` or committing onto a fresh repository's unborn branch). The post-run snapshot SHA is kept as a recovery point. Host-recorded new ignored files created through the verifier's `write` tool are removed through the guard's `createdFiles` set as well. Changes to pre-existing ignored files, or other unrecorded bash side effects, are not covered by this cleanup.

On a violation the host keeps a `continue` verdict but discards a `met`: the ferment pauses as `unavailable` with failure type `guard_violation`, and the notification lists the restored files plus the post-run snapshot SHA. Restores go through `git restore --source` against the snapshot tree, so binary bytes, executable bits, and symlinks come back exactly as recorded, and snapshot paths are resolved against the repository root rather than the session cwd. Index entries flagged `skip-worktree` or `assume-unchanged` are honoured everywhere the snapshot looks at content: their bits are cleared in the temporary index copy before `git add -A` (only the copy — the user's real index keeps its flags, and the clearing runs from the repository root, not the session cwd, because `git ls-files` and `git update-index` otherwise see only the session subdirectory's subtree) so edits to those files are captured, and restores pass `--ignore-skip-worktree-bits` so git does not filter them out of pathspec matching. When enforcement itself fails (a restore cannot be written, the post-run snapshot cannot be established, or HEAD cannot be resolved after the run), a `met` verdict is likewise discarded with a recovery note; other verdicts stand without full enforcement. If only the after-run snapshot fails, the host uses the before-run tree to restore its known files and removes recorded new files on a best-effort basis instead of silently leaving those changes behind. Because the restore reverts everything the working tree gained or lost during the run, concurrent user edits can be reverted — the status line warns `file edits may be reverted` while the verifier runs. Outside a git repository snapshot-based integrity is unenforced; the verifier's write protection is its read-only tool set plus this restore-after-the-fact guard.

### Retries, failures, and accounting

Transient provider failures (rate limit, transport failures, stream interruptions, provider 5xx) are retried up to three times with backoff (≈5s/20s/60s) — both for the initial run (fresh verifier sessions, carrying active findings) and for a submission resume. A terminal provider error ends the child session's run without failing it (upstream's in-session auto-retry has already run and been exhausted or disabled), so the host inspects the session's last assistant message and translates its `stopReason: "error"` into a verifier error — only then does this retry policy engage. The backoff ends early when the run's signal aborts, and the combined signal is checked before every attempt, so a verifier timeout under the optional `evaluationTimeoutMs` cap — even one that fires during backoff — is never retried; it gets the grace turn described above when a session exists, and otherwise ends as `unavailable`/`timeout`. Caller cancellation pauses as `unavailable`/`cancelled` — integrity still runs before that verdict is returned.

Verifier usage — input, output, cache read/write, total tokens, and cost, accumulated per assistant message and per context compaction across the session including any submission resume and grace turn — counts toward the ferment's `tokensUsed` and `tokenBudget`. It is settled exactly once, as soon as the run settles and before any verdict-validity gate, so pausing, editing, or steering during verification cannot discard already-consumed verifier tokens. An in-flight verifier run always finishes before the budget catches up: when the accounting crosses the token budget, the ferment stops as `budget_limited` (the outcome is emitted immediately and no further work — final-answer delivery or continuation — is scheduled). `/ferment-v2` shows the separate verifier breakdown (runs, tokens, cost) alongside the implementer accounting.

While the verifier runs, the status line shows `◈ Ferment V2: verifying · <model> · <elapsed> · file edits may be reverted`, ticking every second until the verdict settles. Each verdict notifies the user with model, duration, and token count; a guard violation adds the restored-files list and recovery snapshot.

Verdicts have these effects:

- `continue`: persist the evaluation and queue one hidden `followUp` continuation while all gates still pass. A reason is included in the hidden checkpoint steer.
- `met`: in interactive mode, request the final answer only when the current revision has a non-empty visible Todo list whose items are all completed; headless mode may proceed without an invisible Todo list. Mark complete only after that answer is delivered successfully, otherwise pause.
- `impossible`: persist `blocked` with the evaluator reason.
- `unavailable`: persist the evaluation and pause. This covers no model, cancellation, a review that ended without submitting and without findings, and non-transient provider failures.

A completed review's findings apply in the same mutation that records its verdict (`continue`, `met`, or `impossible`); an `unavailable` review changes nothing.

## Gates and stop conditions

Evaluation and continuation require an active current revision, no pending user message or user mutation, all V2 and Todo tools, and a non-stale session context. A pending user message or mutation invalidates the verdict; a completed evaluator response remains accounted in its child session even when the verdict is discarded. Missing tools abandon evaluation and release a waiting headless command.

An aborted agent turn pauses immediately. Agent errors are counted once at the settled run boundary, not once per retry `turn_end`; three consecutive errors pause by default. Three stalled continuation checkpoints pause by default when the canonical fingerprint does not change and either no substantive active work ran or the same evaluator gap keeps repeating. A repeated evaluator gap (`repeatedGap`) applies only to evaluator verdicts; a host-generated continuation counts as unchanged only when the stop did no substantive tool work and the Todo/lesson fingerprint is unchanged since the previous checkpoint (the last continuation or evaluation decision) — not since the start of the last SDK turn, so Todo settlements and lesson updates from earlier turns of a multi-turn run still count as progress. Pending-only Todo additions and display-only reordering do not count as progress; starting or settling a Todo, revising its active fields, or adding durable lessons does. Substantive tool use normally resets the counter, but it cannot keep a run alive when both the objective fingerprint and evaluator gap remain unchanged.

Working-turn token usage is checkpointed at `turn_end`. If the run reaches its token budget, it becomes `budget_limited` and no evaluator or continuation is started for that turn. The already accepted final-answer delivery is excluded from this work budget; its usage remains in the normal session record. Active time is accumulated only while an active work turn is running; it is checkpointed on turn end and management mutations.

## Replay, restart, compaction, and headless runs

`session_start` and `session_tree` replay the selected session branch. Rewind and fork therefore select independent V2 histories. After compaction or branch navigation, V2 replays the latest state and Todo writes and rebuilds the context message. Durable Todo notes can remain available as lessons after terminal Todos leave the current list. Explicit `/ferment-v2 resume` restores the persisted guard counters only to reset them in its own commit; ordinary replay preserves them.

An active run schedules a deferred automatic resume only for an interactive UI session, after checking for busy state, pending messages, and unchanged ID/revision. If its last evaluation was `met` and its restored Todo list is complete, that kick delivers the final answer instead of resuming work. Headless `session_start` deliberately does not compete with the incoming prompt. Headless create, edit, and resume commands wait only when they successfully queue a turn; waiters resolve on terminal state, clear, replacement, or when a continuation cannot be queued (for example, tools are unavailable or synchronous context is stale).

Runtime-only state is rebuilt on replay; pending continuation, terminal-feedback, and queued/active final-answer markers are retained only when their same-session ID/revision still matches the replayed V2, and are otherwise discarded. Cross-session replay resets them, along with active/failed turn markers, completion claim, captured conversation, evaluator abort controller, active-time start, progress fingerprint, and in-memory Todo/lesson bindings. Accepted final-answer readiness is derived again from the persisted evaluation and Todo state. The journal persists the objective state, accounting, evaluations, and guard counters.

## Visibility, telemetry, and benchmark accounting

V2 control/context messages and the `get_ferment_v2`/`update_ferment_v2`/`respond_to_ferment_v2_finding` tools are hidden from normal tool rendering and bypass permission prompts. Evaluation details are not emitted as visible transcript text. The existing working indicator remains active while an interactive completion candidate is evaluated, and prompt-summary display waits for true session idle so it cannot become an accidental model steer during a slow evaluation. V2 uses the existing Ferment footer slot, including the controls row above a custom status-line script. `/ferment-v2` shows full status details.

The extension emits the full V2 observability contract as structured domain events: `ferment-v2:started`, `ferment-v2:replaced`, `ferment-v2:edited`, `ferment-v2:resumed`, `ferment-v2:completed`, `ferment-v2:blocked`, `ferment-v2:paused`, `ferment-v2:cleared`, `ferment-v2:budget_limited`, `ferment-v2:stalled`, `ferment-v2:agent_error`, and `ferment-v2:evaluated`. Replacement emits `replaced` for the outgoing ID with `replacementFermentV2Id`, then `started` for the incoming ID, so every V2 ID has one cohort start. `ferment-v2:evaluated` also carries `sameModelAsImplementer` (the verifier ran on the implementer's session model), `modelFallback` (the session model was used because no configured model was usable), `toolCalls` and `turns` (the verifier session's activity), and `restoredFiles`/`removedFiles` (the integrity guard's workspace recovery), so model-diversity regressions and guard violations are measurable on the evaluator bench. Built-in telemetry subscribes to all external V2 events and records only bounded IDs, version, revision, lifecycle state, lifecycle reason, replacement ID, token/time counters, evaluator verdict, evaluator model, timeout/correction/request counts, HTTP status, token buckets, and cost. It also consumes the internal `ferment-v2:context_changed` event to attach active V2 ID/version/revision/status to ambient session, error, and tool telemetry while the run is active. It never emits objectives, evaluator explanations, blocked free text, prompts, filenames, or raw provider errors. Evaluator unavailability and intentional cancellation both emit `ferment-v2:evaluated`; operational failure rates must exclude `failureType=cancelled`.

V2 runtime accounting describes the working assistant turns and excludes accepted final-answer delivery from its work budget. Verifier usage — tokens and cost, including submission resumes — is folded into the ferment's `tokensUsed` and `tokenBudget` after each run (an in-flight verifier run always finishes before a `budget_limited` outcome is applied) and tracked separately as a per-run breakdown shown by `/ferment-v2`. Both delivery and verifier usage remain in their normal session records. The Terminal-Bench adapter recursively scans every discovered `sessions/**/*.jsonl`, sums valid assistant entries, and includes cache read/write in the input total, so working, verifier, and other child sessions are counted once through the same path.

## Ferment V1 boundary

Ferment V1 remains the default-enabled, cross-session project mode. It persists JSON files under `.kimchi/ferments/`, tracks phases and steps, and owns workers, worktree metadata, and its own lifecycle runtime. See [docs/ferment.md](ferment.md) and [the V1 schema](ferment-storage-schema.md). Ferment V2 is a separate `extensions.ferment-v2` resource and does not migrate or replace V1 state.

## Implementation references

- [V2 extension](../src/extensions/ferment-v2/index.ts), [reducer](../src/extensions/ferment-v2/reducer.ts), [prompt](../src/extensions/ferment-v2/prompt.ts), [evaluator (verifier core)](../src/extensions/ferment-v2/evaluator.ts), [verifier report tools](../src/extensions/ferment-v2/verifier-report.ts), [verifier guard](../src/extensions/ferment-v2/verifier-guard.ts), [verifier prompt](../src/extensions/ferment-v2/verifier-prompt.ts), [workspace (baseline, facts, worktree)](../src/extensions/ferment-v2/workspace.ts), and [types](../src/extensions/ferment-v2/types.ts)
- [Verifier persona](../src/extensions/agents/personas/default-agents.ts) and [spawn helpers](../src/extensions/agents/index.ts)
- [V2 unit tests](../src/extensions/ferment-v2/index.test.ts), [evaluator tests](../src/extensions/ferment-v2/evaluator.test.ts), [guard tests](../src/extensions/ferment-v2/verifier-guard.test.ts), [workspace tests](../src/extensions/ferment-v2/workspace.test.ts), and [verifier prompt tests](../src/extensions/ferment-v2/verifier-prompt.test.ts)
- [V2 TUI flow](../tests/e2e/tui/ferment-v2-mode.test.ts), [ACP verifier coverage](../tests/e2e/acp/ferment-v2-verifier.test.ts), and [headless smoke coverage](../tests/smoke/ferment-v2-print-exit.test.ts)
