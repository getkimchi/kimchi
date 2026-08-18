# Startup Environment Snapshot

Every workspace-capable Kimchi agent receives a compact, immutable, KV-cache-friendly
**Startup Environment Snapshot** appended as the final section of its system prompt.
The snapshot gives the agent immediate structural awareness of its working directory
and the relevant toolchain versions without requiring tool calls on turn one.

## Purpose

The snapshot solves the cold-start problem: an agent spawned into a new workspace
has no idea what files exist, what the enclosing Git root is, or which tool versions
are installed. Historically the agent spent its first turn running `ls`, `git`,
and version probes. The snapshot front-loads this structural context into the system
prompt so the first model turn is productive.

## Agent coverage

| Agent path | Receives snapshot? | Cache key (contextId) |
| --- | --- | --- |
| Main / orchestrator (single-model) | yes | `sessionId` |
| Subagent — replace mode | yes | child session ID |
| Subagent — append mode | yes | child session ID |
| Ferment planner (main path) | yes | `sessionId` |
| Ferment worker / grader (`spawnGraderAgent` → agent runner) | yes | child session ID |
| Ferment judge / classifier (`judge.js`) | no | Tool-less direct API calls — no prompt path |

The snapshot is wired in two places:

1. **Main path** — `src/extensions/prompt-construction/prompt-enrichment.ts`:
   primes collection at `session_start`, awaits in `before_agent_start`, appends as
   the final section after `appendSystemPrompt` content, clears context at
   `session_shutdown`.
2. **Subagent path** — `src/extensions/agents/manager/agent-runner.ts`:
   uses the newly created child session ID as its context ID, primes immediately,
   awaits before the first `buildSystemPrompt` call, populates
   `extras.environmentSnapshot`, clears context in the `finally` block.

Both `buildAgentPrompt` modes (replace and append) wrap the final result with
`withEnvironmentSnapshot()`, which defensively strips any inherited parent block
before appending the fresh snapshot as the final section.

## Per-context freshness + immutability

- **Freshness**: Each logical agent context performs its own collection. The main
  session and subagents use their own session IDs. Two
  concurrent subagents sharing the parent's cwd each get a fresh collection.
- **Immutability**: Within one agent context the snapshot bytes are identical across
  all turns. The cached promise is awaited on every `before_agent_start`, returning
  the same resolved bytes. In-process resume (`resumeAgent`) reuses the existing
  system prompt — no rebuild, identical bytes.
- **Cache key**: `contextId + normalized cwd` (NOT top-level sessionId). This means a
  parent and child sharing the same cwd have distinct cache entries.
- **Persistence**: The exact generated block is stored in an extension-owned session
  entry that is not sent to the model as a message. Reopening a persisted main or
  child session restores those original bytes instead of scanning again.

## Fact sections (default tier)

Beyond working directory, enclosing Git root, markers, ecosystems, tool versions,
recent commits, and the project map, the snapshot includes at the default tier:

- **Git status** — current branch, changed-file count, ahead/behind vs upstream,
  from `git status --porcelain=v2 --branch` (machine format only; no diffs and no
  per-file working-tree detail are ever collected).
- **System** — OS name (`/etc/os-release` or `macOS`/`Windows`), arch, kernel, CPU
  count and RAM (cgroup-limit-aware, so containers report what the session actually
  sees), free disk on the working-directory mount, container detection
  (`/.dockerenv`, `/run/.containerenv`), and root/non-root user. Collected from
  node:os and fixed system files — no child processes.
- **CLI tools** — presence/version of ecosystem-independent utilities (curl, wget,
  jq, sqlite3, tar, OpenSSL, tmux, ffmpeg, Docker, Podman, qemu-img, 7-Zip,
  tesseract, objdump, QEMU, ImageMagick, socat). Only present tools are listed; the
  `full` verbosity tier also lists utilities unavailable on PATH.

## Verbosity tiers

`KIMCHI_ENV_SNAPSHOT` selects the detail tier: unset/`1`/`true` → `default`,
`minimal` renders only the original sections (no Git status, System, CLI tools,
or sparse depth expansion), `full` additionally lists unavailable CLI utilities.
`0`/`false`/`no`/`off` disable the block entirely.

## Map boundaries

| Boundary | Value |
| --- | --- |
| Max traversal depth | 2 (cwd + one level of subdirs); 3 for sparse workspaces (≤40 entries at depth 2) |
| Max rendered tree entries | 200 (truncated with best-effort totals) |
| Max block size | 12 KiB |
| Per-value output cap | 256 UTF-8 bytes |
| Never traverses beyond cwd | yes |
| Never follows symlinks | yes (symlink visible as name, target not disclosed) |
| Excluded heavy directories | `node_modules`, `.git`, `dist`, `build`, `target`, `vendor`, `.venv`, etc. |

