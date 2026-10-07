# Rewind

Rewind restores project files together with the conversation. It bundles [pi-rewind-hook](https://github.com/nicobailon/pi-rewind-hook) for the snapshots and the restore choices in `/tree` and `/fork`, and adds a `/rewind` command on top.

Enable `extensions.rewind` under `/resources` → **Experimental**, then restart Kimchi. It is disabled by default. Outside a git repository nothing is captured, and `/rewind` only moves the conversation.

## Snapshots

At the start of each prompt and after each assistant turn, pi-rewind-hook snapshots the git worktree through a private index and keeps the commits under `refs/pi-rewind/store`. The user's index, branches, stash and `git status` are untouched. Each snapshot is bound to its session entry in the session journal, so snapshots follow `/tree`, `/fork`, resume and compaction.

Snapshots are never pruned unless `rewind.retention` is set in `~/.config/kimchi/harness/settings.json` (`maxSnapshots`, `maxAgeDays` and the other pi-rewind-hook options); without it, the repository's git objects keep every snapshot.

A snapshot holds what `git add -A` would stage: tracked and untracked files, minus `.gitignore`d ones. Ignored files (`node_modules`, `.env`, build output) are neither captured nor restored, and neither is anything outside the repository: databases, network calls, installed packages. A repository with a dirty or uninitialized submodule is not captured; Rewind warns instead. Snapshots are git commits, so git needs an identity: without `user.name` and `user.email`, Rewind warns and records nothing.

The first snapshot of a session hashes the whole worktree. Later ones rehash only files whose stat data changed: with one edited file per checkpoint, about 0.2 s on Linux and 1.1 s on Windows for 20,000 files.

## Commands

- `/rewind` lists the prompts on the current branch, newest first and numbered so identical prompts stay distinguishable. Picking one moves the conversation back to just before that prompt through the session tree and returns the prompt text to the editor; the later history stays as a branch. It is available only while the agent is idle.
- Navigating with `/tree`, including through `/rewind`, shows **Restore Options**: keep current files, restore the files from that point, undo the last file restore, or cancel.
- `/fork` offers conversation only, files and conversation, files only, or undo the last file restore.

**Undo last file rewind** puts back the files as they were before the last restore.

## pi-rewind-hook patch

`patches/pi-rewind-hook@1.8.7.patch` stops pi-rewind-hook from binding a prompt's start snapshot in `turn_start`. pi appends the prompt's user entry only after `turn_start`, so 1.8.7 bound the snapshot to the previous prompt: `/rewind` to the latest prompt could not restore files, and older prompts restored the files from before the next one. `turn_end` and `agent_end` already bind the snapshot once the entry exists. `src/extensions/rewind/file-restore.integration.test.ts` replays pi's event order and fails without the patch.

Tracking: [nicobailon/pi-rewind-hook#19](https://github.com/nicobailon/pi-rewind-hook/pull/19). Remove the patch when a pinned pi-rewind-hook release includes it.

The patch was generated with `pnpm patch` / `pnpm patch-commit`; do not edit the patch file directly.

## Type shim

pi-rewind-hook ships TypeScript that does not pass Kimchi's strict typecheck, and `skipLibCheck` only skips declaration files. `src/extensions/rewind/pi-rewind-hook.js` therefore re-exports the package, and `pi-rewind-hook.d.ts` declares the one function Kimchi calls. Remove both when the package typechecks under Kimchi's `tsconfig.json`.
