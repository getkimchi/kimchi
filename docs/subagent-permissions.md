# Subagent permissions

How Kimchi checks the tool calls of an in-process subagent. For what happens
when the permission classifier itself fails, see
[permission-classifier.md](permission-classifier.md).

## One gate, the main session's policy

Every in-process subagent has a permission gate. Isolated and resumed agents
have one too.

The gate uses the policy of the session that started the subagent:

- its permission mode (`default`, `plan`, `auto`, `yolo`),
- rules from the config files,
- `--allow-tool` and `--deny-tool` rules,
- rules the user chose to remember during the session.

The policy is read again on every tool call. If the main session switches to
plan mode, the next call from a running subagent is read-only too.

Remote sandbox agents are different. They run in another process and use that
process's gate.

## What each mode does

| Main session mode | Effect on a subagent's call |
| --- | --- |
| `plan` | Writes and non-read-only bash are blocked. |
| `default`, `auto` | A call that is not read-only and that no rule allows goes to the classifier. See [When a call needs a decision](#when-a-call-needs-a-decision). |
| `yolo` | The call runs without the classifier. Deny rules and hard-blocked bash still apply, unless the main session has the dangerous full bypass enabled. |

## Calls that need no decision

These run in every mode that allows them, without the classifier:

- read-only tools and read-only bash commands,
- `skill`, todo reconciliation, web reads and read-only MCP calls,
- debugger inspection of a stopped session (`debug_locals`, `debug_backtrace`),
- the Ferment worker-report tool.

Two details:

- Debugger launch, continue and step run code. They are not reads, so they go to
  the classifier in `default` and `auto`.
- A well-formed `kimchi doc-cli` command uses its fixed first-party shortcut, as
  it does in a main session that cannot prompt. In `default` mode this includes
  subcommands that change files.

## When a call needs a decision

A subagent cannot open a permission prompt of its own. In `default` and `auto`
mode, a call that is not read-only and that no rule allows is handled like this:

1. The classifier judges the call. This is one classifier request per call.
2. If the answer is `safe`, the call runs. No prompt is shown.
3. If the classifier fails, or asks for confirmation, the main session asks the
   user for the subagent. This works in the TUI and over ACP. The prompt names
   the subagent and its task.
4. The user answers:
   - **Allow once** runs this one call.
   - **Remember for this subagent** stores the rule in the subagent's own
     session. The rule is kept when the subagent is resumed.
   - **Deny** is returned to the subagent.

The call is blocked when nobody can decide:

- there is no place to ask (print mode, a headless ACP host),
- the request cannot reach the main session,
- nobody answers within five minutes after the prompt is shown.

The subagent is then told not to retry the call and to report that it needs the
user's approval.

How the prompt waits for a free input, what the client sees over ACP, and what
happens on a mode change are described in
[Subagent approval in the main session](permission-classifier.md#subagent-approval-in-the-main-session).

## Which subagent is asking

Each subagent gate gets its parent session id and its task identity when the
subagent starts. They do not change afterwards. Per-run state, such as the hold
on the inactivity watchdog while a prompt is open, is kept separately for each
run. Subagents that run at the same time cannot use each other's parent or
watchdog state.

## Pre-approved calls from a host

Code that starts a subagent can pre-approve a narrow set of calls for it. It
passes a `createPermissionsExtension({ preApproved })` factory with the inline
extensions of the spawn. The Ferment V2 verifier does this for its report tools
and for the probe files it writes.

- The factory is not loaded in the subagent. Its options are added to the
  subagent's own gate, so the subagent still has exactly one gate, under the
  main session's policy.
- A pre-approval is checked after the deny rules, the plan-mode check and the
  read-only checks, and before the classifier. A deny rule or plan mode always
  wins.
- Such a subagent never asks the user. A call the classifier does not clear is
  blocked.
- A host may pass one such factory. A spawn with two is refused.

## After `/branch` or `/clone`

A subagent that keeps running after the session is replaced:

- keeps the last policy it saw from its old parent. It does not fall back to
  "allow".
- keeps its original parent session id. It cannot send an approval request to
  the new session, so a call that needs approval is blocked.

Start a new subagent from the new session when a call needs the user's approval.
