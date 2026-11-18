# Director mode

Director is a native, explicitly activated **main-session mode** for complex multi-agent objectives. It separates orchestration from ordinary `subagents` delegation: there is no `director` subagent type and nested Directors are rejected.

## Start and stop

- `/skill:director <objective>` starts a bounded run and shows `Director — <objective>`.
- Ordinary prompts steer or request progress; they do not reset the run.
- `/director status` renders the durable plan without a model turn.
- `/director stop` cancels the run and its owned workers.
- `/director stop --handoff` clears Director while leaving its workers under ordinary session control.
- Director can finish itself with `director_finish` after every worker is accounted for and verification is recorded.

Director is never activated from model-selected skill loading, invocation heuristics, or extension-originated messages. The human command remains visible even though `disable-model-invocation` hides it from model-facing catalogs.

## Enforced tools

While active, the `orchestration-director` profile permits only:

- `Agent`, `resume_subagent`, `steer_subagent`, `get_subagent_result`
- `questionnaire`, `skill_view`
- `director_plan`, `director_finish`

Direct file reads/edits, shell, web research, unrelated MCP calls, and other tools are withheld. Other explicitly loaded skills are context and constraints for worker briefs; they cannot widen this profile or replace the lifecycle. The ordinary profile is restored after completion or stop.

Activation and completion use actual worker records, not assumptions from the conversation. Existing workers must be joined, stopped, or explicitly handed off. Other orchestration runtimes are mutually exclusive with Director.

## Durable continuity

Director state is revision-checked and appended as a complete, validated session snapshot (`director-mode/v1`) through `pi.appendEntry`; no arbitrary file `write` is required. The plan records:

- Objective, task DAG, current phase, and acceptance criteria
- Decisions, contracts, assumptions, and ownership
- Worker status, results, dispositions, and artifact references
- Verification, open questions, and plan artifacts

Full logs and transcripts stay in referenced artifacts. Director uses `director_plan` to consult this state when needed.

Same-session compaction and resume preserve the active objective, indicator, and plan. A genuinely new session starts inactive. Previously running workers without matching live records become `uncertain`; new delegation remains blocked until each is resolved or handed off. Live remote records reconcile by ID, so resume does not duplicate effects.

## Compatibility

The activation format follows Agent Skills conventions, but this mode is Kimchi-native. Its runtime contracts depend on the Director extension in this repository, Kimchi session entries, the agent manager, and the TUI/ACP status APIs. End-to-end coverage exercises activation, status, steering, tool restriction, clean stop, resume, and both Ferment exclusivity paths.
