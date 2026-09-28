# Changing a shared agreement

All nine calibration runs passed the same 18 independent checks. This experiment found no final correctness gain from messages or the board. It also exposed a limitation in the task: every worker was explicitly told to reread a small, authoritative evidence file. That made independent recovery cheap.

Two real workers extended an event encoder and decoder, starting with a shared seconds-on-the-wire convention. After the first observed component edit, the host published one evidence revision. It either changed the endpoint to milliseconds, confirmed seconds, or confirmed seconds alongside a mistaken advisory claiming milliseconds. Each channel condition retained the same source access, instructions, parent coordination and repair route. Only channel availability differed.

| Evidence case | Shared files + parent | Direct messages | Messages + board |
|---|---:|---:|---:|
| Changed contract | 18/18; 124.7 s | 18/18; 206.6 s | 18/18; 144.1 s |
| Unchanged contract | 18/18; 112.8 s | 18/18; 116.0 s | 18/18; 89.6 s |
| Mistaken advisory | 18/18; 149.3 s | 18/18; 152.5 s | 18/18; 106.0 s |

Times include the parent, workers, checks and final reports after task submission, plus five seconds of completion observation. There is one run per cell, with three arms running concurrently for each case. These times do not establish a reliable speed difference.

In the changed-contract case, both components first passed all independent checks about **12.6 seconds after publication with shared files**, **22.6 seconds with messages**, and **23.2 seconds with the board**. Source captures were sampled every 300 ms. All three runs first implemented the old convention and then revised both components, so the contract change did reach unfinished work.

The communication traces explain why the successful outcomes do not establish added value:

- The messages run had five send/reply attempts. Two failed schema validation, one reached an unavailable peer route, and a question and answer were accepted through the parent. Both components were already correct at 74.7 seconds; the question was queued for the parent at 101.7 seconds. Its answer appeared in the completed producer's session at 191.4 seconds and triggered two more assistant turns, using 499 output tokens without another source edit. The receipt reported `resume_attempt_completed`.
- The changed-contract board run returned six peer-entry bodies, including repeated reads. Five were TODO/work snapshots. The peer finding was read at 90.6 seconds, after both components were correct at 83.0 seconds. The consumer had read the authoritative revision directly at 64.4 seconds before correcting its code.
- Neither messages-only control case sent a message. The unchanged board run consumed no board bodies; the mistaken-advisory board run consumed one peer body. All final components followed the authoritative contract. The advisory was host-authored, so this does not test resistance to a persuasive false claim from another agent.

Across the three cases, recorded output tokens were 29,864 for shared files, 38,307 for messages and 24,928 for the board. Corresponding input tokens were 150,505, 198,068 and 159,373; cache reads were 1,020,928, 1,296,640 and 1,208,192. These include every parent and worker turn, rejected calls and the resumed worker. The board's lower output total does not establish a communication benefit: its only peer finding in the changed case arrived after the correction, and its unchanged case consumed no board bodies.

Passing these checks does not establish better style, performance or cohesion. In the mistaken-advisory board run, the producer worker also implemented `decode` and `decode_many` inside `producer.py`, duplicating the consumer's responsibility. This appeared in its first write, before evidence publication; the trace does not attribute it to communication. A separate load/replay of saved test modules found that the changed-contract shared-files run retained a producer test requiring unavailable `pytest`. Its public check and all 18 independent checks passed, but that saved test file could not load. Inline checks and `__main__` blocks were outside this supplemental replay's scope.

The experiment used a fresh isolated build from `9c06bed74a3a3ca9873b62433f09fb1e9672bcfb`, the bundled TMUX controller, separate credential homes and macOS filesystem sandboxes. The reused delivery probe command remained registered but was never invoked; ordinary parent and worker sessions performed all inference. Every session used `kimchi-dev/glm-5.3-flash`, low reasoning and Ferment disabled. Actual request tool lists matched their channel conditions, usage matched saved sessions, protected files remained intact, and all nine sessions stopped with copied credential homes removed. Both workers completed in every run. All parents initially used nonexact worker descriptions and corrected the rejected launches; those costs remain included.

The fixture self-check distinguished the 12/18 baseline from 18/18 reference implementations and rejected wrong-unit and invalid-syntax outputs. Four existing TypeScript checks and 21 Python trace/lifecycle checks passed. This is a small protocol calibration, not a repeated comparison on long coding tasks. It shows that the mechanism can handle a changed assumption, while the task's mandatory reread makes it weak evidence about communication value. A stronger workload would measure the cost of rediscovering a fact held by another owner, while keeping the underlying source accessible in every arm.

Reproduction commands are in the [script README](../../scripts/agent-communication/README.md#changing-a-shared-agreement). [Sanitized results](agreement-evaluation.json) retain scores, timings, usage, source hashes, communication counts and supplemental test failures. Local captures, frozen inputs and complete traces are at `/private/tmp/kimchi-delivery-wh05iqv4`. No production behavior changed for this experiment.
