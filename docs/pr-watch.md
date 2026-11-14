# Watch pull requests locally

Kimchi can watch GitHub PRs and GitLab MRs and fix their failing CI. Watching checks
each PR every 30 seconds without model calls. A repair is a normal turn in the current
conversation, one PR at a time, so keep the Kimchi process open.

## Start watching

- When the Branch/PR status first finds an open PR or MR for this checkout, Kimchi asks
  once whether to watch PRs automatically. The answer is saved in your profile's
  `pr-watch.json` for future PRs, repositories and sessions. Yes starts watching with
  CI fixes. Review-comment fixes always need an explicit request.
- `/pr-watch` watches this branch's PR with CI fixes.
- Ask `watch this <url> PR`, give several URLs, or ask `watch my active PRs and fix CI`
  (`watch my active GitLab MRs`, with a host for self-hosted GitLab). This works from any
  directory. Kimchi uses this checkout for its own PR and clones other PRs under your
  profile's `pr-watch/checkouts` through normal Bash permissions. Each checkout needs
  project trust.
- `kimchi --pr-watch` watches this checkout's PR read-only as soon as the Branch/PR
  status finds it.

## Commands

```text
/pr-watch                             Watch this branch's PR, or grant fixes again to the watched PRs
/pr-watch only fix lint errors        The same, with instructions for the repairs
/pr-watch ci | reviews | all          Choose what can start a repair (default: ci)
/pr-watch watch                       Keep watching without fixes (alias: pause)
/pr-watch status                      Check the PRs now and show them
/pr-watch monitor                     Open the Monitor view
/pr-watch stop                        Stop watching and cancel the current repair
/pr-watch <URL> [<URL> ...]           Watch these PRs and fix CI
/pr-watch mine [github|gitlab [host]] Watch your open PRs or MRs and fix CI
/pr-watch enable | disable            Turn automatic watching on or off for future PRs
```

The row above the prompt shows the watched PRs and what needs attention.
`/pr-watch monitor` lists each PR's failing or running checks and unresolved review
threads: **R** refreshes, **P** pauses fixes, **S** stops watching and **Esc** closes the
view while watching continues. Pause and stop apply to every watched PR; ask the agent
to pause or stop one URL to leave the others running.

## How repairs run

A repair starts when a watched PR has a new failing check (in `reviews` or `all` mode,
also new trusted review feedback) and:

- the agent is idle with no queued input, and the session is not in Plan mode;
- the checkout is clean, on the PR branch, at the PR head;
- the checkout is trusted and no other Kimchi session is repairing the same PR.

The agent reads the failed job logs, makes the smallest fix, runs checks, commits and
pushes under the session's normal permissions, then ends its turn. Repair requests
forbid force-pushing, merging, disabling CI, weakening tests, replying to reviewers and
resolving threads. Kimchi then confirms the new commit and watches its CI.

A cancelled repair, a repair without a new pushed commit, or three repairs in one grant
pause fixes for that PR until you grant them again. A merged or closed PR stops being
watched.

`ci` mode ignores review feedback and leaves its text out of repair requests. Trusted
feedback comes from GitHub owners, members, collaborators and verified GitHub App
comments, or GitLab authors with Developer access or higher; other feedback is shown
for manual review. Only unresolved inline threads and discussions count. Instructions
such as "only fix lint" guide the agent; they do not filter checks.

A resumed session watches its PRs again. Fixes resume only while automatic watching is
enabled and the grant has repairs left; a stopped PR stays stopped. GitHub account
discovery reports its 1000-result search limit instead of watching a partial set.

## Studio and other ACP clients

ACP clients opt in at `initialize`; the harness advertises both flags under
`agentCapabilities._meta["kimchi.dev"]`:

```json
{
  "clientCapabilities": {
    "_meta": {
      "kimchi.dev": {
        "prMonitoring": true,
        "backgroundRuns": true
      }
    }
  }
}
```

Without both flags Kimchi registers no PR watch command, tool or question and does not
restore a saved session's watching; the conversation replays normally. With them,
`pr-watch` appears in `available_commands_update`. `/pr-watch` replies arrive as
`agent_message_chunk` text, and commands that need checkouts continue as an ordinary
prompt. Natural-language requests use the `pr_watch` tool, and repairs use the
background-run start and end notifications.
