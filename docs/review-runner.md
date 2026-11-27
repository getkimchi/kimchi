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
queue acquires the designated ready worktree **before** computing its evidence
key, then executes in that same worktree. It does not rescan caches per key
computation. Legacy saved results without environment evidence never match a
new key. During wrap-up, an absent existing ready worktree/receipt means
saved-only/no-new-work rather than constructing an approximate key.

The queue executes requested commands in order in its dedicated pinned worktree.
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
- offline, approved-online, or sandbox execution profile;
- the concrete worktree's environment schema version, requested-spec digest,
  receipt digest, and readiness.

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

## Trusted prepared review environments

An empty or absent `review.environment` preserves the historical behavior:
every checkout has a private HOME, scratch, build, and cache environment and no
shared dependency cache. Environment settings are read through the real
`SettingsManager.getGlobalSettings()` accessor only. A project
`review.environment` is ignored and records `project_environment_ignored`; it
cannot select host caches/toolchains or preparation commands. No environment is
loaded from the reviewed checkout or its manifests/lockfiles. The generic
engine in `review-runner/environment.ts` has no language/package-manager
detection and no review-panel imports, so other coordinators can reuse it.

**Compatibility boundary:** `review.requiredLenses` and `review.checks` retain
their older global+project effective-settings behavior. Project-level routine
check commands therefore remain a separate trust exposure and may execute
under the existing routine-check authorization/network/filesystem boundary;
only the new environment preparation capability is global-only. This amendment
does not change their selection or command semantics.

The smallest static profile shape is:

```jsonc
{
  "review": {
    "environment": {
      "caches": [
        {
          "id": "shared-artifacts",
          "path": "/canonical/existing/cache-directory",
          "description": "Prepopulated, non-secret build inputs"
        }
      ],
      "toolchains": [
        { "id": "pinned-tools", "bin": ["/canonical/existing/tool/bin"] }
      ],
      "profiles": {
        "default": {
          "readOnlyCaches": ["shared-artifacts"],
          "privateDirs": [
            { "id": "writable", "root": "cache", "path": "writable" }
          ],
          "env": {
            "ARTIFACT_ROOT": "${cache:shared-artifacts}",
            "WRITABLE_ROOT": "${private:writable}",
            "CHECKOUT_ROOT": "${worktree}",
            "TEMP_ROOT": "${scratch}",
            "CUSTOM_MODE": "strict"
          },
          "toolchain": "pinned-tools",
          "setup": [
            {
              "argv": ["tool", "prepare", "--offline"],
              "cwd": ".",
              "timeoutMs": 120000,
              "required": false
            }
          ],
          "probes": [
            {
              "id": "artifacts-usable",
              "argv": ["tool", "check", "--offline"],
              "cwd": ".",
              "timeoutMs": 30000,
              "required": true
            }
          ]
        },
        "repositories": {
          "/canonical/absolute/repository/root": {
            "readOnlyCaches": [],
            "privateDirs": [],
            "env": {},
            "setup": [],
            "probes": []
          }
        }
      }
    }
  }
}
```

An exact canonical repository-root profile **replaces** the default for that
repository; profiles are not merged. Omit `default` when only selected
repositories should have a profile. Catalog/spec IDs, commands, unknown keys,
and sizes are validated strictly. Cache/toolchain directories must exist and
are canonicalized; a final symbolic-link component is rejected. Caches cannot
overlap the source checkout, common Git directory, context/output/run trees,
any concrete worktree, or any private root. Private paths are children of the
chosen `cache`, `build`, or `scratch` root, created mode 0700 without symlink
traversal.

Only `${cache:id}`, `${private:id}`, `${worktree}`, and `${scratch}` substitutions
exist. `PATH` cannot be assigned in `env`; trusted toolchain directories precede
the existing sanitized PATH. Parent-environment interpolation is unsupported.
Setup uses argv arrays, not shell source, and cannot obtain online-install
approval. Its concrete cwd is canonicalized immediately before execution; every
component must be a real directory inside the canonical worktree, never a
symlink or an escape. Per-command timeout is capped at 120 seconds for setup
and 30 seconds for probes, with bounded last-8-KiB output. `required` defaults
to `true`.
Environment assembly is safe isolated defaults, then profile values, then
mandatory offline/no-prompt guarantees. Credential-like names/values (API or
access/private keys, tokens/sessions/cookies/PATs, userinfo-bearing URLs, and
similar inputs) are rejected with typed gaps rather than silently retained.
Original sensitive values are not persisted in requested/effective specs,
receipt environments, digests, or `state/environments.json`. The same value and
aggregate byte limits are enforced again after substitution.

Every reviewer head, focused base comparison, base/head routine-check, and
reconciliation-verifier worktree receives the selected spec. Distinct worktrees
prepare concurrently because only Git registration and manifest transitions
serialize; reviewer preparation observes the existing lease concurrency.
Setup/probes also have a combined 300-second overall limit per worktree, run
before the agent's investigation duration without spending
reconciliation/summary reserve, and use the later commands' boundary. Individual
lease/verifier abort signals reach preparation as well as the agent. Cleanup
aborts and awaits pending preparation.

