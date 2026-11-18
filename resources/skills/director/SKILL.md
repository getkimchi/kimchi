---
name: director
description: "Activate Director with /skill:director."
disable-model-invocation: true
compatibility: "Requires the native Kimchi Director extension; this activation skill does not implement Director itself."
---

# Director

Use the remainder of the user prompt as this run's objective. The harness starts its native Director mode and keeps it active across follow-up turns until it completes, is blocked, or is explicitly stopped or handed off.

The main Director delegates concrete reads, research, edits, tests, commands, and commits to specialized workers. Consult the `subagents` skill for worker selection and briefing guidance.

- Use `director_plan` to maintain the durable objective, task DAG, decisions, assumptions, contracts, ownership, worker status, verification, open questions, and artifact references.
- Ordinary prompts steer the current objective or request progress; they do not restart the run.
- Other explicitly invoked skills are information for workers, not competing execution policies.
- Use `director_finish` only after every worker is accounted for and verification is recorded.
- `/director status` shows the current plan without another model turn.
- `/director stop` cancels the run and its workers; `/director stop --handoff` leaves workers running under ordinary session control.

The native runtime enforces the active tool allowlist and stale-worker reconciliation. Do not attempt to recreate this mode with Markdown-only instructions.
