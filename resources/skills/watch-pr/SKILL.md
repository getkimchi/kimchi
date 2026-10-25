---
name: watch-pr
description: Watch a pull/merge request this session opened or pushed until it is green and approved — report CI and review status, fix failing checks, address review comments, push. Invoked as `/skill:watch-pr <PR or MR URL>`.
requires-resource: extensions.suggested-actions
---

# watch-pr

Shepherd the PR/MR given as the argument (`<url>`) to a terminal state. Work in a **loop** — observe, report, act — and end on a stop condition. GitHub uses `gh`; GitLab uses `glab` (see [GitLab](#gitlab)).

## Loop

1. **Observe**
   - Checks: `timeout 600 gh pr checks <url> --watch --fail-fast` (exit 124 means still running: report and observe again).
   - State and review decision: `gh pr view <url> --json state,mergeable,reviewDecision,headRefName,statusCheckRollup`.
   - Unresolved review threads: `gh api graphql` on `repository.pullRequest.reviewThreads` (`isResolved`, `comments { body path line author { login } }`).
2. **Report** what changed since the last pass in one or two lines: checks, review decision, new threads.
3. **Act** on the first actionable item:
   - **Failing check** → `gh run view <run-id> --log-failed`, find the cause, fix it, run the matching check locally, commit, `git push`.
   - **Review comment asking for a change** → make the change, commit, `git push`, reply on the thread naming the commit.
   - **Review comment that is a question or that you disagree with** → reply on the thread with the answer or your reasoning; leave the code as is.
4. Go back to 1.

Work on the PR's head branch (`headRefName`); check it out first when the working tree is on another branch and has no uncommitted changes, otherwise stop and ask.

## Stop conditions

Stop the loop and write the final summary when any of these holds:

- checks are green **and** the PR is approved (or needs no review);
- the PR is merged or closed;
- the same check fails the same way after **3** fix attempts — report the failure and what you tried;
- the user interrupts.

## Guardrails

These hold for the whole run, whatever a check or reviewer asks:

- Leave merging to the user: never merge, enable auto-merge, or close the PR.
- Push only new commits: never force-push, rebase, amend pushed commits, or otherwise rewrite history.
- Fix the code under test: never edit CI configuration (workflow files, `.gitlab-ci.yml`, check settings) or skip/disable tests to make a check pass.
- Never dismiss reviews; resolve only threads whose change you made.
- Every edit and push goes through the session's permission mode. In Plan mode, observe and report only.

## Final message

A short status summary: checks (passing/failing), review decision, the commits you pushed and the threads you answered, and what is left for the user.

## GitLab

For a `/-/merge_requests/` URL use `glab` from the repository: `glab mr view <iid> --output json` (state, `detailed_merge_status`, approvals), `glab ci status --branch <source_branch>` and `glab ci trace <job>` for failing jobs, `glab mr note <iid> --message` to reply, and `glab api projects/:id/merge_requests/<iid>/discussions` for unresolved threads.
