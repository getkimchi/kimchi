# PR cost reporting

PR cost reporting follows the SaaS telemetry setting by default. When SaaS uploads are on, Kimchi reports existing work automatically, including requests made before a PR exists. An explicit `/pr-reporting on` or `off` overrides that default and survives restart. Existing saved choices are preserved.

The first interactive main session shows one notice that PR costs are reported, with `/pr-reporting off` to disable it. Studio shows it as a notification after the first turn, because notifications sent before a session is registered are dropped. The notice is saved per installation and does not repeat after restart. It is skipped when reporting is off or the user already made an explicit choice.

- `/pr-reporting on` enables uploads for the verified account and requests an immediate update. It resets retry scheduling for event batches.
- `/pr-reporting status` shows the saved choice, whether this session uploads, queued and acknowledged events, frozen batches, retry time and last event acknowledgement. Delivery problems come first and make the message a warning, including saved event failures after capture resumes successfully. Counts cover the local outbox across accounts; sending still requires verification of their original account. Status does not freeze or send batches. Lines fit a 60-column terminal.
- `/pr-reporting off` cancels delivery and retains pending payloads locally for a later retry. Local work history and revision counters remain. Reports already accepted by the server remain there.

Typing `/pr-reporting ` suggests `on`, `off` and `status`.

For example:

```text
Delivery problems
- PR cost event upload returned HTTP 503

PR reporting   Enabled (SaaS default)
This session   No uploads; local attribution continues
               Reason: CI environment (GITHUB_ACTIONS)
Events         120 queued · 3,400 acknowledged
               1 frozen batch awaiting acknowledgement
Event retry    in about 5 min
Last event ACK 2026-10-25T08:00:00.000Z
```

Only main sessions with work tracking run this extension. Child sessions contribute their existing request records through the local calculator; they do not start upload workers. Turning Cost per PR off in `/resources` turns off work tracking, PR/MR status and reporting together.

The existing reconciliation worker captures local history at startup, after agent turns and every 30 seconds while Kimchi runs. New observations become revisioned events in the same SQLite database as work tracking. There is no separate daemon or model call for delivery. A request can appear as unlinked or unknown, then acquire a PR or price through a later revision without adding the same charge again.

Kimchi reports PR costs only through these events. Snapshots that an older version left pending, in `state.json` or frozen in the SQLite database, stay on disk but are neither read nor sent. A change still queued when Kimchi exits remains durable for the next session.

## Event uploads

Kimchi sends `POST /ai-optimizer/v1beta/organizations/{organizationId}/pr-cost-events:batchIngest`, using the reporting Kimchi API key. Inference can use a different endpoint and provider. Each frozen body is `{"batch":{...}}`; the acknowledgement is a flat object containing `batchId` and complete per-event receipts. SQLite advances only the acknowledged persisted bytes. Lost, invalid or partial acknowledgements retain the batch for replay.

Uploads include only facts available in the captured records:

- Physical request IDs, observed model/provider usage and reported cache/iteration counters, source version and completeness. Missing attempts, counters, pricing dimensions or catalog rates remain unknown.
- Work metadata and allocation from the existing calculator, repository/PR metadata and Jira issue references. Work/session/device and plan/file identities use opaque identifiers; an explicit work title and provider PR title/login can be included.
- Terminal tool category, outcome and duration when observed, plus captured file revision transitions. Filesystem observation windows remain ambiguous about which process changed a file.
- Observed plan revision identities, Git commit SHAs and explicit coverage gaps. Raw plan hashes, local paths, prompts, plan contents, file contents, tool arguments/results and credentials are not sent.
- Genuine billing aliases when available. Authentication establishes the contributor; the harness source is retained separately. Shared credentials cannot distinguish people.

Direct-provider costs are server-side rate-card estimates when usage and pricing dimensions suffice. These are distinct from verified Cast billing rows; a matching owned bill can replace an estimate. Missing usage is not zero, and observing a response does not prove that hidden gateway retries or negotiated prices are known. Tool/file links do not establish an exact dollar allocation per file. Server deployment and the supported harness capture surfaces still bound what a report can show.

