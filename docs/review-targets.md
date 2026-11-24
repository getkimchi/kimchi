# Local review target resolution

`src/extensions/review-targets/` is the surface-independent library for resolving a local review comparison. It does not register a command, create reviewer worktrees, select lenses, or render a report. Local callers pass `ctx.cwd` as `root`; headless callers pass their explicit checkout path instead. Neither path defaults to the process working directory.

## Public entry points

```ts
parseReviewTargetArgs(args: readonly string[]): ParsedReviewRequest
getReviewTargetChoices(request: BareReviewRequest, options: ReviewInvocationOptions): Promise<ReviewTargetChoices>
resolveReviewTarget(request: ExplicitReviewRequest, options: ResolveReviewTargetOptions): Promise<ResolvedReviewTarget>
cleanupReviewSnapshot(options: CleanupReviewSnapshotOptions): Promise<void>
cleanupStaleReviewSnapshots(options: CleanupStaleReviewSnapshotsOptions): Promise<RemovedReviewSnapshot[]>
```

`parseReviewTargetArgs` accepts tokens after `/review` for a bare invocation, `working-tree`, and `branch <ref>` with `--base <ref>`, `--include-working-tree`, and `--fetch`. A branch base may be omitted only when base suggestion can resolve it. Panel-selection options are explicitly reserved for their later parser, not silently accepted by stage 2. Ref values beginning with an option prefix are rejected.

The bare-choice result always contains Working tree followed by Branch and includes explicit command syntax for clients without a picker. Working tree is preselected when non-ignored or potentially hidden edits exist; Branch is preselected otherwise. `workingTreeStatus` is `clean`, `edits`, or `possible-edits`. The last state reports capped `flaggedPaths` plus their total count for index entries with assume-unchanged or skip-worktree. Rendering and dispatch remain surface concerns.

`ResolvedReviewScope` contains the original ref spellings and selected fully qualified base ref, immutable base/tip/head object IDs, target kind, whether the head is a snapshot, changed/anchorable/unanchorable file counts, context paths, anchor source, and structured limitations. `ResolvedReviewTarget.cleanup`, the standalone cleanup function, and stale cleanup remove only private snapshot refs that still match their expected head.

## Subprocess and conversion safety

Every internal Git subprocess, including config inspection, fetching, and all cleanup paths, runs with `core.hooksPath` set to a fresh process-owned empty directory. Repository hooks under `.git/hooks` or a configured `core.hooksPath` therefore cannot execute. A real empty directory is used instead of a platform-specific device path; marker-hook tests cover both configured hook locations on POSIX Git runners.

Resolution and bare-choice discovery use a non-converting preflight before status, content diffs, or add. It rejects any `filter.<name>.clean`, `.smudge`, or `.process` command visible in repository configuration at any scope, and any tracked or current path to which `.gitattributes` or `info/attributes` assigns a filter or working-tree encoding. Config discovery, ref enumeration, `ls-tree`, `ls-files`, and `check-attr` do not execute those conversions. Actual subprocesses additionally replace discovered filter executables with empty, failing commands as defense in depth.

Custom diff drivers and textconv commands are allowed; repositories are not rejected for `diff=` attributes or `diff.<driver>` configuration. Every production diff-producing command passes both `--no-ext-diff` and `--no-textconv`, so these drivers are never executed. Porcelain status and ref-inspection commands do not produce patches, and the library has no production `log`, content `show`, or `diff-tree` calls. Dirty working-tree and committed branch comparisons have executable-marker regression coverage.

Without `--fetch`, every command runs with `GIT_NO_LAZY_FETCH=1`; missing objects fail with `missing_object` and explain that the caller should make the promisor reachable and retry with `--fetch`. With `--fetch`, network authorization is scoped to the whole resolution, including the explicit ref fetch and later object reads. A no-op remote-ref fetch can therefore still hydrate filtered historical blobs needed for the pinned comparison. An authorized failure with an unreachable promisor reports its Git error without suggesting another `--fetch`.

## Base selection and fetching

An explicit `--base` wins. Otherwise a caller may provide an already-known `pullRequestTargetBranch`: the resolver checks its remote-tracking ref before the local branch. The general PR/MR records used by work attribution do not retain a target branch, so stage 2 performs no provider lookup and does not claim to discover this value by itself. A future caller with validated provider metadata can pass it through this option.

Without provider metadata the resolver reads the symbolic ref `refs/remotes/<remote>/HEAD` and requires it to resolve to a commit. Remote selection follows an explicitly selected remote, then a remote present in the target refs, then `origin`, then a single configured remote. Multiple candidate defaults or no usable default requires explicit `--base`.

No fetch, promisor hydration, or provider call occurs implicitly. `--fetch` runs `git fetch --no-tags --no-recurse-submodules <remote>` for the selected configured remote before refs are resolved and pinned, and permits subsequent object reads in the same resolution to fetch promised missing objects. Tests use local filesystem transports only. `--fetch` intentionally changes `FETCH_HEAD` and may change that remote's tracking refs; all other operations are read-only with respect to user refs except the private snapshot ref below.

Branch refs never use Git's tag-aware shorthand precedence. A ref already qualified under `refs/heads/` or `refs/remotes/` resolves only itself. Otherwise the candidates are `refs/heads/<name>` followed by `refs/remotes/<name>`. Multiple existing candidates are an error, and any unqualified same-named tag makes a branch request ambiguous even when no branch candidate exists. The error names the candidates. Option-like refs are rejected.