## Git-ignore filtering

The tree respects repository and global Git ignore rules. Git-ignored paths stay hidden **except** encountered
`.env`, `.env.*`, and `.envrc` files, which are retained with a softened marker
(visibility without contents). Other sensitive-looking names, including private keys
and credential files, do not receive this exception. If `git check-ignore` cannot be
verified, uncertain entries are omitted rather than potentially exposing ignored paths.

### `.env` exception

- `.env`, `.env.*`, `.envrc` encountered at depth ≤ 2 are retained with a softened
  marker indicating their presence (no contents disclosed).
- No deeper `.env` search is performed — only files naturally encountered during the
  bounded depth-2 traversal.

## Content boundaries — what NEVER appears

The snapshot contains **no**:

- File contents (only names + tree structure)
- Manifest contents (`package.json`, `Cargo.toml`, etc.)
- Environment variables or secret values
- File mtimes or inode metadata
- Process state (PID, memory, etc.)
- Git diffs, hunks, or human-format status output (porcelain-v2 branch/change count only)
- System package manager queries (`apt`, `brew`, `pacman`, etc.)

## Allowlisted version probes

General working-tool probes run for every snapshot:

| Probe | Command | Stable fact? |
| --- | --- | --- |
| Git | `git --version` | cached while its fixed args and minimal environment match |
| ripgrep | `rg --version` | cached while its fixed args and minimal environment match |
| Active shell | `$SHELL --version` | cached while its fixed args and minimal environment match |

The collector additionally selects fixed version probes from filenames encountered
in the bounded map. Examples include Node and the matching JavaScript package
manager, Python and its matching environment/package tool, Rust/Cargo, Go,
Java/Maven/Gradle, C/C++ compilers and matching build tools, .NET, Ruby, PHP,
Swift, and Elixir. Project wrappers such as `gradlew` are never executed.

Probes run in priority order: the universal core first (Git, ripgrep, active
shell, then the CLI utilities), then ecosystem-specific version probes, and
finally — in marker-less workspaces only — the generic fallback toolbox
(Python (`python3` plus the `python` alias), pip, GCC, Make, Node, Rscript).
Within the ecosystem batch, `pip3` is always requested last because it carries a
longer per-probe timeout (see below); every other probe keeps its relative order.
The four-process concurrency ceiling is shared across concurrent agent-context
collections. A context waiting for a probe slot still observes its own
1500 ms collection deadline.

Absent executables are resolved without process spawns: before probing, the
collector lists each PATH directory of the probe environment once, and any bare
command name missing from every directory resolves to `unavailable on PATH` —
the same fact an exec `ENOENT` would produce. On minimal containers this saves
~one spawn per absent tool, which previously consumed most of the collection
budget. The pre-scan is degrade-safe: any failure (absent/empty PATH, an
unreadable or removed directory) disables it entirely and probing falls back to
exec-per-probe; a partial scan never fabricates absence facts. Scan-derived
negatives are fresh per collection and are never written to the stable-fact
cache, so a tool installed mid-session is discovered by the next agent context.

**pip resolves from packaging metadata before it resolves from exec.** `pip
--version` is a cold Python-interpreter startup plus a heavy import, so on 1-CPU
containers its wall time straddles the default per-probe timeout and the probe is
killed in a large share of collections. The version it would print is already in
the `pip-<version>.dist-info` directory name, so the collector reads it from disk
instead: adjacent to the directory holding the **first `pip3` on PATH**, it lists
`<prefix>/lib/pythonX.Y/{site-packages,dist-packages}/` (Debian system Python
uses `dist-packages`; venvs and Homebrew use `site-packages`) with names-only
`readdir` calls — no file contents, no `stat`, no spawned process. The fact
renders exactly like an exec-derived one; there is no provenance annotation.

The fast path is deliberately conservative and falls through to `pip3 --version`
whenever it cannot be certain: only the first `pip3` PATH directory is consulted
(the `python3` command may be a different interpreter entirely), a version is
used only when every valid adjacent match agrees on exactly **one** version
(duplicates corroborate; multiple distinct versions are ambiguous and never
resolved by taking the maximum), layouts retaining more than 8 Python runtime
directories are treated as ambiguous, and a degraded PATH pre-scan skips the fast
path entirely. Free-threaded runtimes count as candidates: since CPython 3.13
they occupy a `t`-suffixed tree (`lib/python3.13t/`), so a prefix holding both
builds is correctly seen as disagreeing rather than looking unanimous from only
the GIL build's metadata. Unreadable candidate directories are isolated so one missing
optional path cannot erase a valid result found elsewhere. Collections that do
not probe pip at all (JavaScript-only projects) perform no extra filesystem
reads. When prompt debugging is enabled, `distInfoResolvedCount` reports how many
probes were answered this way.

