# When agent communication helps

Research checked on 2026-09-16. The papers and systems below support testing communication where workers discover different facts, explore different hypotheses or resolve a dependency during execution. They do not establish that adding a board improves every coding task.

Our latest four-run comparison changed worker-local Ferment while leaving communication available in both arms. It tests continuation and evaluation policy. Earlier communication and board comparisons are relevant to transport value, but their small repair tasks often let workers recover the same information from shared files. Those are useful controls; their negative results remain valid for those conditions. See the [local results](communication.md#observed-results).

## Papers closest to the problem

| Source | Mechanism and evidence | What transfers to Kimchi |
|---|---|---|
| [LLM-based Multi-Agent Blackboard System for Information Discovery in Data Science](https://arxiv.org/html/2510.01285v2), January 2026 revision | Agents handle separate data partitions and volunteer answers to requests. Table 1 reports Gemini 2.5 Pro macro scores of 28.53% versus 24.01% for direct coordinator assignment. The cost study reports about 1.8 times the coordinator-worker cost, with similar latency. Replies are separated to prevent helpers influencing each other. | Test discovery across a large codebase or several repositories. This is evidence for routing distributed knowledge, with extra compute; it does not isolate an append-only progress board. |
| [iAgents: Autonomous Agents for Collaborative Task under Information Asymmetry](https://arxiv.org/html/2406.14928v1), June 2024 | Agents have different information. InfoNav tracks unanswered questions and fills them through communication. Ablations distinguish retrieval, communication guidance and recursive contact. Difficult scheduling and social-network tasks still have low accuracy. | Give each investigation a concrete unknown and identify who might resolve it. A useful exchange changes a decision or removes an uncertainty. Role names and status posts alone do not establish that benefit. |
| [The Interaction Tax](https://arxiv.org/html/2608.23541v1), August 2026 | Eleven verifier-scored optimization tasks compare interaction with independent proposals and strong single-agent baselines under matched budgets. Full-solution exchange can erase diversity; localized repair feedback can help. The diversity result is sensitive to one task, and the main comparison uses five seeds per condition. | Preserve independent investigation before sharing conclusions. Distinguish a reproducible defect report from broad encouragement or consensus. This paper concerns candidate optimization, so applying it to repository work is a hypothesis. |
| [Towards a Science of Scaling Agent Systems](https://arxiv.org/html/2512.08296v1), December 2025 | Across 180 configurations, architecture benefits vary by workload: decomposable analysis benefits, while sequential planning degrades under matched reasoning budgets. Coordination overhead consumes capacity needed for the task. | Include a strong single-agent baseline and measure the actual dependency structure. Its fitted thresholds are observations from those benchmarks, not universal launch rules. |
| [Exploring Advanced LLM Multi-Agent Systems Based on Blackboard Architecture](https://arxiv.org/html/2507.01701v1), July 2025 | The board stores partial solutions and a controller selects the next contributors from its contents. Evaluation uses reasoning and mathematics benchmarks. | A blackboard in this literature includes a decision process for acting on shared state. Kimchi's message store alone is not that architecture. Importing its scheduler would be a separate product change. |

## Systems operating in other settings

**Kosmos connects literature search with data analysis.** Its research state links findings to papers and executable analyses, then informs the next investigation cycle. The paper reports about 200 agent rollouts per run. Expert checks supported 79.4% of 102 sampled statements from three reports, but only 57.9% of synthesis statements. This is a concrete example of prolonged complementary work, with substantial verification limits. It is not a controlled board-on/off comparison. [Kosmos paper](https://arxiv.org/html/2511.02824v2).

Edison's May 2026 engineering account reports deployment in biopharmaceutical companies, including Incyte. It describes subagents using separate execution environments with shared files. Treat this as a first-party deployment report, not independent proof of a communication-related productivity gain. [How We Built Kosmos](https://advances.edisonscientific.com/research/how-we-built-kosmos/).

**Anthropic's compiler experiment made failures separable.** Sixteen agents built a compiler using shared Git state and task-claim files; the author explicitly reports no additional inter-agent communication mechanism. Agents initially collided on the same Linux compilation bug. A GCC reference implementation let them isolate different failing subsets and work independently. The useful lesson is to expose independent work and reliable feedback. The experiment demonstrates a substantial artifact, but supplies no matched single-agent comparison proving a messaging benefit. [Building a C compiler](https://www.anthropic.com/engineering/building-c-compiler).

**Cursor's later swarm work addresses shared design and integration.** The July 2026 report describes planner-owned decisions, shared design documents, conflict resolution and different review perspectives. New and old systems were compared on the same SQLite task, models and time budget; the reported four-hour ranges were 73–85% versus 11–77%. Several mechanisms changed together. Solo runs were only informally graded, so this is an orchestration-version comparison, not a demonstrated advantage over a strong solo baseline. [Agent swarms and the new model economics](https://cursor.com/blog/agent-swarm-model-economics).

**Anthropic's deployed Research product searches in parallel.** Its internal evaluation reported a 90.2% improvement over single-agent Opus 4 using an Opus lead and Sonnet workers. The authors identify broad exploration and context capacity as good fits, and tightly dependent coding as harder. The widely repeated 15-times token figure compares multi-agent use with chat, not with the single-agent evaluation baseline. [Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system).

**Kiva is an older industrial example.** Its deployed warehouse system assigned physical work to robot and station agents, with centralized resource allocation, explicit messages and one owner for each important data item. This demonstrates coordinated agents in a constrained operational environment. It is a useful ownership analogy; deterministic robot coordination does not establish that LLM discussion improves software quality. [Kiva paper, AAAI 2007](https://cdn.aaai.org/AAAI/2007/AAAI07-282.pdf).

## What our comparisons leave unanswered

The following are inferences from the external sources and our [recorded experiments](worker-goal-quality-evaluation.json), not measured improvements in Kimchi.

1. **The useful information may be too cheap to rediscover.** Shared access does not mean identical knowledge, but a small task can make independent rediscovery cheaper than reading and assessing peer messages. A board has a stronger opportunity when another worker has already paid for a lengthy investigation.
2. **Progress is only one kind of useful state.** The latest runs consumed automatic TODO snapshots. They did not isolate whether retained constraints, failed approaches and evidence could prevent repeated investigation across many worker lifetimes. A completed TODO alone does not explain what another worker should now do differently.
3. **Independent viewpoints need protection.** Reusing one model, similar prompts and the same visible checks can produce correlated blind spots. Feeding a reviewer the proposed explanation immediately may reinforce it. Different evidence or an independently designed integration check can provide another viewpoint without changing model routing.
4. **Local completion can miss combined behavior.** Our 31/31 output still broke uncached registration after a repair. The useful shared fact was the distinction between claiming a name and registering a tool. Broader success required exercising that transition through the real initialization path.
5. **Final correctness can hide a time benefit.** A capable parent may repair every output eventually. Communication could still reduce duplicate investigation, correction delay or parent repair effort. It could also increase all three. Measure them alongside final defects and total compute.

These findings favor selective communication around information dependencies. They do not justify requiring posts, broadcasting complete drafts or adding workers to create board activity.

## A more informative comparison

A suitable workload is a multi-service compatibility repair. Investigations cover producer behavior, consumer behavior and recorded failure traces. All arms retain access to every source and artifact; the task is large enough that discovering an invariant has a measurable cost. Examples include a schema migration or a cancellation contract spanning several components. The communication arm should gain from reusing discoveries, not from denying essential files to its control.

| Comparison arm | Available coordination | Question answered |
|---|---|---|
| Strong single agent | All files, tools and verification | Is delegation useful for this workload? |
| Workers with ordinary parent coordination | Shared files and final reports | Does dividing investigation help? |
| Workers plus directed messages | Same environment, with live questions and findings | Does earlier delivery help? |
| Workers plus messages and board | Same environment, with retained group findings | Does the board add value beyond messages? |

TODO behavior, worker Ferment policy, model, task inputs and verification remain fixed where applicable. Total compute must include the parent, every worker, evaluation and repair. Quality under a fixed total budget and time to a fixed quality target are separate comparisons. Repeated, varied tasks are needed; one deliberately favorable example would show a mechanism, not a general effect.

An informative exchange might say: “The producer can emit a cancellation after completion. This trace reproduces it; the consumer must tolerate that order.” The recipient checks the trace, changes its assumption and runs an integration test. Existing messages, board entries, TODOs and artifacts can carry that exchange. A new orchestration service is not needed to test it.

The causal observation is a finding unavailable in the recipient's observed context, followed by its consumption, a relevant change and an independently verified consequence. Alternative inputs such as shared files, failing tests and parent instructions remain part of the trace. Count duplicate exploration, time until a dependent worker corrects its assumption, final defects and parent repair work. Message counts only describe activity.

If the board produces no quality, time or compute benefit beyond directed messages and shared files on these workloads, the evidence favors keeping it optional and small. A successful production system elsewhere does not remove that burden of proof.
