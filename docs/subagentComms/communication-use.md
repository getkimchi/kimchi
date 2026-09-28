# Getting workers to use communication

Both the board and directed messages were used in two isolated coding runs with an explicit cross-review assignment. Stronger general guidance alone produced board activity but no directed messages in four earlier runs. The [results](communication-use-evaluation.json) retain all six attempts.

This verifies communication during a requested workflow. It does not establish automatic compliance or better code than ordinary workers. Both explicit runs passed the 53 public tests, types, formatting and refresh check; one still failed the separate timeout-cleanup check.

## What changed

The existing parent prompt now asks for a coordination section in group assignments: peer roles, the dependency, what to publish, who to contact and what to read before dependent work. The worker prompt asks for initial contacts and board discovery, notification of affected peers during execution, and a final check of relevant findings. Independent tasks can use ordinary workers. No new controller or message-count requirement was added.

The first two runs exposed a loop-guard defect: its raw bash counter used only the first 50 characters, so different commands behind the same long `cd` prefix looked identical. Three workers were stopped. Keeping the full raw command removed all three warnings when replaying those exact tool records. The separate normalized-command detector remains in place. A regression fails before the fix and passes after it.

The second pair used that fix and more explicit notification wording. Neither sent a message. The final pair kept that runtime, source, model, roles and budgets, adding a [cross-review brief](../../scripts/agent-communication/communication-brief.md) to the task: publish the connection plan, ask the boundary and lifecycle owners to review it, inspect their replies, then share and check the result.

## Observed use

Each row is one built Kimchi session run through TMUX, with three native workers. Peer reads count returned bodies of deliberate posts, including repeated reads; automatic TODO snapshots are excluded.

| Assignment | Manual posts | Peer body returns | Accepted messages | Questions answered | Worker outcomes |
| --- | ---: | ---: | ---: | ---: | --- |
| Initial guidance 1 | 2 | 2 | 0 | 0 | Three false loop stops |
| Initial guidance 2 | 3 | 3 | 0 | 0 | Three completed |
| Directed guidance 1 | 2 | 2 | 0 | 0 | Two completed; one token limit |
| Directed guidance 2 | 3 | 3 | 0 | 0 | Three completed |
| Explicit review 1 | 3 | 8 | 5 | 2/2 | One completed; one turn limit; one token limit |
| Explicit review 2 | 2 | 5 | 4 | 2/2 | One completed; two token limits |

Both explicit runs published the implementation proposal before editing. Both reviewing owners read its body and sent answers to the actual question IDs. All nine accepted messages appear in recipient histories with subsequent assistant actions. The implementation owners received the replies before further source checks or edits.

In explicit review 1, proposal `bd-37b5db90` asked about error mapping, deadlines and token refresh. The lifecycle answer to question `5cde5df5-ff6b-4d5b-a923-018532099374` was delivered at line 32 of worker session `01a0c487-04d4-750a-b559-a6c81d400b24`. The next assistant turn began restructuring transport construction to share an OAuth provider; successful edits follow at lines 33–46. This establishes an exchange followed by a relevant change. No separate test establishes that this restructuring improved behavior, and the final output still failed the late-fallback check.

In explicit review 2, proposal `bd-7788d3db` reached both reviewers. The lifecycle reply was followed by inspection of the SDK's connection cleanup; the boundary reply was followed by a read of the peer's board finding. The source, question/reply IDs, body hashes and recipient action locations are retained in the results.

The requested review was incomplete in both runs: neither implementation owner posted the final decision and test evidence, and neither parent read board bodies. Four workers reached their budgets. There were also three malformed message calls, two rejected replies and two oversized board posts. Both oversized posts and the malformed calls were corrected; the rejected extra replies sent nothing. Host receipts therefore remain separate from completion of the assigned review.

## Output quality

All six parents finished, and independent grading passed 53/53 public tests, typecheck, scoped formatting and the separate refresh check for every output. The late-failure cleanup check passed initial guidance 2 and explicit review 2; it failed the other four. The historical reference passes both supplemental checks.

Explicit review 1 added nine passing tests and kept the protected files unchanged. Explicit review 2 changed a protected existing test; grading restored that input before running the frozen suite. Both initial-guidance outputs also changed a protected production type file. Grading preserved those production edits and reported the scope violations.

The final explicit pair used 5,298,032 and 3,997,837 recorded input tokens including cache, plus 47,332 and 43,366 output tokens. Elapsed times were 618.9 and 527.9 seconds. There is no matched ordinary-worker run with this changed task brief, so these counts establish neither an efficiency gain nor its cost relative to normal mode. Readability and generated-code performance were not measured. Earlier normal/communication results remain in the [OAuth comparison](oauth-comparison.md).

## Verification and reproduction

The candidate passed 675 focused tests across 36 files, repository checks, the binary build and three built TUI communication workflows. Repository checks retain one unrelated unused-import warning. The corrected runtime produced no loop-guard warnings in the last four coding runs.

Every pair passed 20 isolation checks and the broken/reference preflight of 47/53 versus 53/53. Actual provider requests confirm the group guidance and tools reached all workers. Model routing stayed `kimchi-dev/glm-5.3-flash`, low thinking, with worker Ferment disabled. Each parent had 1,200 seconds, 80,000 output tokens and 12,000,000 total recorded tokens including cache; worker limits were unchanged. All six owned TMUX sessions stopped and their credential homes were removed.

Captures: `kimchi-compaction-arms-e5n4lnmu`, `kimchi-compaction-arms-lcm738kb` and `kimchi-compaction-arms-u_9oz9az` under `/private/tmp`. Frozen source, runtime and model-visible inputs were checked. The final capture also records a documentation-only change to the workspace runner README; its frozen copy still matches the original seal. The retained [brief and runner instructions](../../scripts/agent-communication/README.md#explicit-communication-workflow) reproduce the explicit assignment without changing the runtime.