Preparation execution explicitly cleans up the whole descendant tree. Linux
preparation uses `bwrap --unshare-pid --die-with-parent` when supported. That
support is probed separately from ordinary bwrap, so a PID-namespace failure
does not remove bwrap from lens/check execution. Namespace-less preparation
keeps the best available boundary, uses the portable cleanup below, and records
a `preparation_containment` gap. On
both macOS and Linux, every setup/probe process also inherits a unique random
preparation marker. While the root is alive, PID-file-rooted `ps` polling
retains observed descendants even if they later reparent; after it exits, a
separate `ps eww` scan finds surviving marked processes independently of their
process group or session. Cleanup applies TERM, then KILL, verifies that no
tracked live process remains, and treats inspection or containment failure as
a `preparation_containment` gap with an isolated fallback rather than silent
success. Unverified platforms use the same failure path. (Ordinary reviewer
`run_review_command` still has the older process-group-only cancellation
semantics; this is pre-existing and not broadened here.)

A worktree is not `ready` until its actual receipt is atomically persisted in
mode-0600 `state/environments.json`. Any failed/aborted preparation discards
the entire worktree and creates a fresh tracked-only checkout at a different
unique path. A failed optional step returns that fresh worktree as `degraded`;
a required failure persists `unready` and prevents launch. There is no in-place
reset or reuse of a directory a surviving writer could touch. Pending fallback
paths use the existing pending-manifest/crash-recovery protocol.

Receipts contain requested/effective specs, resolved cache/toolchain identity,
private logical IDs, non-secret env values, bounded setup/probe records,
boundary capabilities, readiness, typed gaps, and non-hermetic shared inputs.
Digests omit timestamps, elapsed times, raw output, and random private/worktree
paths. Shared caches/toolchains remain mutable non-hermetic inputs, not
snapshots or behavioral proof. When a profile applies or gaps exist, each
reviewer/verifier prompt gets a bounded actual-receipt note and an instruction
not to hand-link/download dependencies or use unrelated caches; missing tools
belong in environment gaps. With no profile and no gaps, prompts are
byte-identical to the pre-environment implementation while receipts still
persist. Environment and agent state updates use the review output directory's
shared `proper-lockfile` lock plus atomic rename, and merge existing records
instead of deleting earlier pools' evidence.

### Platform guarantees for selected caches

- **macOS `sandbox-exec`:** selected caches get no write allow. An explicit
  cache-subpath write deny follows every private allow, including Git admin.
- **Linux `bwrap`:** each cache is mounted with `--ro-bind` at its canonical
  path after private writable binds, retaining `--unshare-net`. Preparation
  additionally uses `--unshare-pid --die-with-parent` when the probe confirms
  support, so all setup descendants die with the sandbox init process.
- **Linux `unshare-net`:** no read-only cache or contained setup/probe is
  exposed. The receipt has `environment_unsupported`; only weaker
  network-only/private-env behavior remains.
- **Headless/outer sandbox:** absent explicit network/filesystem/read-only
  attestation, caches are not exposed and setup/probes get typed gaps.
  `sandbox` is not relabelled `offline` or `read-only`.

Network denial includes loopback. Loopback-dependent tests fail as environment
limitations, not as a reason to weaken the boundary.

### Worked Go example (configuration, not an adapter)

Given trusted `go-modules` and `go-host` catalog entries, this profile exposes
only the module cache. Build cache and temp output stay private:

```jsonc
{
  "readOnlyCaches": ["go-modules"],
  "privateDirs": [
    { "id": "go-build", "root": "cache", "path": "go-build" },
    { "id": "go-tmp", "root": "scratch", "path": "go" }
  ],
  "env": {
    "GOMODCACHE": "${cache:go-modules}",
    "GOCACHE": "${private:go-build}",
    "GOTMPDIR": "${private:go-tmp}",
    "GOTOOLCHAIN": "auto",
    "GOPROXY": "off",
    "GOFLAGS": "-mod=readonly",
    "GOENV": "off",
    "GOWORK": "off"
  },
  "toolchain": "go-host",
  "setup": [],
  "probes": [
    {
      "id": "go-offline-test",
      "argv": ["go", "test", "./..."],
      "cwd": ".",
      "timeoutMs": 30000,
      "required": true
    }
  ]
}
```

`GOTOOLCHAIN=auto` can select an already cached newer toolchain while network
access remains denied. The tested configuration needs private writable
`GOCACHE`; a read-only shared user build cache is not equivalent.

### Worked pnpm example (configuration, not an adapter)

Use the project-pinned pnpm 10.8.1 executable through trusted toolchain PATH
and expose its real store whose effective path ends in `v10`. Include required
lifecycle-script executables, such as Bun, in trusted `bin` dirs.

