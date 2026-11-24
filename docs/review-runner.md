# Reviewer worktrees, execution policy, and shared checks

`src/extensions/review-runner/` is the coordinator-facing library for a review
panel. It consumes a stage 2 `ResolvedReviewTarget`; it does not register a
`/review` command, select lenses, or reconcile findings.

## Review API

```ts
const runner = await ReviewRunner.create({
  ctx,                 // invoking session
  pi,                  // invoking session's ExtensionAPI
  target,              // stage 2 target and snapshot cleanup
  outputDir,           // stage 1 review output
  concurrency: 2,
  checkDefinitions,    // trusted coordinator-supplied routines
  executionPolicy: {
    // Optional explicit coordinator override. Normally omit this and let
    // isInSandboxCluster() choose local vs headless execution.
    mode: "local",
  },
  signal,
})

const result = await runner.spawnReviewer({
  id: "adversarial",
  type: "General-Purpose",
  prompt,
  signal,
  agent: { maxTurns: 30, maxDuration: 900 },
})
```

Core signatures:

```ts
ReviewRunner.create(options: ReviewRunnerOptions): Promise<ReviewRunner>
runner.spawnReviewer(options: SpawnReviewerOptions): Promise<ReviewAgentResult>
runner.spawnVerifier(options: SpawnReviewerOptions): Promise<ReviewAgentResult>
runner.cancelReviewer(id: string, reason?: unknown): boolean
runner.cancelActiveReviewers(reason?: unknown): void
runner.beginWrapUp(): void
runner.cleanup(): Promise<void>

ReviewCheckQueue.create(options: ReviewCheckQueueOptions): Promise<ReviewCheckQueue>
queue.request(request: ReviewCheckRequest): Promise<ReviewCheckResult>
queue.beginWrapUp(): void
queue.cancel(reason?: unknown): void
queue.idle(): Promise<void>

createReviewWorktreePool(options: ReviewWorktreeOptions): Promise<ReviewWorktreePool>
recoverReviewWorktrees(options: RecoverReviewWorktreesOptions): Promise<RecoveredReviewWorktrees[]>
detectReviewNetworkBoundary(): Promise<ReviewNetworkBoundary | undefined>
```

`ReviewAgentResult` includes the ordinary `RunResult`, writer ID, worktree, and
execution controller. Worktrees include private scratch/HOME/build/cache paths.
Reviewer leases are bounded by `concurrency`; setup/removal is serialized per
repository. The dedicated check worktree does not consume a reviewer slot.
Base and head checks use separate worktrees and evidence keys.

## Writer identity and child initialization

The process entry point still reads `--review-writer`, defaulting to `final`.
Each panel child instead receives an immutable closure through
`createReviewSubmitExtension({ writer, writerLimit, contextDir, outputDir })`.
All three submit tools capture that object. Concurrent children never consult
process-level writer state or an environment variable.

The internal spawn path forwards each worktree cwd, cancellation signal,
execution policy, extra inline tools, and `isolateProjectConfiguration`. Child
initialization uses `createSubagentSettingsManager` **before** creating the
resource loader:

- the settings manager is rooted in the invoking session's configuration cwd;
- that exact manager is passed to `SubagentResourceLoader` and the session;
- an isolated child uses `skipPackageResolution`, explicitly replacing the
  package manager's `resolve()` step with an empty resource set. Raw global or
  project package lists (including invoking-user `npmCommand` values) therefore
  never run during child initialization. This is an explicit loader bypass,
  not a merged `getSettings()` override; reviewed-checkout settings remain out
  of the loader as well;
- instructions, skills, hooks, MCP/project settings, and discovered extensions
  come only from selected inline review resources, never the review checkout.

The worker permission gate re-reads the invoking session's effective mode,
rules, trusted configuration, and organization policy on every ordinary call.
Deny rules and plan/read-only mode precede review pre-approvals.

## Routine check definitions

`checkDefinitions` is the trusted input. Stage 4/5 should populate it from the
invoking session's settings or a trusted manifest. The library does **not** read
review-policy files such as `.kimchi/review-checks.json` from the reviewed tree.

An injected definition has:

```ts
{
  id: string
  kind: "build" | "test" | "other"
  command: string
  cwd: string
  builds: boolean
  toolchain: string
  dependencies: string[]
}
```

