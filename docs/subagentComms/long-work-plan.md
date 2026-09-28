# Keep coordination findings available when work resumes

A parent resuming a saved Kimchi session now recovers the board's findings and latest progress, then uses them to continue the task. Before this change the board existed only in memory. Restarting the host lost that view even though TODOs, tool results and Ferment objectives already used the session journal.

The [research review](coordination-policy-research.md) favors verifiable delegated work and recovery through existing mechanisms. Our [repair comparisons](evidence-review.md) did not establish a general code-quality gain from more communication. This plan therefore improves a demonstrated loss of task context and tests its effect on continuation. It does not add agents, mandatory posting or another coordinator.

## Changes

1. Save accepted board entries in the owning parent's existing Pi session journal. Keep original IDs, authors, timestamps and TODO snapshot keys. Body-free events remain suitable for UI and telemetry.
2. Recover the current branch's retained board entries when that same session resumes or reloads. Apply the existing retention bounds and snapshot replacement. Ignore malformed records and records from another root; a fork does not acquire the original session's communication authority.
3. Let the owning parent read the recovered board through the existing tool and digest. Explain that a saved finding is a claim and its author may no longer be running. Recovery does not recreate worker records, message threads, permissions or accepted TODO evidence. The parent checks the artifact and passes relevant context to a resumed or replacement worker through ordinary delegation.
4. Verify the complete path: a worker records a changed contract and progress, the host stops, the parent resumes, reads the retained finding and continues against the changed contract. Exercise a stale decision, a replaced progress snapshot, disabled communication, another session and an abandoned branch. Compare saved state before and after the change with the same input.
5. Shorten parent and worker prompts while preserving routing, evidence checks and recovery instructions. Run focused regressions, lint/typechecking, a built TUI scenario and an isolated TMUX stop/resume check. Record exact results and limits here; retain the implementation only if continuation preserves the intended state and existing authorization still holds.

## Things to reuse

| Existing component | Role |
|---|---|
| Pi custom session entries and branch traversal | Store and recover board data alongside existing session state. |
| `BoardStore` | Keep the same bounded entries, IDs, cursors, deduplication and latest TODO snapshots. |
| Parent board digest and `read_agent_board` | Expose recovered findings without adding a new tool or user workflow. |
| TODOs, artifacts and Ferment evidence | Keep task acceptance and durable checked results separate from worker claims. |
| Bundled TMUX controller and isolated harness fixtures | Exercise real process shutdown and resumption. |

Pinned Pi 0.84.1 already exports `appendEntry`, `getBranch`, `session_start` and `session_tree`. The [package catalog](https://pi.dev/packages) includes other subagent, memory and cross-harness communication packages; replacing Kimchi's runtime is unnecessary for this storage seam. The upstream [session-first subagent RFC](https://github.com/earendil-works/pi/issues/552) reinforces using native session storage, without supplying Kimchi's board authorization. The implementation layer is an extension over those existing APIs, with no upstream patch or dependency.

## What would count as improvement

The same saved session retains the latest contract finding and progress after restart, and the parent can retrieve the original evidence reference without rerunning its discovery. A discarded branch or another session cannot inject findings into that view. Saved authors remain historical identities rather than live contacts. The final continuation must use the revised contract and pass an independent check.

This establishes recovery value. It does not establish a general coding-quality, performance or cost advantage over ordinary subagents. Those claims still need matched task comparisons; another repetition of the short repair tasks would not answer the continuity question.

## Results

Implemented and checked on 2026-09-21. The [evaluation record](long-work-evaluation.json) retains source and binary hashes, session IDs, worker outcomes, isolation checks and exact receipts.

| Check | Result |
|---|---|
| Same checkpoint, old build | `read_agent_board` returned `unknown_group`, with no available groups. |
| Same checkpoint, new build | Recovered both findings and both latest TODO snapshots, preserving all four original payloads and IDs. Four superseded progress records stayed out of the view. |
| Continuation | The resumed parent checked the contract and passed the saved findings to a replacement worker. That worker completed with Ferment verdict `met`; parent and external sandboxed verification both passed. |
| Prompt cleanup | Four parent/worker prompt blocks went from 1,589 to 730 words (54% shorter). Routing, failed-delivery exits, evidence checks and authority limits remain. |
| Regression checks | All 599 agent tests, four experiment-protocol tests and four built TUI scenarios passed. Lint/typechecking and binary build passed; lint retains one unrelated unused-import warning. |

The two initial investigators produced useful findings and completed their TODOs, but their host attempts aborted at token and turn limits while Ferment continued checking final answers. Both objectives paused. The replacement worker completed. These outcomes are recorded separately from board recovery: a completed progress snapshot does not prove the worker attempt succeeded.

Parent and workers used K3; evaluator sessions used K3 and K2.7. This was a short, isolated lifecycle check with a revised-contract fixture. The baseline still had ordinary conversation text and shared files, so the result proves board recovery, not that communication was necessary to fix the code or that final quality improved. The owned TMUX session and its processes were stopped, and copied credentials removed.
