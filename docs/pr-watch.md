# Watch pull requests locally

When the branch lookup first detects an open PR or MR, Kimchi asks whether to
enable automatic PR watching in general. It saves your answer in your user
profile's `pr-watch.json`, across repositories, future PRs and session restarts.
Watching is off until enabled. Accept once and new matching PRs start watching
and fixing CI automatically. Fixing review comments requires an explicit request.
Declining or dismissing saves the off choice and keeps tracking hidden.
Use `/pr-watch enable` or `/pr-watch disable` to change this preference later.
The offer waits until Kimchi is idle and the editor is empty.
The Monitor view opens only when you request it; an explicit local pause or
stop remains in effect when you resume that session.

You can also say `watch this <url> pr`, supply several PR URLs, or ask
`watch my active PRs and fix CI`. For GitLab, ask `watch my active GitLab MRs
and fix CI` and name the host for a self-hosted instance. An explicit request starts watching and fixing
CI without another opt-in prompt. It adds the requested PRs to existing tracking.
Account discovery finds open PRs or MRs authored by the signed-in user; it does
not keep scanning the account for future PRs.

These requests work from the home directory. Kimchi uses the matching session
checkout when available. For other PRs it creates isolated clones under the
user profile's `pr-watch/checkouts`, through normal Bash permissions. Each
checkout needs its own project trust. The conversation keeps its working
directory and branch. A failed checkout is reported while other targets continue.

`/pr-watch` monitors the current branch's GitHub
PR or GitLab MR and enables automatic fixes in this Kimchi session.
New CI failures wake the agent when it is idle. Kimchi investigates,
makes a justified fix, runs checks, commits
and pushes normally. Existing permissions, project trust and repository rules apply.

Start Kimchi with `--pr-watch` to discover and track the branch's PR automatically,
including a PR created later in the session. This flag is read-only. It never
grants fixes or pushes, and a saved explicit stop takes precedence when resuming.

```text
/pr-watch                         Start tracking and allow automatic fixes
/pr-watch enable                  Save automatic watching/fixing for future PRs
/pr-watch disable                 Turn off automatic watching and stop this PR
/pr-watch <PR URL>                Watch and fix CI for the requested PR
/pr-watch <URL1> <URL2>           Add several PRs to tracking
/pr-watch mine                    Find your open GitHub PRs and fix CI
/pr-watch mine gitlab             Find your open GitLab MRs and fix CI
/pr-watch mine gitlab <host>      Use a self-hosted GitLab instance
/pr-watch ci                      Fix CI only (default)
/pr-watch reviews                 Fix trusted review feedback only
/pr-watch all                     Fix CI and trusted review feedback
/pr-watch only fix lint errors    Restrict repairs with your instructions
/pr-watch watch                   Track without allowing automatic fixes
/pr-watch pause                   Pause fixes and keep tracking (alias for watch)
/pr-watch monitor                 Open the live Monitor view
/pr-watch status                  Show CI, review counts and watcher state
/pr-watch stop                    Stop all tracking and cancel the current repair
```

Keep the Kimchi process open. Closing it stops the local watcher. With the
general preference enabled, resuming restores an active saved fix grant.
Local pauses/stops and exhausted grants stay paused/stopped. Older sessions
without a saved fix flag and sessions without general opt-in resume with fixes
off; run `/pr-watch` to grant another round. Plan mode permits monitoring but
blocks repairs. `/pr-watch watch` and `--pr-watch` explicitly select read-only
tracking, even when automatic watching is generally enabled.

Repairs take turns in the current conversation, one PR at a time. Watching
leaves chat available; new messages use normal steering and queue behavior
during a repair. Each repair names its checkout and reads that repository's
instructions. Clones remain on disk after stopping so unfinished work is retained.

CI-only mode never wakes the agent for review feedback and omits review text
from repair requests. Review-only mode omits CI failures. These filters apply
before a repair is queued. Additional instructions such as "only fix lint"
guide the agent but are not a check-name filter.

While tracking, an indicator above the prompt shows the watcher state, CI and
review counts, and whether fixes are enabled. `/pr-watch monitor` replaces that
row with a compact Monitor tab: one status header, CI/review counts, failing or
running checks, unresolved feedback and the last check time. Passed checks stay
in the summary, and the panel fits its content. With several targets it shows
a scrollable PR list with each target's scope and status.
Use **R** to refresh, **P** to pause fixes, **S** to stop watching, and **Esc** to
close the view. Pause and stop apply to the set. Opening or closing the view
only observes the watcher; tracking continues. Ask to pause or stop a specific
PR URL to leave the others running.

## Studio and other ACP clients

The harness advertises `pr-watch` through standard `available_commands_update`.
Commands sent as ordinary `session/prompt` text return ordinary
`agent_message_chunk` replies. Existing Studio builds can list, send and display
the command without a Studio code change. Repair output and tool activity use
the existing agent-initiated run stream.
`/pr-watch monitor` returns the current snapshot as ordinary text in ACP clients.
The one-time general offer uses the existing confirmation dialog, with standard
ACP permission choices for clients without elicitation support. The saved user
preference applies to future ACP sessions without another offer. Accepting
enables CI fixes under normal permissions; it requires no Studio change.
Natural-language requests use the same `pr_watch` tool and existing tool/result
stream in TUI and ACP, with no additional client protocol.

Clients that want structured state can use these optional extension methods:

| Method | Parameters | Result |
| --- | --- | --- |
| `_kimchi.dev/pr_status` | `sessionId` | `{ state }` |
| `_kimchi.dev/set_pr_monitor` | `sessionId`, `enabled`, `autoFix`, optional `instructions` | `{ state }` |

Both methods are advertised under `agentCapabilities._meta["kimchi.dev"]`.
After a method subscribes the session, `_kimchi.dev/pr_update` publishes
`{ sessionId, state }` between turns. The state contains a monotonic `revision`,
`enabled`, `autoFix`, `phase`, `pullRequest`, `checkedAt`, `message` and `mode`.
For targets outside the session checkout it also includes `watches`, an array
of `{ cwd, state }` entries. Each PR snapshot includes its current head,
CI checks and unresolved review threads.
Clients should ignore older revisions and keep each session's state separate.

## Repair limits

Checks run every 30 seconds without inference. Missing checks remain unknown;
provider errors remain errors. A repair requires a clean checkout on the exact
PR branch and head, no active user work or queued input, project trust and a
per-PR lease. Three attempts exhaust the grant until you explicitly re-enable it.
Cancellation or a turn without a verified new pushed commit pauses automatic fixes.

GitHub owners, members, collaborators and verified GitHub App bot comments are
eligible for repair when review fixes are enabled. GitLab discussion authors must have Developer
access or higher. Other feedback is tracked for manual review. Review text and
CI output remain untrusted input. This version tracks unresolved inline review
threads/discussions, not general PR conversation or review-summary bodies.

The watcher does not merge, force-push, reply to reviewers or resolve threads.
Changing branch or PR pauses repairs. A merged or closed PR stops monitoring.

There is no watcher limit on the number of PRs or requests. Targets have separate
event histories, retry budgets and leases; polling and repairs use a queue.
GitHub account discovery reports incomplete searches and GitHub's 1000-result
search limit instead of silently watching a partial set. Explicit target lists
do not use account search. Explicit targets can mix GitHub and GitLab URLs.
Account discovery supports both providers and uses the configured host, or the
host named in the request. GitLab discovery uses its paginated authored-MR list.