**Per-user installs invalidate the prefix answer.** The per-user site directory
precedes the prefix on `sys.path`, so `apt install python3-pip` followed by `pip
install --user -U pip` leaves the distro metadata in place while the launcher
actually reports the newer per-user version. After the prefix yields a single
version, the collector therefore also lists `$PYTHONUSERBASE/lib` (default
`~/.local/lib`) and falls through to exec if it names any *different* version.
The per-user root can only ever **invalidate** an answer, never supply one: a
shim `pip3` whose own prefix holds no metadata cannot be shown to target that
userbase. This check is skipped inside a venv — a `pyvenv.cfg` beside the
launcher's prefix means `site.ENABLE_USER_SITE` is false and the per-user
directory is not importable, so a stale userbase must not cost the fast path.

Two consequences worth knowing when reading local diagnostics:

- **The fast path effectively never engages on Homebrew/macOS.** Homebrew keeps
  every installed runtime under one prefix (`/opt/homebrew/lib/python3.12`,
  `python3.13`, `python3.14`, …), so their differing pip versions read as
  ambiguous and exec answers instead. That is by design — the optimization
  targets single-runtime Linux containers — but it means a local
  `distInfoResolvedCount: 0` is expected, not a regression.
- **Pre-release versions resolve more precisely than exec does.** A
  `pip-24.0b1.dist-info` name yields `24.0b1`, whereas the generic banner
  pattern cannot express a pre-release and would drop the fact entirely. The
  directory name is authoritative here, so it is preferred rather than truncated
  to `24.0`.

**No OS package-manager probes.** Probes use fixed direct command args, a neutral
temporary cwd, and a minimal environment. Max 4 probes run concurrently. Versions
are normalized (strips `v` prefix: `v22.18.0` → `22.18.0`). Tools whose banners lead
with another component's version use banner-specific extraction (`go version go1.22.5`
→ `1.22.5`; Elixir/Mix banners skip the Erlang/OTP erts version).

## 1500 ms ceiling + silent fallback

- **Cold-prompt ceiling**: 1500 ms. Collection is bounded by per-probe (350 ms)
  and global timeouts.
- **Per-probe timeout override**: an individual probe may request a longer slot
  than the 350 ms default. Today `pip3` is the only exception, at 900 ms
  (≈2.6× the default), covering the cold interpreter start on the collections
  where the metadata fast path above cannot answer. Overrides are always clamped
  by the remaining global budget, so the 1500 ms ceiling still wins, and `pip3`
  runs last in its batch so its longer slot cannot delay another probe.
- **Silent failure**: If collection fails before producing useful facts, the snapshot
  block is omitted. If the deadline expires after workspace facts were collected,
  those completed facts are preserved and unfinished probes are omitted.
- **Error resilience**: Collection failures never crash prompt construction or abort
  a subagent spawn.

## Opt-out

Set `KIMCHI_ENV_SNAPSHOT=0` to remove the block from every covered agent mode
(main, subagent replace, subagent append). The service returns `undefined` and
`withEnvironmentSnapshot` strips any inherited block, appending nothing.

```sh
export KIMCHI_ENV_SNAPSHOT=0
```

`false`, `no`, and `off` are accepted as equivalent values. See [Verbosity tiers](#verbosity-tiers)
for the `minimal`/`full` detail levels.

## Export / debug persistence

The snapshot remains verbatim in effective-system-prompt exports, subagent exports,
and prompt-debug files, so those artifacts contain bounded filenames and version
facts. When prompt debugging is enabled, Kimchi also emits aggregate collection
diagnostics: duration, cache hit/miss state, timeout state, entry/probe counts, and
rendered bytes. Diagnostics exclude paths, filenames, versions, command output, and
environment values.

## Implementation

- **Collector**: `src/extensions/prompt-construction/environment-snapshot.ts`
- **Main wiring**: `src/extensions/prompt-construction/prompt-enrichment.ts`
- **Subagent wiring**: `src/extensions/agents/manager/agent-runner.ts` +
  `src/extensions/agents/prompt/prompts.ts`
- **Tests**:
  - `src/extensions/prompt-construction/environment-snapshot.test.ts` (collector unit tests)
  - `src/extensions/prompt-construction/prompt-enrichment.test.ts` (main path)
  - `src/extensions/agents/prompt/prompts.test.ts` (replace + append modes)
  - `src/extensions/agents/manager/agent-runner.test.ts` (subagent path)
  - `src/extensions/ferment/environment-snapshot-coverage.test.ts` (Ferment coverage)
  - `tests/e2e/tui/environment-snapshot.test.ts` (TUI E2E workflow)
