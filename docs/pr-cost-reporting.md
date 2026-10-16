# PR cost reporting

The Kimchi gateway reports PR costs to your account from the requests it serves. Kimchi records no work, looks up no bills and uploads no reports. On each request it tells the gateway whether the request may be reported and which session and turn it belongs to.

## Request headers

Kimchi adds these headers to its agent and subagent requests and to its side calls: session naming, image descriptions, the permission classifier, and the Ferment judge and evaluator. Except for `X-Request-Id`, they go only to a configured Kimchi gateway endpoint: the project's `llmEndpoint`, `openAiBaseUrl`, `anthropicBaseUrl` or `experimentalOpenAiBaseUrl`.

| Header | Value | Sent |
| --- | --- | --- |
| `X-Kimchi-PR-Reporting` | `proxy` or `off` | On every gateway request: `proxy` when the gateway may report it (see [When requests are reported](#when-requests-are-reported)), otherwise `off`. |
| `X-Session-Id` | The session's ID | With `proxy`. Telemetry also sends it on agent requests while usage reporting is on. |
| `X-Parent-Session-Id` | The parent session's ID | Like `X-Session-Id`, for subagent sessions. |
| `X-Turn-Index` | The session's current turn | Like `X-Session-Id`, when this process counts the session's turns. |
| `X-Request-Id` | A UUID for each attempt | To any provider while Cost per PR is enabled. A retry, including one inside a provider SDK, gets a new UUID. |
| `X-Tags` | The request's tags plus `kimchi-request:<X-Request-Id>` | On gateway requests while Cost per PR is enabled, when Kimchi can read the request body. |

The gateway finds a request's bill by its `kimchi-request` tag. The tag never displaces a user tag: a request that already has 10 tags (the gateway's limit, counting `X-Tags`, `X-LiteLLM-Tags` and the body's `tags` together) or its own `kimchi-request` tag is sent without one, and the gateway identifies it itself. A retry drops the previous attempt's tag.

## When requests are reported

`X-Kimchi-PR-Reporting` is `proxy` only when all of these hold:

1. **Cost per PR is enabled.** The `extensions.cost-per-pr` resource is the master switch and is on by default. Your organization's policy can force it on or off. While it is off, requests carry neither `X-Request-Id` nor the `kimchi-request` tag, and `/pr-reporting` and the footer link are not loaded.
2. **This process may report.** These never report, whatever the setting:
   - processes with `KIMCHI_PR_COST_REPORTING` set to `0`, `false`, `off` or `no`;
   - `--print`/`-p` and `--mode json` runs, including piped input;
   - CI jobs: any of `CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `BUILDKITE`, `JENKINS_URL`, `TEAMCITY_VERSION`, `CIRCLECI` or `TF_BUILD` set to a value other than empty, `0`, `false`, `off` or `no`;
   - benchmark runs, recognized by a positive `KIMCHI_INFRA_BREAKER_THRESHOLD`.

   Interactive TUI, Studio (ACP) and RPC sessions report. Subagents follow their main session.
3. **You agree.** A saved `/pr-reporting on` or `off` decides, and it outlasts restarts and changes to the telemetry setting. Without one, reporting follows the SaaS usage-reporting setting (`kimchi config telemetry`) with your organization's usage-reporting policy applied.

A saved state Kimchi cannot read counts as `off`.

## `/pr-reporting`

- `/pr-reporting on` lets the gateway report your requests.
- `/pr-reporting off` asks the gateway not to report them. Reports it already made stay on the server.
- `/pr-reporting status`, or `/pr-reporting` alone, shows the setting, whether it follows the SaaS default or an explicit choice, and whether this session is reported:

  ```text
  PR reporting   Enabled (SaaS default)
  This session   Not reported
                 Reason: CI environment (GITHUB_ACTIONS)
  ```

Typing `/pr-reporting ` suggests `on`, `off` and `status`. The choice is saved per installation in `~/.config/kimchi/harness/pr-cost-reporting/state.json`; an isolated harness home uses its own.

The first interactive session reported by default shows a one-time notice: `PR costs are reported to your account by the Kimchi gateway. Turn off with /pr-reporting off.` Studio shows it as a notification after the first turn, because it drops notifications sent before it registers the session. After an explicit choice the notice is not shown.

## Plans

Each saved plan starts with `<!-- kimchi-work-id: <uuid> -->`, and each version is kept under the agent directory at `work/<uuid>/plans/<slug>-<sha256>.md`, outside disposable worktrees. A new plan takes the ID of the request that writes it, which the gateway already sees in that request's `kimchi-request` tag. Revisions keep it, and a Ferment started from the plan uses it for its own plan. When a later session reads or pastes the plan, or names its retained copy, the gateway sees the same ID and links the planning session to the session that implements it, even when the planning session ended at the plan.

When the retained copy cannot be written, plan review continues and Kimchi warns: `plan saved without its retained copy, so deleting this worktree also deletes the plan`.

## Branch PR/MR in the footer

While Cost per PR is enabled, the footer shows the checked-out branch's GitHub PR or GitLab MR, for example `PR #12 open` or `MR !7 merged`, linked in terminals that support links. Studio receives the same text and URL as the `work-pr` and `work-pr-url` statuses. The footer records nothing and plays no part in PR costs.

- Kimchi reads the provider with your own credentials, in this order: environment tokens (`GH_TOKEN` or `GITHUB_TOKEN` for github.com; `GH_ENTERPRISE_TOKEN` or `GITHUB_ENTERPRISE_TOKEN` for `GH_HOST`; `GITLAB_TOKEN`, `GLAB_TOKEN` or `GITLAB_ACCESS_TOKEN`), the token saved in Kimchi for that host, then `gh auth token` or glab's saved login.
- It checks the branch every 30 seconds. It asks the provider again after a branch change, after the agent runs `git push`, `gh pr create` or `glab mr create`, and otherwise every five minutes.
- A repository without a GitHub or GitLab remote shows nothing. Network errors and rate limits keep the last result. Other failures show `PR/MR unavailable` and one warning per distinct error.

## Turning it off

- `/pr-reporting off` makes every gateway request say `off`. Request IDs and tags are still sent.
- `/resources disable extensions.cost-per-pr` or `kimchi resources disable extensions.cost-per-pr` turns off Cost per PR: requests say `off` and carry no request ID or `kimchi-request` tag, and after a restart `/pr-reporting` and the footer link are gone.
- `KIMCHI_PR_COST_REPORTING=0` keeps one process from being reported.

## Diagnostics

`NODE_DEBUG=kimchi:pr-cost` appends request and plan identity problems to `logs/pr-cost.log` in the agent directory. Nothing goes to the terminal or to Studio.
