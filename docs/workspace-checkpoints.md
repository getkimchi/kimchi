# Workspace checkpoints

Workspace checkpoints preserve source and generated artifacts in a private Git object store outside the project. They exist to recover coding work after interruption or an explicit deadline, not to decide which implementation is best.

## Opt-in

Checkpoints and their tool are disabled unless you run with:

```sh
kimchi --max-session-duration <seconds>
```

No other session configuration changes. Without this option the extension, tool description, lifecycle handlers, and model-visible prompt are unchanged from the base build. Agent-worker sessions never register their own stores; changes from a subagent are captured through the parent's workspace changes.

The feature requires Git and a repository. Other workspaces get a logged unavailable status and otherwise behave unchanged. Nested repositories are ignored.

## Capture model

- The starting workspace is captured once. At most one automatic capture is queued at the end of a dirty turn, after mutating tools settle; unpaired tool termination is reconciled at agent settlement. Captures run off the model/tool request critical path.
- `write-tree` deduplicates unchanged content. An in-memory file-stat fingerprint skips tree and private-index rewrites for truly unchanged turns. Consecutive mutation triggers without an intervening turn may coalesce. A multi-file change is never silently treated as one atomic checkpoint at request time.
- Tracked changes, eligible untracked files, shell edits, and subagent edits are captured. File contents are binary-safe.
- The private index is separate from the project. Project refs, stash, hooks, index, branches, and history are not modified.
- Git metadata, nested repositories, common dependency/build directories, `.env`/`.env.*` files, and untracked files larger than 10 MiB are excluded. Common credential paths such as `.npmrc`, `.netrc`, private keys, and credential JSON files are also excluded. Exclusions are returned in the checkpoint result so a missing required artifact cannot silently masquerade as a successful full capture.
- Per-session state directories are mode `0700` and checkpoint metadata files are mode `0600`. Project Git history is never used as secret-removal storage.
- Capture failures are logged rather than breaking the session. Shutdown waits at most ten seconds for the owning session's pending capture; other sessions' queues and stores remain untouched.
- Hard process death, incomplete in-flight writes, services, databases, networks, and external process state are outside this mechanism's guarantee.

## Candidate operations

`workspace_checkpoint` supports:

- `save` — capture the current state with an optional label and `validated` flag. `validated` records the caller's evidence claim; it is not an independent harness verification or hidden-test verdict.
- `list` — inspect the current session's checkpoint IDs, labels, capture history, and exclusions.
- `restore` — restore an explicitly named checkpoint.

Restore first saves the current workspace as a safety checkpoint. Before changing files, it preflights the affected paths, checks every parent component, and preserves unrelated untracked work. It refuses unsafe symlink targets and writes into `.git`, and rejects targets whose current bytes are not covered by that checkpoint. Cross-workspace and cross-branch restores are rejected. Cancellation is checked before restore starts and between file writes; restoration is not a filesystem transaction. Restoration is always deliberate; there is no automatic "last green" rollback on failure, resume, or cancellation.

## Deadline finalization

When a positive duration is supplied, a single bounded finalization phase starts after the original budget minus `min(10% of budget, 5 minutes)`:

1. Write the current working candidate rather than starting more exploration.
2. Run the strongest practical existing check.
3. Save the candidate and mark `validated` when that evidence supports it.
4. If the latest check regressed, explicitly restore a named earlier candidate.
5. Capture the final state and finish with a concrete result.

The controller does not start work between user turns. It disposes its timers on settlement, shutdown, or cancellation and aborts remaining work at the hard deadline. Its message uses the existing marked followUp mechanism and is persisted before emission. TUI, ACP, and headless runs use the same shared extension.

To compare an experiment against an unchanged base branch, build each branch separately. Do not use historical timeout/provider configuration as proof of the snapshot's behavior or performance.