`builds: true` on an injected test/other definition means a passing run also
satisfies build verification. A failed, blocked, or cancelled run proves no
successful build.

With no injected definitions, the coordinator discovers unambiguous
`package.json` `build` and `test` routines from the pinned head as a convenience.
Every result marks `definitionSource` as `coordinator` or `reviewed-tree`, so the
report cannot mistake this discovery for trusted policy. Discovered checks run
reviewed code, as expected for tests. `builds` is inferred only for an exact
 two-segment `<package manager> run build && <test>` script. `pretest`, matching
substrings, and other lifecycle implications never set `builds`.

## Shared routine check behavior

`run_review_check({ id, revision?, online? })` requests a routine check. The
queue executes requested commands in order in its dedicated pinned worktree.
Concurrent identical requests join one command; completed results, including
failures and cancelled/blocked runs, are reused without automatic retry.

Each caller's **actual command string** passes the inherited Bash policy helper
before execution, before online approval, and before reading saved evidence.
This covers deny rules, compound-command rules, hard blocks, and plan/read-only
mode. Wrapper pre-approval never substitutes for this check.

Result keys contain:

- pinned Git tree (base and head differ);
- command and repository-relative cwd;
- toolchain and pinned dependency-input digest;
- offline, approved-online, or sandbox execution profile.

An approved online retry or dependency/toolchain change produces a new key.
Saved evidence includes command/cwd/worktree, exit code, elapsed milliseconds,
bounded last 32 KiB of output, approval/network mode, completion timestamp,
source, and build status. It is written atomically to
`outputDir/state/routine-checks.json`.

Command evidence is shared by key, but `id`, `kind`, and `satisfiesBuild` are
always projected from the current requesting definition. Different definitions
with the same command retain correct semantics in either request order, and
same-ID resumes immediately honor a current `builds` decision changing in
either direction instead of retaining the first saved value.
`beginWrapUp()` permits saved reads only; it is checked both when a request is
accepted and immediately before a queued entry creates its worktree.

`run_review_command` handles focused reviewer-authored tests and private
base-revision comparisons. A head-revision command matching a routine definition
is redirected to the shared queue instead.

## Local execution: contained offline by default

Print output mode and ACP transport are **not** sandbox signals. Local behavior
fails closed. Automatic `headless` selection occurs only through
`isInSandboxCluster()`. A coordinator may explicitly inject `mode: "headless"`
for a sandboxed invocation; tests may inject mode, command authorization, and a
network boundary through `ReviewExecutionPolicyOptions`.

### Actual network containment

Every local offline command is enclosed before execution:

- **macOS:** `sandbox-exec` with `(allow default)` for ordinary process/file
  operations plus `(deny network-outbound)`. This denies remote and loopback
  TCP and outbound Unix-domain socket `connect()` calls, including package
  downloads from a local HTTP server and local daemon connections.
- **Linux:** `unshare --net --map-root-user` where usable without root, or
  `bwrap --unshare-net` when `unshare` is unavailable. The new network namespace
  has no usable external network interfaces.

A check that needs local IPC—such as a Docker socket, a local database, or a
loopback HTTP server—cannot use the offline boundary and must request an
approved online run. Containers commonly used for CI and development do not
permit unprivileged user namespaces; when neither Linux mechanism is available
(or `sandbox-exec` is unavailable on macOS), no boundary is available.

Availability is probed once. If no boundary works, an ordinary local command is
**not** run under an unenforced label. It instead needs the same online approval
as an install. That approval explicitly says offline access cannot be enforced.
Declined/unavailable approval yields `status: "blocked"`, `network:
"unenforced"`, and zero command execution. `network: "offline"` is recorded only
when the command really ran inside a named boundary (`sandbox-exec`,
`unshare-net`, or `bwrap`).

### Narrow environment allowlist

Offline subprocesses receive no general parent-environment clone. Settings are
allowlisted: `PATH`, `LANG`/`LC_*`, `TERM`, required Windows launch variables,
selected runtime-toolchain inputs, and the private worktree variables.
`HOME`/`XDG`/TMP and per-tool caches stay private (npm/pnpm/Yarn/Corepack, Go,
pip/uv/Poetry, Cargo, Gradle, Composer, Bundler, and Deno).