The outbox freezes at most 100 events and 1 MiB per batch. Revisions preserve their prior identity and hashes; ambiguous or unsupported records keep their translation intent instead of being discarded. Empty queues and batches whose retry is still in the future make no authentication request. A candidate send freshly verifies the key/account and rechecks consent and lease ownership. Pending state and retries survive restart. No proxy metrics are required.

### Sessions that never upload

CI jobs, one-shot runs and benchmarks would only add noise, so they keep recording and attributing work locally but skip the reporting pass and never upload. A later interactive session on the same machine builds and sends the same reports from those records. `/pr-reporting status` names the reason:

- `KIMCHI_PR_COST_REPORTING=0` (also `false`, `off` or `no`) turns uploads off for the process, whatever the saved choice.
- `--print`/`-p` and `--mode json` runs, including piped input, which Pi runs in print mode. Interactive TUI, Studio (ACP) and RPC sessions upload.
- CI: any of `CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `BUILDKITE`, `JENKINS_URL`, `TEAMCITY_VERSION`, `CIRCLECI` or `TF_BUILD` set to a value other than empty, `0`, `false`, `off` or `no`.
- Benchmark runs, recognized by a positive `KIMCHI_INFRA_BREAKER_THRESHOLD`; only the benchmark harness and CI set it.

The saved choice and the default-on notice are unaffected; nothing overrides the detection to force uploads.

Teleport transfers conversation history but does not transfer the local accounting journals or account scope. On a fresh sandbox, normal continuation starts a new work on the first input. An explicitly selected work keeps its ID, but its missing scope remains unknown. Neither case establishes a complete cost across local and remote work. Remote-agent accounting is outside this reporting change.

## Matching

Events come from the original journals through the same billing validation and calculator used by local cost summaries; per-work `costs.json` files are not concatenated. Two works contributing to one PR do not duplicate requests.

Each request carries its allocation kind, its candidate PR IDs in one destination repository and the evidence method. An input whose native edits landed in the PR is `native`; other session inputs are `session` and stay inferred. Continued plans are `explicit`; `/work link` corrections are `user-correction`. Model guesses are `model` and stay inferred. A request whose candidate PRs span several repositories is `unknown`. A request that starts after several PRs merged keeps all candidate IDs as one shared claim; the backend compares its start time with each merge time. A request's `correction` contains the validated link's UUID, revision, time and source (`work-command` or `producer-confirmation`). The source distinguishes an explicit `/work link` or `/work unlink` from a verified saved-plan or artifact confirmation. A request with more than 8 billing IDs is sent without them; the server then finds its bills by the request's exact tag.

GitHub IDs come from the PR's `id` and target `base.repo.id`. GitLab IDs come from the MR's `id` and `target_project_id`. A fork's source repository ID never replaces the target ID. Old merged links without these IDs are refreshed.

Records without their original account or repository stay unresolved; Kimchi never attaches them to today's login. A request in a repository without a GitHub or GitLab identity (no such remote, or the local repository no longer exists) is sent without a repository. The same applies to a self-hosted server that Kimchi cannot recognize as GitHub or GitLab, for example because its API cannot be reached without saved credentials; Kimchi checks it again a day later. A repository lookup that failed for another reason, such as a network error or rate limit, leaves the request unresolved until a lookup succeeds. An unparseable final journal line without a newline is ignored as an interrupted append, as is a cut-off record that later appends moved past (older versions start a new line after it). Other malformed records, including a cut-off final record, and unreadable journals stop capture until they are readable; queued batches still go out. These cases appear in `/pr-reporting status` as delivery problems.

## Local state and retries

State lives under `getAgentDir()`:

```text
~/.config/kimchi/harness/pr-cost-reporting/state.json
~/.config/kimchi/harness/pr-cost-reporting/ledger.db
```

An isolated harness home uses its own directory. The state file contains consent, the default-notice flag, a producer UUID with its salted machine fingerprint, and the latest local reporting error. The producer and fingerprint remain unchanged after a home is copied. Delta producer registration uses a separate SQLite bookkeeping note: it seeds the state file's identity once, rotates only for a known hardware change, and never rewrites frozen events or batches. The server deduplicates bills across producers, so copied history is not counted twice. Opt-out pauses delivery and retains pending batches. Files are private to the local user. A lock protects concurrent writers; a synced temporary file and rename publish each update.

The existing reconciliation worker runs reporting after local cost lookup; a proxy lookup failure does not prevent direct usage reporting. Capture and delivery have bounded five-second passes with at most three sends per pass. The worker imports a bounded authority prefix, translates its original record hashes, and commits events and fulfilled intents atomically. Explicit `/pr-reporting on` resets scheduling through one resume marker. Unchanged capture inputs skip the history read until the hourly metadata refresh. Queued batches still go out when capture fails. Verification and upload reject redirects and cap response bodies at 64 KiB. Credentials and endpoint are checked after awaited operations and before dispatch. Opt-out from another process cancels an active upload through state-file stat polling; consent is also reread before a batch is frozen, sent or acknowledged.

Repository lookups share the capture budget. A found identity is kept for a day, and so is a repository without a GitHub or GitLab identity. Other failed lookups wait at least 30 seconds before retry. Unchecked repositories go first, and each pass reserves time to queue the repositories it already knows. A slow or unavailable provider does not discard that progress.

Failed attempts retain their payload and retry time. Event failures retain their local error with the batch until a matching acknowledgement; older retry notes without an error show a generic failure.

- Transient: timeouts, network errors, HTTP 408, 429 and 5xx. A `Retry-After` is honored between 30 seconds and six hours. Without one, the wait doubles from 30 seconds to 30 minutes with ±20% jitter.
- Rejection that retrying cannot fix, such as HTTP 404 from a backend without this endpoint: one hour, doubling to six hours, with ±20% jitter. HTTP 403 means the API key may not upload; `/pr-reporting status` says that an Owner or Member role is needed.

The reason appears in `/pr-reporting status` until an upload is accepted. An unavailable or older backend therefore leaves a visible pending report. Nothing is sent to a different account to clear that queue.

## Health metrics

The existing telemetry setting controls these metrics separately from `/pr-reporting`. They use the normal telemetry flush; there is no extra history scan or model call.

- `kimchi.pr_cost.matching.count` counts one final outcome per input: `explicit`, `inferred`, `session`, `unknown`, `limited` (too much history to compare) or `failed`.
- `kimchi.pr_cost.delivery.count` counts event batch uploads after account verification: `success`, `failed` or `canceled`.
- `kimchi.pr_cost.pricing.unpriced` records the unpriced request count from the latest local cost report.
- `kimchi.pr_cost.reconciliation.age` records seconds since the worker last started a scan. It measures liveness, not lookup success.

Only `client=pi` and the fixed outcome appear as labels. The metrics add no session, user, work, request, repository or PR identifiers. Turning telemetry off drops buffered health counts and stops retries; turning it back on starts a new counter stream. An already dispatched request cannot be recalled.

`kimchi config telemetry off` changes a local consent version in the config file. A quick `off` then `on` from another terminal also discards older health batches, even when the running session did not check settings while telemetry was off. This version stays local and is not sent as a metric label.

Counters are cumulative within their OTLP start time; gauges describe the latest observed state and can decrease. Repeated exports must keep the latest value for that stream. Backend health queries use raw samples rather than session-based productivity rollups. These metrics help find missing prices and stuck delivery; they do not establish matching accuracy or change any PR total.

## Validation scope

Colocated tests cover fork target IDs, refresh of old PR links, source validation, exact billing IDs, privacy, missing prices, inferred and cross-repository allocation, consent, account changes, restart, lost and invalid acknowledgements, retries, sessions that never upload, response limits and shutdown. HTTP tests use local fixtures; they do not establish that a shared backend deployment is available.
