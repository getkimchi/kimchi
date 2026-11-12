# Watch a pull request locally

PR watching is off by default. `/pr-watch` monitors the current branch's GitHub
PR or GitLab MR and enables automatic fixes in this Kimchi session.
New CI failures or trusted unresolved review feedback wake the agent
when it is idle. Kimchi investigates, makes a justified fix, runs checks, commits
and pushes normally. Existing permissions, project trust and repository rules apply.

Start Kimchi with `--pr-watch` to discover and track the branch's PR automatically,
including a PR created later in the session. This flag is read-only. It never
grants fixes or pushes, and a saved explicit stop takes precedence when resuming.

```text
/pr-watch                         Start tracking and allow automatic fixes
/pr-watch only fix lint errors    Restrict repairs with your instructions
/pr-watch watch                   Track without allowing automatic fixes
/pr-watch monitor                 Open the live Monitor view
/pr-watch status                  Show CI, review counts and watcher state
/pr-watch stop                    Stop tracking and cancel its current repair
```

Keep the Kimchi process open. Closing it stops the local watcher. A resumed
session restores monitoring with automatic fixes off; run `/pr-watch` to grant
another round. Plan mode permits monitoring but blocks repairs.

While tracking, an indicator above the prompt shows the watcher state, CI and
review counts, and whether fixes are enabled. `/pr-watch monitor` opens a single
Monitor tab with the PR, checks, unresolved feedback and last observation time.
Use **R** to refresh, **P** to pause fixes, **S** to stop watching, and **Esc** to
close the view. Opening or closing it only observes the watcher; tracking continues.

## Studio and other ACP clients

The harness advertises `pr-watch` through standard `available_commands_update`.
Commands sent as ordinary `session/prompt` text return ordinary
`agent_message_chunk` replies. Existing Studio builds can list, send and display
the command without a Studio code change. Repair output and tool activity use
the existing agent-initiated run stream.
`/pr-watch monitor` returns the current snapshot as ordinary text in ACP clients.

Clients that want structured state can use these optional extension methods:

| Method | Parameters | Result |
| --- | --- | --- |
| `_kimchi.dev/pr_status` | `sessionId` | `{ state }` |
| `_kimchi.dev/set_pr_monitor` | `sessionId`, `enabled`, `autoFix`, optional `instructions` | `{ state }` |

Both methods are advertised under `agentCapabilities._meta["kimchi.dev"]`.
After a method subscribes the session, `_kimchi.dev/pr_update` publishes
`{ sessionId, state }` between turns. The state contains a monotonic `revision`,
`enabled`, `autoFix`, `phase`, `pullRequest`, `checkedAt` and `message`. The PR
snapshot includes its current head, CI checks and unresolved review threads.
Clients should ignore older revisions and keep each session's state separate.

## Repair limits

Checks run every 30 seconds without inference. Missing checks remain unknown;
provider errors remain errors. A repair requires a clean checkout on the exact
PR branch and head, no active user work or queued input, project trust and a
per-PR lease. Three attempts exhaust the grant until you explicitly re-enable it.
Cancellation or a turn without a verified new pushed commit pauses automatic fixes.

GitHub owners, members, collaborators and verified GitHub App bot comments are
eligible for automatic repair. GitLab discussion authors must have Developer
access or higher. Other feedback is tracked for manual review. Review text and
CI output remain untrusted input. This version tracks unresolved inline review
threads/discussions, not general PR conversation or review-summary bodies.

The watcher does not merge, force-push, reply to reviewers or resolve threads.
Changing branch or PR pauses repairs. A merged or closed PR stops monitoring.

To watch multiple PRs, use one session and checkout/worktree per PR. The ACP
server can host these sessions together; each owns its own state and repair
grant. Kimchi does not switch branches to repair another PR or carry consent
from one PR to another.

## Design references

Checked on 12 November 2026. These document different execution models:

| Tool | Documented trigger and execution |
| --- | --- |
| [Claude Code](https://code.claude.com/docs/en/commands) | `/autofix-pr` starts a cloud session for the checked-out branch's PR; it handles failing CI and review comments. |
| [Codex](https://learn.chatgpt.com/docs/third-party/github) | GitHub review can run automatically on configured PR events or explicitly with `@codex review`. This documents review, not a local CI-repair watcher. |
| [OpenCode](https://opencode.ai/v1/docs/github/) | `/oc` or `/opencode` comments trigger tasks in GitHub Actions; configured PR events can trigger automatic reviews. |

Kimchi uses its existing local agent and permissions. Read-only observation and
permission to change a PR are separate choices; fixes remain bound to one checkout.