Registry/index/proxy/auth variables, arbitrary `*_OPTS`, and other credentials
are omitted. `NPM_CONFIG_USERCONFIG` and `NPM_CONFIG_GLOBALCONFIG` select
**separate private empty files**, `NPM_CONFIG_REGISTRY` uses the public default,
and package-manager update prompts are disabled.

Environment flags are defense in depth, not the network boundary. They include:

| Ecosystem | Settings |
| --- | --- |
| npm / pnpm | npm offline settings; zero fetch retries and bounded fetch timeout |
| Yarn | `YARN_ENABLE_NETWORK=0` |
| Bun | `BUN_CONFIG_OFFLINE=true` and npm-compatible offline settings |
| Go | `GOPROXY=off`, `GOTOOLCHAIN=local`, `GOFLAGS` with `-mod=mod` |
| pip | `PIP_NO_INDEX=1`, version-check disabled |
| uv | `UV_OFFLINE=1`, `UV_NO_INDEX=1` |
| Cargo | `CARGO_NET_OFFLINE=true` |
| Composer | `COMPOSER_DISABLE_NETWORK=1` |
| Bundler | `BUNDLE_ALLOW_OFFLINE_INSTALL=true`, version-check disabled |
| Deno | `DENO_CACHED_ONLY=1` |

A script that overrides these variables still reaches the OS boundary and fails
without installing or making a request.

### Direct installs and online retries

Direct local dependency/toolchain mutations always need approval, including
`yolo`. Shell-aware detection uses `shell-quote`, consistent with Bash permission
parsing, and covers:

- install/add/ci/exec commands for npm, pnpm, Yarn, Bun and package runners;
- Corepack's own `prepare`, `use`, `install`, `up`, `enable`, and `pack`
  operations, versioned `corepack <pm>@<version>` forms, and forwarding;
  `npm exec`, `pnpm exec`, `dlx`, `npx`, and `bunx` only as the actual
  package-manager subcommand after global options (never script arguments);
- combined shell flags such as `bash -lc`, `sh -ec`, and `zsh -c`;
- `eval`, assignments, `env`/`command`/`nohup`/`time`/`timeout`/`xargs` wrappers;
- command substitution and subshells;
- pip/uv/Poetry, Go, Cargo, Bundler, Composer, and common system managers.

Repository scripts are not direct installs merely because their scripts install.
Those scripts first run inside the offline boundary. After an exact command
fails offline, `online: true` asks for one approval for that intended check and
worktree. Shared checks join at most one approval for the shared run, not one per
reviewer. Approved retries have distinct evidence with
`network: "approved-online"`.

The gate-to-execution handoff uses single-use grants carrying the tool-call ID,
tool name, exact command, and approval kind. A grant is consumed atomically
exactly once before execution, is cleared in `finally`, and can never authorize
a changed command, another tool identity, or an unapproved kind. A changed
command or a replay requires fresh approval.

## Headless execution

Only the trusted sandbox signal selects headless execution automatically. It
applies no offline settings and starts no review prompt: the sandbox's effective
permission/network policy decides execution. Sandbox-blocked commands are normal
failed/cancelled evidence with `network: "sandbox"`, never a declined approval.
Local print mode with no reachable approver instead blocks approval-requiring
commands before execution.

## Worktree lifecycle and recovery

Worktrees isolate files/build state only. They share Git object/admin metadata
and are not a general process sandbox; ordinary local permissions and the OS
network boundary provide the execution controls.

The pool writes a `review-worktrees/v1` manifest. A pending entry is persisted
**before** `git worktree add`; ready state follows only after registration and a
second manifest update. Recovery merges that manifest with Git-owned
registrations under the run directory, handles both interruption points, then:

1. removes owned worktrees;
2. clears run contents except the manifest;
3. prunes Git worktree metadata;
4. releases stage 2's snapshot ref;
5. deletes the run directory/manifest.

Normal cleanup uses the same order. A failed worktree removal or failed ref
release keeps the ref pinned and enough state for an idempotent retry. Recovery
never deletes arbitrary paths from an unowned manifest and never changes the
user's checkout, branch, index, or stash.
