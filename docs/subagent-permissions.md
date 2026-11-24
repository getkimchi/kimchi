# Subagent permissions

How Kimchi checks the tool calls of an in-process subagent.

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

The same applies in the TUI, in print mode and over ACP. Remote sandbox agents
are different. They run in another process and use that process's gate.

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
2. If the answer is `safe`, the call runs.
3. If the answer is anything else, or the classifier fails, the call is
   blocked.

A blocked subagent is told not to retry the call and to report that the main
agent needs the user's approval. No permission request is sent to an ACP client
for a subagent's own call.

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
- A host may pass one such factory. A spawn with two is refused.

## After `/branch` or `/clone`

A subagent that keeps running after the session is replaced keeps the last
policy it saw from its old parent. It does not fall back to "allow".
