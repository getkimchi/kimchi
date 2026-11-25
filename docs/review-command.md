# `/review`, manifests, and headless panel protocol

`src/extensions/review-command/` connects the target resolver, reviewer runner,
and panel coordinator to TUI, ACP, and print JSON sessions. All three entry
points use the same stage 2–4 workflow. ACP advertises `/review`; bare input
returns the explicit target syntax because protocol clients have no required
review-target picker. The TUI offers Working tree and Branch using stage 2's
preselection and base suggestions.

```text
/review working-tree [--lens <id>] [--all] [--concurrency <n>] [--fetch]
/review branch <ref> --base <ref> [--include-working-tree] [panel options] [--fetch]
```

The adapter shows the immutable base/head, selected lenses and policy reasons,
effective slot count, per-lens progress, final findings, and complete or partial
coverage. Report and contract artifacts use `.kimchi/review-context` and
`.kimchi/review-output` by default, outside reviewer worktrees. Startup sweeps
reclaim private snapshot refs and worktree runs older than 24 hours; normal
cleanup uses the owning runner's finalization path.

Fresh local runs are isolated in `.kimchi/review-output/runs/<timestamp>-<uuid>/`,
with the concrete run directory shown in the report. One active lock per checkout
rejects concurrent invocations. A lock records the owner hostname and process
start identity (`/proc/<pid>/stat` on Linux, `ps lstart` elsewhere). It is
reclaimed only on the same host when the PID is dead or that identity differs.
Foreign-host locks and locks whose identity cannot be established are preserved
with a diagnostic naming the file and explicit manual-removal guidance. Command
completion resolves only after the persistent lock is released. Durable local
runs and their artifacts are **not** automatically deleted. Both the output root
and `runs/` use stage 1's directory safety validation before any creation;
symlinked output roots and `runs/` components are rejected, and subsequent paths
use their canonical locations. The effective context/output directories are excluded exactly from
working-tree discovery when they are inside the checkout, so generated manifests,
findings, summaries, run state, and lock files cannot appear as changes in a later
review. Kimchi never treats lookalike sibling directories as owned state.

Escape and Ctrl+C cancel a TUI review. ACP `session/cancel` and session shutdown
use the same active controller. Its signal reaches every reviewer, verifier,
shared check, and focused command. Cancellation stops queued launches, grants a
one-second submission window and bounded cleanup, finalizes saved candidates as
partial coverage, removes owned worktrees and the snapshot ref, and only then
returns. ACP releases the prompt with `stopReason: "cancelled"`; TUI displays the
partial result before returning control.

Plan/read-only sessions retain full in-context review capability. The three
submit tools and `submit_reconciliation` write coordinator-owned output (or returns
structured results) and are accepted specially by the worker permission gate;
they do not create or modify worktree source files or run scripts. `run_review_*`,
`bash`, and ordinary `write`/`edit` remain denied in Plan mode. In particular,
Plan does not suppress findings or summaries behind ordinary approval prompts.

## Trusted settings

An optional `review` object in Pi's merged, trust-gated user or project settings
configures the panel. No file in the reviewed tree is read as policy. The
smallest shape is:

```json
{
  "review": {
    "requiredLenses": [
      { "id": "security", "reason": "Required for authentication changes." }
    ],
    "checks": [
      { "id": "test", "kind": "test", "command": "pnpm test" }
    ]
  }
}
```

`requiredLenses` IDs must be registered lenses and reasons must be trimmed,
non-empty, and NUL-free. Checks require `id`, `kind` (`build`, `test`, or `other`), and `command`.
Optional fields are `cwd` (default `.`), `builds` (default `false`), `toolchain`
(default `unspecified`), and `dependencies` (default `[]`). IDs, commands,
working directories, and dependency paths are trimmed, non-empty, and NUL-free.
IDs are unique and contain only letters, digits, underscores, and hyphens. These are trusted
routine commands; reviewers request them by ID and share saved evidence.

## `review-manifest/v1`

The platform's headless reviewer writes
`review-context/manifest.json`; Kimchi only reads it. Every manifest contains
exactly these fields, with no grace, lens, or concurrency extras:

- `schema_version`: exactly `review-manifest/v1`.
- `base_sha`, `head_sha`: full lowercase 40- or 64-hex commit IDs.
- `checkout_path`, `context_dir`, `output_dir`: non-empty absolute paths.
- `deadline`: an absolute UTC RFC 3339 timestamp ending in `Z`, with a real
  calendar date and time. Numeric offsets and local-time forms are invalid.