A base follows the same local/remote disambiguation, but may also be an unqualified or fully qualified lightweight or annotated tag, or a full object ID. A base name collision remains an error; qualification disambiguates it. A tag alone is not silently used as a branch.

Branch resolutions use `merge-base <base-tip> <selected-tip>` as the immutable base object ID. `--include-working-tree` requires the selected tip to be identical to the checkout's `HEAD` before capture. A working-tree-only comparison uses the checkout `HEAD` as both its base tip and selected tip.

## Frozen working-tree snapshots

A dirty snapshot is a synthetic commit with the selected tip as its parent. Capture uses `GIT_INDEX_FILE` pointing to a new temporary index, `read-tree <tip>`, `git add --all -- .`, `write-tree`, and `commit-tree`. Reading the working tree from `HEAD` rather than copying the user's index makes the final on-disk version win when staged and unstaged contents differ. Non-ignored untracked files are included; ignored files are not. Empty clean targets reuse the selected tip without creating a synthetic commit.

`git ls-files -v` runs before clean-tree decisions and capture. Any assume-unchanged or skip-worktree entry produces an explicit `unsupported_index_flags` error naming capped paths and the remainder count. Bare choices report such a tree as `possible-edits`, never clean.

All Git subprocesses use `GIT_OPTIONAL_LOCKS=0`, so status and diff cannot refresh the user's index. Capture does not mutate `HEAD`, the current branch, the working tree, the real index, or `refs/stash`. Post-capture checks reject working-tree diffs or new untracked files, and capture fails if `HEAD` moves. The successful stability check is the capture boundary; edits beginning after that boundary belong to a later review, not the pinned snapshot. Git's usual path/stat race limitations still apply to filesystem changes that are deliberately concealed from Git itself.

Private refs use this reserved namespace:

```text
refs/kimchi/review/snapshots/<uuid>
```

This is deliberately distinct from provider review refs and other extension-owned refs. Keep a snapshot ref until all reviewer worktrees and verification using that head are finished. The returned cleanup closure uses a fresh bounded 30-second signal instead of the resolution's signal. Only a genuinely absent ref counts as successful idempotent cleanup; cancellation, timeout, Git failure, and changed ref state are errors. Objects remain for normal Git maintenance and are never pruned by cleanup. Persisted `snapshotRef` and `headSha` can be passed to `cleanupReviewSnapshot` after interruption.

A hard kill between ref creation and scope persistence can leave an unowned ref. `cleanupStaleReviewSnapshots({ root, olderThanMs, signal })` scans the private namespace, compares each snapshot commit's committer timestamp with the cutoff, deletes only older refs guarded by their expected head, and returns the removed `{ ref, headSha }` entries. The stage 5 coordinator must call it at startup with a conservative threshold, suggested 24 hours, greater than the maximum possible live review age. Every in-use ref must therefore always be younger than the reclamation cutoff.

The following inputs fail explicitly rather than dropping content:

- unmerged paths;
- staged, unstaged, untracked, or differently captured submodule revisions;
- sparse checkouts;
- any configured content-filter command or assigned filter/working-tree encoding;
- assume-unchanged or skip-worktree index paths;
- working-tree changes detected during capture, a moving checkout `HEAD`, or an unsafe context directory.

Binary content, deletion-only diffs, pure renames, pure mode changes, submodules already committed in a branch comparison, and other entries without new-side text hunks receive `reason: "no_patch"` in local anchor data. Large Git output beyond the subprocess cap is an error, never a truncated map.

## Anchor-map correspondence

The resolver computes changed paths with NUL-delimited `git diff --name-only -z` and uses that list as the sole pathname authority. It parses new-side ranges from zero-context unified hunks for the same pinned comparison. Text ranges are inclusive. Path dictionaries are built with own data properties so `__proto__`, `constructor`, `prototype`, and similar names survive serialization unchanged.

The resulting `commentable-lines/v1` document is atomically written into `commentable-lines.json`, using `review-submit`'s `resolveReviewDirectories` and `checkReviewDirectory` rules with creation enabled. It carries `merge_base_sha` equal to `scope.pinned.baseSha` and `commit_sha` equal to `scope.pinned.headSha`.

A provider map is accepted only when all of the following hold:

1. The head is not a dirty working-tree snapshot. Confirmed committed comparisons, including a clean working-tree invocation, may use provider anchors.
2. The input has a valid `commentable-lines/v1` shape.
3. `merge_base_sha` and `commit_sha` exactly equal the pinned base and head object IDs, respectively. Ref names, dates, tree IDs, branch names, and provider PR numbers are not substitutes.

The provider side must therefore supply both full object IDs for the exact diff from which its new-side hunks were derived and the anchor map shape already consumed by `review-submit/store.ts`. Provider data is passed explicitly in `providerAnchorMap`; an existing context file is never implicitly trusted as provider evidence. Missing, malformed, mismatched, and dirty-snapshot cases fall back to local anchors and return a structured limitation explaining that local publishing needs fresh provider validation.

The focused tests exercise generated maps, including prototype-named paths, through the real `submitFinding` store. They also verify that a provider range for a committed head cannot be transferred to a later dirty snapshot's line numbers.

## Later stages

Reviewer worktrees and permission enforcement, panel/lens parsing and scheduling, reconciliation, `/review` registration and rendering in TUI/ACP, APA manifest integration, and provider publishing are intentionally outside this library's stage 2 scope. The stage 5 coordinator additionally owns startup stale-ref reclamation and timely normal cleanup.