```jsonc
{
  "readOnlyCaches": ["pnpm-v10"],
  "privateDirs": [
    { "id": "corepack", "root": "cache", "path": "corepack" }
  ],
  "env": {
    "PNPM_STORE_PATH": "${cache:pnpm-v10}",
    "COREPACK_HOME": "${private:corepack}",
    "CI": "1"
  },
  "toolchain": "node-and-pnpm-10_8_1",
  "setup": [
    {
      "argv": ["pnpm", "install", "--offline", "--frozen-lockfile"],
      "cwd": ".",
      "timeoutMs": 120000,
      "required": true
    }
  ],
  "probes": [
    {
      "id": "focused-vitest",
      "argv": ["pnpm", "exec", "vitest", "run", "src/components/logo.test.ts"],
      "cwd": ".",
      "timeoutMs": 30000,
      "required": true
    }
  ]
}
```

Another store version, an automatic global pnpm switch, or a path without its
version-directory basename is unproven until its probe passes. Offline install
cannot fetch missing packages.

Cache proposals/approval UI are **out of scope for this PR**. So are an
orchestrator, ignored-file copying, manifest/package-manager cache inference,
and Ferment v2 migration. Headless outer-capability attestation and proposal
UI are follow-up work.

## Local execution: contained offline by default

Print output mode and ACP transport are **not** sandbox signals. Local behavior
fails closed. Automatic `headless` selection occurs only through
`isInSandboxCluster()`. A coordinator may explicitly inject `mode: "headless"`
for a sandboxed invocation; tests may inject mode, command authorization, and a
network boundary through `ReviewExecutionPolicyOptions`.

### Actual network and write containment

Every local offline command is enclosed before execution:

- **macOS:** `sandbox-exec` with `(allow default)` for ordinary process and
  read operations, `(deny network-outbound)`, and `(deny file-write*)` except
  for selected writable subpaths. The network rule denies remote and loopback
  TCP and outbound Unix-domain socket `connect()` calls, including package
  downloads from a local HTTP server and local daemon connections.
- **Linux:** detection first tries `bwrap --unshare-net` with a read-only root
  mount, a writable `/dev/null` device bind for ignored or redirected standard
  I/O, and selected writable binds. No general `/dev` mount is added. If
  `bwrap` is missing or its probe fails, detection tries
  `unshare --net --map-root-user`. Both create a network
  namespace with no usable external interfaces. The `unshare-net` fallback
  confines **network access only**: it does not confine filesystem writes, so
  the checkout, other user files, and shared Git metadata retain their ordinary
  host write permissions. Prefer `bwrap` whenever it works.

The `sandbox-exec` and `bwrap` writable locations are the linked checkout and
its canonical private scratch/build/cache/home directories. One additional
exception supports Git index operations. Immediately after trusted
`git worktree add`, the pool captures the assigned admin directory using one
absolute `git rev-parse --git-dir --git-common-dir` result, canonicalizes it,
and stores it on the worktree and its ready manifest. The boundary never
rediscovers this directory from the checkout at command time.

Before granting the exception, the boundary revalidates only the stored path:
it must canonically remain a direct child of `<common-dir>/worktrees/`, and its
`gitdir` back-link must canonically point at this checkout's `.git` file. A
missing or mismatched assignment drops the exception, leaving no admin
directory writable. Command-time `.git` changes therefore cannot select shared
metadata or another worktree's admin directory. Within `sandbox-exec` and
`bwrap`, shared objects and refs and the main working tree remain read-only;
`git update-index` can refresh its index and lock files, while commands that
write objects or shared refs—including `git add`, `git commit`, and `git
stash`—remain unsupported. The `unshare-net` fallback applies none of these
filesystem restrictions.

A check that needs local IPC—such as a Docker socket, a local database, or a
loopback HTTP server—cannot use an offline boundary and must request an
approved online run. Containers commonly used for CI and development may not
permit unprivileged user namespaces; no Linux boundary is available only when
both `bwrap` and `unshare --net --map-root-user` fail their execution probes.
An unavailable `sandbox-exec` likewise leaves no boundary on macOS.

Availability is probed once per process, in the order described above. If no
boundary works, an ordinary local command is **not** run under an unenforced
label. It instead needs the same online approval
as an install. That approval explicitly says offline access cannot be enforced.
Declined/unavailable approval yields `status: "blocked"`, `network:
"unenforced"`, and zero command execution. `network: "offline"` is recorded only
when the command really ran inside a named boundary (`sandbox-exec`, `bwrap`,
or the weaker `unshare-net` network-only fallback).

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

Headless commands use `reviewInheritedProcessOperations`, an execution adapter
with `detached: false`, for shared checks, focused commands, and reviewer Bash.
They therefore inherit Kimchi's process group, whereas ordinary local commands
retain upstream's detached command-group lifecycle. One cancellation-aware
execution slot is shared per output root across every headless controller, so
routine and focused build/test commands never overlap. Waiting reviewers can
continue file reads or reuse saved check results.

## Worktree lifecycle and recovery

Worktrees isolate files/build state only. They share Git object/admin metadata
and are not a general process sandbox; ordinary local permissions and the OS
network boundary provide the execution controls.

The pool writes a `review-worktrees/v1` manifest. A pending entry is persisted
**before** `git worktree add`; ready state follows only after registration,
environment setup/probes, and the second manifest update that follows durable
receipt persistence. Recovery merges that manifest with Git-owned
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