Missing or additional fields, wrong types or schema, invalid deadlines, and
subdirectory checkout paths are rejected. Kimchi canonicalizes the checkout
root, resolves both commit IDs in that checkout, and verifies `base_sha` is the
checkout merge base of `head_sha`. The anchor map must identify the same
comparison to be used as provider evidence; otherwise the normalized target
uses local anchors and records the standard limitation. The shared v1 fixture
contains a manifest matching its provider SHAs plus normative `child_usage` and
startup examples.

## Print JSON invocation

The explicit panel entry uses the existing flags and positional input:

```sh
kimchi -p --mode json --review --review-writer final \
  --review-context-dir /home/sandbox/review-context \
  --review-output-dir /home/sandbox/review-output \
  '/review --manifest /home/sandbox/review-context/manifest.json'
```

`--lens`, repeated `--lens`, `--all`, and `--concurrency` compose with
`--manifest`; local target options do not. Manifest directories must exactly
match the context/output flag directories and the writer must be `final`.
Manifest startup explicitly passes `executionPolicy: { mode: "headless" }`.
The staged submit tools must already appear in the initial system message.
The coordinator launches no top-level model turn: the stream begins with the
session header and initial system message, then emits only applicable extension
events and final `agent_settled`. Worktree creation and manifest validation are
never reported as `tool_execution_*` events. Child assistant messages stay in
child sessions, not the top-level stream. The protocol input is persisted
synchronously through SessionManager's user-message boundary so the root
session remains recoverable after a hard kill, but this write is not itself a
model turn or a JSON event.

A resumed invocation is:

```sh
kimchi -p --mode json --session <id> --review --review-writer final \
  --review-context-dir /home/sandbox/review-context \
  --review-output-dir /home/sandbox/review-output \
  '/review wrap-up'
```

Wrap-up is accepted only after a `resume` session start. The new manifest must
match the saved panel's base/head, canonical checkout, context, and output
identity. Its new deadline supersedes the saved deadline. No reviewer is
restarted. Saved candidates and routine-check evidence are reused, a missing
summary is recovered, and repeated finalization preserves final IDs and counts.

Fresh panel startup validates the manifest before the stage 4 coordinator
atomically creates an empty `findings/final.jsonl`; only then can any reviewer
launch. Existing interrupted checkpoints are not truncated during wrap-up.

## `child_usage`

The panel's differential usage buffer synchronously enqueues JSON events shaped
as:

```json
{
  "type": "child_usage",
  "writer": "security",
  "provider": "actual-provider",
  "model": "actual-model-id",
  "usage": { "input": 100, "output": 25, "cacheRead": 4, "cacheWrite": 0 },
  "parentToolCallId": "optional-parent-tool-call-id"
}
```

Events are delta usage aggregated per child writer and **actual** provider/model
pair. Reconciliation uses the same mechanism with writer `reconciliation`.
Normal flushes occur at reconciliation reserve, finalization, and cleanup;
TERM also triggers reserve/final flushes. Stage 4's subscription and flushed
ledgers prevent double counting. A callback at the deadline that cannot be
synchronously enqueued is dropped and reported rather than awaited.

## TERM, process groups, and resource limits

The platform sends TERM at the manifest deadline and KILL 60 seconds later.
Only an active print review replaces upstream's immediate TERM disposal. It
aborts the coordinator, continues forwarding submit/usage events, finalizes
from durable candidates, emits `agent_settled`, and returns through the normal
print host with exit code 143. The last-resort exit watchdog fires at deadline
+ 60 s − 3 s, after flushing extension output; production grace is fixed at 60
seconds. Other print sessions retain upstream TERM behavior exactly. Aborted
runner cleanup is capped by the earlier of the manifest deadline and one
post-abort settlement second. Message-boundary session persistence and atomic
review artifacts remain available for `--session` recovery after a hard kill.

All panel child commands share one process-scoped execution slot per headless
output root. This covers focused checks, shared routine checks, and reviewer
Bash calls, so a second command waits or consumes saved evidence while file
reads remain independent. Commands inherit Kimchi's process group; no review
runner uses `setsid` or detached spawning. TERM therefore reaches reviewers and
their commands, and the platform's later KILL stops remaining in-flight work.

When the sandbox supplies `GOTOOLCHAIN=local`, `CARGO_NET_OFFLINE=true`, or
`GOPROXY`, the coordinator merges the blocked toolchain downloads, uncached
registry fetches, and constrained module retrieval into structured
`environment_gaps` alongside reviewer reports. It never copies proxy values or
credentials. These sandbox failures are coverage evidence, not declined local approvals. Kimchi
does not add local offline settings or prompts in explicitly headless mode.
