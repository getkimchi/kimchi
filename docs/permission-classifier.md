# Permission classifier — what happens when it fails

The permission classifier is a small LLM call that answers one question about a
tool call: is it `safe` to run, or does it `requires-confirmation`? It is the
last step of the permission gate — cheaper checks (mode gates, allow/deny rules,
read-only detection) run first — and it only runs when needed:

| Context | Classifier used? |
| --- | --- |
| Interactive session in `default` mode | No — the user is prompted directly. |
| Interactive session (TUI or IDE) in `auto` mode | Yes. `safe` runs; anything else prompts. |
| Subagent in `default` or `auto` mode | Yes — the classifier runs first. `safe` runs; a failure or `requires-confirmation` asks in the main session when possible, otherwise blocks. |
| `yolo` or `plan` mode | No. |

It tries three models in order (8 s per attempt, 25 s for the whole ladder by
default). It has no "deny" verdict: it can only let a call run or hand it to a
human.

## What happens on a failure

A failed classification (timeout, provider error, unparseable output) is not a
verdict — it never approves a call. The gate **never fails open**: an outage
cannot turn `auto` mode into unrestricted running.

- **Someone can be asked** (interactive session): the regular permission prompt appears, and it says the
  classifier is unavailable. Approve or reject as usual. (The subtitle line shows in the terminal; IDE
  permission cards currently do not carry it.)
- **Nobody can be asked** (print mode, a headless host, a missing or stale
  parent surface): the call is blocked. The model receives a fixed reason
  explaining that the classifier is temporarily unavailable, that it should not
  retry in a loop, and — for subagents — that it should report the block to the
  main agent, which can run the step with the user's confirmation. The user is
  warned on every blocked call: as a toast in interactive sessions (a
  subagent's warning is forwarded to its parent session), and on stderr in
  headless runs. A subagent with an interactive parent uses the escalation route
  below before this fallback is reached.

All of this wording is fixed. Provider error text never reaches the prompt, the
model, or the user.

## Circuit breaker

During an outage, repeated calls should not each pay the 25 s ladder. After one
full ladder ends in a transport-class failure (timeout, provider error, auth
lookup failure, budget exhaustion), a circuit breaker opens for **60 seconds**:

- Calls that need the classifier get the stored failure immediately — the gate
  asks or blocks as above, with no wait.
- After the window, the next call runs a probe — a normal classification with
  the usual budget, so a probe succeeds exactly when a normal call would.
  Success closes the breaker and shows a one-time "classifier is back"
  notice; a transport-class failure re-opens it for another window, while a
  non-outage answer (unparseable output, missing configuration) closes it
  without the notice.
- Failures that look specific to one input (unparseable output) or static
  (no API key, no candidate models) do not trip the breaker, and a block
  reason matching the cause is used: an outage says the classifier is
  temporarily unavailable, a missing API key points at the configuration, and
  an unparseable answer allows one retry.

Worst case during an outage: one 25 s wait, then instant outcomes, then at
most one normal-length probe (up to 25 s) per minute until the classifier
recovers.

## Getting unblocked

| Way out | Works for | Notes |
| --- | --- | --- |
| Approve the prompt | Interactive session in `auto` mode | A failed classification becomes a prompt. |
| Answer the escalated prompt | Subagents in an interactive session | A failed classification or `requires-confirmation` opens a permission prompt **in the main session** that names the subagent and task; see below. |
| Add an allow rule | Everything, including subagents and headless | Rules are matched **before** the classifier. `/permissions allow <rule>` is session-only and is shared live with workers. `/permissions save project` writes it to the project's `permissions.json`. A "for this subagent" answer lives only in that child, separately from parent rules. |
| Switch to `yolo` | Everything | Broad: skips the classifier for all calls. Workers read the parent's current mode before every tool call. |
| Wait | Everything | The breaker probes every 60 s and announces recovery. |

Telling the agent "I authorize it" in chat does nothing — the permission gate
does not read the conversation.

## Subagent approval in the main session

A subagent has no prompt surface of its own. In `default` and `auto` mode the
classifier runs first for an otherwise unapproved non-read-only call. A `safe`
answer runs without a prompt. When the classifier fails (including timeouts,
provider errors, invalid output, missing models, or missing API keys) or returns
`requires-confirmation`, the decision escalates: **the permission prompt opens
in the main session**. User-aborted classification is not treated as an outage.

The prompt identifies the asking subagent and its task (`Subagent <persona> —
<description> wants to run:` in the TUI). Failure prompts use fixed unavailable
copy; a `requires-confirmation` prompt uses the classifier's reason and risk
score. Compound bash commands get one prompt for the whole call.

Choices are allow once, allow and remember **for this subagent**, and deny, with
deny first so an unrelated Enter while the user is typing cannot accidentally
approve a call. The remembered rule is written to the child's own session memory,
not the parent's, and survives `session_shutdown` and `session_start` when that
same child is resumed. It is not shared with other children. Deny-with-feedback
is returned to the child's model so it can change course.

Behavioral rules:

- Sequential prompts are serialized behind one queue — the main session's own
  prompts and escalated subagent asks interleave one at a time.
- If nobody answers within 5 minutes (counted from when the prompt is shown,
  not when queued), or the parent surface is missing, stale, cancelled, or
  errors, the route fails closed, never to an allow. Classifier failures retain
  the fixed outage block; a working non-`safe` verdict retains PR 1's
  `Classifier: <reason> Do not retry…` worker block.
- The subagent's inactivity watchdog is paused while it waits for your answer,
  so a slow click does not get it steered or killed. Its wall-clock cap keeps
  running.
- TUI and ACP use the same parent route. ACP sends a normal permission card for
  a parent-allocated tool-call ID, names the subagent in the title and `_meta`,
  and sends a closing `tool_call_update` when the decision settles. Print mode
  and headless ACP hosts retain the fail-closed block. Remote sandbox agents and
  the separate curator subprocess do not use this in-process route.

## Configuration

Two keys in `permissions.json` (user, project `.kimchi/`, or local
`.kimchi/permissions.local.json`) control the classifier's time budget:

| Key | Default | Effect |
| --- | --- | --- |
| `classifierTimeoutMs` | `8000` | Deadline for one classification attempt. |
| `classifierMaxTotalMs` | `25000` | Budget for the whole model ladder. |

`allow` / `deny` rule lists and `defaultMode` are documented by the
`/permissions` command. The breaker window and the model list are not
configurable.
