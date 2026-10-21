/**
 * workspace.ts — the Ferment V2 workspace module.
 *
 * It owns every git-facing workspace concern of the verifier pipeline:
 *
 * - `snapshotWorkspace` captures the working tree (untracked, non-ignored
 *   files included) through a temporary index, producing a snapshot commit
 *   without touching the real index, tree, or refs;
 * - the ferment **baseline** is such a snapshot, taken when a ferment is
 *   created or replaced, and `gatherWorkspaceFacts` compares the current tree
 *   against it: changed files (A/M/D/R), a diff stat, git state, and
 *   **test-inventory flags** — pre-existing test files deleted, renamed, or
 *   modified, added skip/only markers, and changes to kept probes — each
 *   carrying an `f1, f2, …` ID the verifier must address in its checks. The
 *   marker scan forces textual, untransformed, uncolored diffs with literal
 *   pathspecs so repository diff configuration cannot conceal a marker, and a
 *   git failure mid-collection marks the inventory incomplete (the verifier
 *   is told to inspect changed test files itself);
 * - `reserveBaselineWorktree` reserves a temporary directory for the baseline
 *   and checks it out as a `git worktree` (sharing the repository root's
 *   `node_modules` when present) only on first use, so the verifier can
 *   attribute failures and check new tests against the pre-change tree;
 *   ownership is reserved before the asynchronous add, so a concurrent
 *   `pruneStaleBaselineWorktrees` (crashed-run cleanup at session start)
 *   never mistakes an in-flight creation for a leftover.
 *
 * All git access goes through `execFile` (no shell) with a bounded timeout;
 * every operation is read-only with respect to the real index, refs, and —
 * for the snapshot family — the working tree itself.
 */

import { execFile as execFileCallback } from "node:child_process"
import {
	copyFileSync,
	type Dirent,
	existsSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmdirSync,
	rmSync,
	symlinkSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, relative, resolve } from "node:path"
import { promisify } from "node:util"

const execFile = promisify(execFileCallback)

/** Per-git-command timeout for facts, HEAD, and worktree commands; past it the fact is unavailable. */
const GIT_COMMAND_TIMEOUT_MS = 15_000

/**
 * Per-git-command timeout for snapshots. `git add -A` into a temporary index
 * hashes every changed and untracked file, which can take well past 15s on
 * large trees; a failed snapshot leaves the verifier without integrity.
 */
const SNAPSHOT_GIT_TIMEOUT_MS = 60_000

/**
 * Fixed identity for snapshot commits. `git commit-tree` refuses to run
 * without an author identity, and fresh containers and CI images have none
 * configured; snapshot commits are internal objects that never reach a ref,
 * so they never borrow the user's identity either.
 */
const SNAPSHOT_COMMIT_IDENTITY = {
	GIT_AUTHOR_NAME: "kimchi ferment-v2",
	GIT_AUTHOR_EMAIL: "ferment-v2@kimchi.invalid",
	GIT_COMMITTER_NAME: "kimchi ferment-v2",
	GIT_COMMITTER_EMAIL: "ferment-v2@kimchi.invalid",
}

export interface WorkspaceSnapshot {
	commit: string
	tree: string
}

export interface SnapshotDiff {
	modified: string[]
	deleted: string[]
	added: string[]
}

interface GitRunner {
	run(args: readonly string[], options?: { env?: Record<string, string>; signal?: AbortSignal }): Promise<string>
}

export function createGitRunner(cwd: string, timeoutMs = GIT_COMMAND_TIMEOUT_MS): GitRunner {
	return {
		async run(args, options) {
			const { stdout } = await execFile("git", args, {
				cwd,
				timeout: timeoutMs,
				maxBuffer: 64 * 1024 * 1024,
				encoding: "utf-8",
				...(options?.env ? { env: { ...process.env, ...options.env } } : {}),
				...(options?.signal ? { signal: options.signal } : {}),
			})
			return stdout
		},
	}
}

/**
 * HEAD of the workspace: a commit, or an unborn branch (fresh `git init`,
 * `git checkout --orphan`). A commit carries the symbolic ref HEAD is
 * attached to (absent when detached), so a branch switch or detachment at
 * the same commit is still a HEAD move.
 */
export type HeadState = { kind: "commit"; sha: string; ref?: string } | { kind: "unborn"; ref: string }

/**
 * Resolve HEAD: a commit, an unborn branch, or undefined when git could not
 * answer (timeout, broken repository). An unborn HEAD also fails
 * `rev-parse --verify HEAD`; `symbolic-ref` distinguishes it from a repo
 * where git cannot resolve HEAD at all — and, for a resolved commit, an
 * attached from a detached HEAD.
 */
export async function readHeadState(git: GitRunner, signal?: AbortSignal): Promise<HeadState | undefined> {
	try {
		const sha = (await git.run(["rev-parse", "--verify", "HEAD"], { signal })).trim()
		if (sha) {
			try {
				const ref = (await git.run(["symbolic-ref", "-q", "HEAD"], { signal })).trim()
				if (ref) return { kind: "commit", sha, ref }
			} catch {
				// Detached HEAD: `symbolic-ref` fails, so the commit carries no ref.
			}
			return { kind: "commit", sha }
		}
	} catch {
		try {
			const ref = (await git.run(["symbolic-ref", "-q", "HEAD"], { signal })).trim()
			if (ref) return { kind: "unborn", ref }
		} catch {}
	}
	return undefined
}

/** HEAD state of the workspace, or undefined when git could not resolve it. */
export async function workspaceHead(cwd: string, signal?: AbortSignal): Promise<HeadState | undefined> {
	return readHeadState(createGitRunner(cwd), signal)
}

/** Whether cwd is inside a git work tree, a confirmed non-repo, or undeterminable. */
export type GitWorkspaceProbe = "git" | "outside_git" | "unknown"

/**
 * Probe whether cwd is inside a git work tree. "outside_git" is a confirmed
 * non-repo; "unknown" means git could not answer (missing binary, timeout,
 * broken repository) — the integrity guard cannot protect such a workspace.
 */
export async function detectGitWorkspace(cwd: string, signal?: AbortSignal): Promise<GitWorkspaceProbe> {
	try {
		await createGitRunner(cwd).run(["rev-parse", "--show-toplevel"], { signal })
		return "git"
	} catch (error) {
		return isNotARepositoryError(error) ? "outside_git" : "unknown"
	}
}

function isNotARepositoryError(error: unknown): boolean {
	const stderr = (error as { stderr?: unknown }).stderr
	return typeof stderr === "string" && stderr.includes("not a git repository")
}

/**
 * Snapshot the working tree (including untracked, non-ignored files) as a tree
 * and commit object, without touching the real index, tree, or refs: the real
 * index is copied to a temporary file, `git add -A` runs against that copy,
 * and `git write-tree` + `git commit-tree` produce the snapshot (parentless
 * when HEAD is unborn). Returns undefined outside git or when any step
 * fails; callers must have confirmed a git workspace first and treat
 * undefined as failure.
 */
export async function snapshotWorkspace(cwd: string, signal?: AbortSignal): Promise<WorkspaceSnapshot | undefined> {
	const git = createGitRunner(cwd, SNAPSHOT_GIT_TIMEOUT_MS)
	let indexFile: string | undefined
	let tempDir: string | undefined
	try {
		const realIndex = (await git.run(["rev-parse", "--git-path", "index"], { signal })).trim()
		// git-path returns a path relative to cwd when inside the work tree.
		const realIndexPath = isAbsolute(realIndex) ? realIndex : resolve(cwd, realIndex)
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-ferment-v2-snapshot-"))
		indexFile = join(tempDir, "index")
		// A missing index (fresh repository): git creates a fresh empty index
		// when the target does not exist.
		copyIndexFile(realIndexPath, indexFile)
		// The bits copied from the real index must go: git add -A ignores edits
		// to skip-worktree/assume-unchanged files, so both the before- and
		// after-run snapshots would record the stale blob and the guard would
		// leave a verifier modification in place.
		await clearSnapshotIndexFlags(cwd, indexFile, signal)
		await git.run(["add", "-A", "--"], { env: { GIT_INDEX_FILE: indexFile }, signal })
		const tree = (await git.run(["write-tree"], { env: { GIT_INDEX_FILE: indexFile }, signal })).trim()
		if (!tree) return undefined
		const head = await readHeadState(git, signal)
		const commit = (
			await git.run(
				[
					"commit-tree",
					tree,
					...(head?.kind === "commit" ? ["-p", head.sha] : []),
					"-m",
					"kimchi ferment-v2 verifier workspace snapshot",
				],
				{ env: { GIT_INDEX_FILE: indexFile, ...SNAPSHOT_COMMIT_IDENTITY }, signal },
			)
		).trim()
		if (!commit) return undefined
		return { commit, tree }
	} catch {
		return undefined
	} finally {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true })
	}
}

/** Copy the repository's index to the snapshot's temporary index. */
function copyIndexFile(from: string, to: string): void {
	try {
		copyFileSync(from, to)
	} catch {
		// A missing source (fresh repository) or unreadable index: start from a
		// fresh index — git creates the file when it does not exist, but rejects
		// a zero-byte one as "index file smaller than expected".
		rmSync(to, { force: true })
	}
}

/** Paths per `git update-index` invocation, bounding argv length on large clearings. */
const UPDATE_INDEX_BATCH = 100

/**
 * Clear `skip-worktree` (ls-files tag `S`) and `assume-unchanged` (lowercase
 * tags) bits in the snapshot's temporary index copy, so `git add -A` records
 * the actual working-tree content of those files. Only the temporary copy is
 * modified — the real index keeps the user's bits untouched.
 *
 * Both commands scope to the directory they run from: `ls-files` run from a
 * session subdirectory lists only that subtree, so a flagged entry elsewhere
 * (at the repository root, say) would keep its bit in the temporary index and
 * hide the verifier's edit from both snapshots. Enumeration and clearing
 * therefore run from the repository root, over root-relative paths — the
 * temp-index `git add -A`, `write-tree`, and `commit-tree` that follow are
 * already whole-tree from any cwd.
 *
 * Two separate invocations are required: passing both flags to one
 * `git update-index` command exits 0 but silently leaves the skip-worktree
 * bit set, hiding the verifier's edit from both snapshots (reproduced on
 * git 2.54; `git restore` shows the same skip-worktree filtering, covered
 * by `--ignore-skip-worktree-bits` in `restorePaths`).
 */
async function clearSnapshotIndexFlags(cwd: string, indexFile: string, signal?: AbortSignal): Promise<void> {
	const rootGit = createGitRunner(await workspaceRoot(cwd, signal))
	const tagged = await rootGit.run(["ls-files", "-v", "-z"], { env: { GIT_INDEX_FILE: indexFile }, signal })
	const flagged: string[] = []
	for (const entry of tagged.split("\0")) {
		const separator = entry.indexOf(" ")
		if (separator <= 0) continue
		const tag = entry.slice(0, separator)
		if (tag === "S" || /^[a-z]$/.test(tag)) flagged.push(entry.slice(separator + 1))
	}
	if (flagged.length === 0) return
	for (const clearFlag of ["--no-skip-worktree", "--no-assume-unchanged"]) {
		for (let start = 0; start < flagged.length; start += UPDATE_INDEX_BATCH) {
			const batch = flagged.slice(start, start + UPDATE_INDEX_BATCH)
			await rootGit.run(["update-index", clearFlag, "--", ...batch], {
				env: { GIT_INDEX_FILE: indexFile },
				signal,
			})
		}
	}
}

/** Parse `git diff[-tree] -r -z --name-status` output (rename/copy entries carry the old path as a third field). */
function parseNameStatus(raw: string): { status: string; path: string; newPath: string | undefined }[] {
	const fields = raw.split("\0")
	const entries: { status: string; path: string; newPath: string | undefined }[] = []
	for (let i = 0; i < fields.length - 1; ) {
		const status = fields[i]
		if (!status) {
			i++
			continue
		}
		const kind = status[0]
		if (kind === "R" || kind === "C") {
			const oldPath = fields[i + 1]
			const newPath = fields[i + 2]
			if (!oldPath || !newPath) break
			entries.push({ status, path: oldPath, newPath })
			i += 3
		} else {
			const path = fields[i + 1]
			if (!path) break
			entries.push({ status, path, newPath: undefined })
			i += 2
		}
	}
	return entries
}

/** Diff two workspace snapshots by tree, classifying paths as modified, deleted, or added. */
export async function diffSnapshots(
	cwd: string,
	from: WorkspaceSnapshot,
	to: WorkspaceSnapshot,
	signal?: AbortSignal,
): Promise<SnapshotDiff> {
	const git = createGitRunner(cwd)
	const raw = await git.run(["diff-tree", "-r", "-z", "--name-status", from.tree, to.tree], { signal })
	const modified: string[] = []
	const deleted: string[] = []
	const added: string[] = []
	for (const { status, path, newPath } of parseNameStatus(raw)) {
		const kind = status[0]
		if (kind === "A") added.push(path)
		else if (kind === "D") deleted.push(path)
		else if ((kind === "R" || kind === "C") && newPath !== undefined) {
			deleted.push(path)
			added.push(newPath)
		} else modified.push(path)
	}
	return { modified, deleted, added }
}

/** Paths per `git restore` invocation, bounding argv length on large restorations. */
const RESTORE_PATHS_BATCH = 100

/**
 * Resolve the work tree root that snapshot and diff paths are relative to.
 * `git diff-tree` emits repository-root-relative paths regardless of the
 * session cwd, so filesystem operations must anchor to this root.
 */
async function workspaceRoot(cwd: string, signal?: AbortSignal): Promise<string> {
	const root = (await createGitRunner(cwd).run(["rev-parse", "--show-toplevel"], { signal })).trim()
	if (!root) throw new Error("git rev-parse --show-toplevel returned no work tree root")
	return root
}

/** The files of a snapshot: the work tree root and root-relative paths. */
export interface SnapshotPaths {
	root: string
	paths: ReadonlySet<string>
}

/**
 * List every file of a snapshot (untracked, non-ignored files included — the
 * snapshot carries them), for "did this exist before the verifier run?"
 * checks. Undefined when git fails.
 */
export async function listSnapshotPaths(
	cwd: string,
	snapshot: WorkspaceSnapshot,
	signal?: AbortSignal,
): Promise<SnapshotPaths | undefined> {
	try {
		const root = await workspaceRoot(cwd, signal)
		const raw = await createGitRunner(root).run(
			["ls-tree", "-r", "--name-only", "-z", "--full-tree", snapshot.commit],
			{
				signal,
			},
		)
		return { root, paths: new Set(raw.split("\0").filter((path) => path.length > 0)) }
	} catch {
		return undefined
	}
}

function isInside(path: string, root: string): boolean {
	const rel = relative(root, path)
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)
}

/**
 * Restore paths from a snapshot's tree into the working tree with
 * `git restore --source` — raw blob bytes, file modes, and symlink semantics
 * included — without touching the real index, so the user's staging state
 * survives. Paths are repository-root-relative and resolved against the work
 * tree root, never the session cwd. `--ignore-skip-worktree-bits` makes the
 * restore reach files git filters out of pathspec matching because the index
 * carries their skip-worktree bit (the flag exists since git 2.23, the version
 * that introduced `git restore` itself).
 */
export async function restorePaths(
	cwd: string,
	from: WorkspaceSnapshot,
	paths: readonly string[],
	signal?: AbortSignal,
): Promise<void> {
	const git = createGitRunner(await workspaceRoot(cwd, signal))
	for (let start = 0; start < paths.length; start += RESTORE_PATHS_BATCH) {
		const batch = paths.slice(start, start + RESTORE_PATHS_BATCH)
		await git.run(["restore", "--ignore-skip-worktree-bits", "--source", from.tree, "--worktree", "--", ...batch], {
			signal,
		})
	}
}

/** Remove files the verifier added (repository-root-relative paths), pruning directories that become empty. */
export async function removePaths(cwd: string, paths: readonly string[]): Promise<void> {
	const root = await workspaceRoot(cwd)
	for (const path of paths) {
		const absolute = resolve(root, path)
		rmSync(absolute, { force: true })
		let dir = dirname(absolute)
		while (dir !== root && isInside(dir, root)) {
			try {
				if (readdirSync(dir).length > 0) break
				rmdirSync(dir)
				dir = dirname(dir)
			} catch {
				break
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Facts vs baseline
// ---------------------------------------------------------------------------

export type TestInventoryFlagKind =
	| "test_file_deleted"
	| "test_file_renamed"
	| "test_file_modified"
	| "skip_marker_added"
	| "kept_probe_modified"
	| "kept_probe_deleted"

export interface TestInventoryFlag {
	/** Host-assigned ID (`f1`, `f2`, …) the verifier must address in a check. */
	id: string
	kind: TestInventoryFlagKind
	path: string
	detail?: string
	/** Set for kept-probe flags: the requirement the probe belongs to. */
	requirementId?: string
}

export interface WorkspaceChangedFile {
	status: "A" | "M" | "D" | "R"
	path: string
	from?: string
}

export interface WorkspaceFacts {
	/** The baseline commit the facts were gathered against. */
	baseline: string
	changedFiles: WorkspaceChangedFile[]
	/** `git diff --stat` between baseline and current, bounded in length. */
	diffStat: string
	/** The complete test-inventory flag list — never capped, because the host validates a `met` verdict against these IDs. */
	testInventoryFlags: TestInventoryFlag[]
	/**
	 * True when any part of the inventory collection failed — the baseline
	 * test-file enumeration or a marker diff — so the flag list may be
	 * missing entries. The verifier is told to inspect changed test files
	 * itself; the flags that were collected must still be addressed.
	 */
	testInventoryIncomplete: boolean
	git: { branch?: string; head?: string; commitsSinceBaseline?: number; uncommittedFiles: number }
	/** True when the changed-file list or the diff stat was capped for display. */
	truncated: boolean
}

/** Upper bound on the changed-file list in the facts, bounding the prompt's facts section. */
const MAX_CHANGED_FILES = 200
/** Upper bound on characters of the diff stat embedded in the facts. */
const MAX_DIFF_STAT_CHARS = 4_000
/** Characters of one skip-marker line kept as the flag detail. */
const MAX_MARKER_DETAIL_CHARS = 200

/**
 * Test-file patterns (plan Chunk 2): `__tests__/`, `tests?/`, `spec/`
 * directories; `*.test|spec.[cm]?[jt]sx?`; `*_test.go|py`; `test_*.py`;
 * `*_spec.rb`; `*Tests?.(java|kt|cs)`.
 */
const TEST_PATH_PATTERNS: readonly RegExp[] = [
	/(^|\/)(__tests__|tests?|spec)\//,
	/\.(test|spec)\.[cm]?[jt]sx?$/i,
	/_test\.(go|py)$/i,
	/(^|\/)test_[^/]*\.py$/i,
	/_spec\.rb$/i,
	/Tests?\.(java|kt|cs)$/i,
]

export function isTestFilePath(path: string): boolean {
	return TEST_PATH_PATTERNS.some((pattern) => pattern.test(path))
}

/**
 * Rust source files. The canonical Rust layout keeps tests inline in
 * production sources — `#[cfg(test)] mod tests` at the bottom of `src/lib.rs`
 * — so no test-file path heuristic can identify them: every changed `.rs`
 * file's added lines are scanned for skip/only markers, or an `#[ignore]`
 * added to an inline test would disable it without a flag to address.
 */
function isRustSourcePath(path: string): boolean {
	return /\.rs$/i.test(path)
}

/** Whether a changed file's diff is scanned for added skip/only markers. */
function isMarkerScanPath(path: string): boolean {
	return isTestFilePath(path) || isRustSourcePath(path)
}

/**
 * Skip/only markers whose *addition* to a scanned file (a test file by the
 * path heuristic, or a Rust source — see `isMarkerScanPath`) is a flag:
 * JS/TS `it|test|describe.(skip|only|todo)(` and `(it|test).fail(`, `xit(/xtest(/xdescribe(`,
 * vitest `test.fail(`, pytest `@pytest.mark.(skip|xfail)`, Go `t.Skip(f)(`,
 * Rust `#[ignore]` (also with a reason, `#[ignore = "…"]`), JUnit
 * `@Disabled`/`@Ignore`.
 */
const SKIP_MARKER_PATTERNS: readonly RegExp[] = [
	/\b(?:it|test|describe)\.(?:skip|only|todo)\s*\(/,
	/\b(?:it|test)\.fail\s*\(/,
	/\bx(?:it|test|describe)\s*\(/,
	/@pytest\.mark\.(?:skip|xfail)/,
	/\bt\.Skipf?\s*\(/,
	/#\s*\[ignore\b/,
	/@(?:Disabled|Ignore)\b/,
]

function isSkipMarkerLine(line: string): boolean {
	return SKIP_MARKER_PATTERNS.some((pattern) => pattern.test(line))
}

/**
 * Count `git status --porcelain=v1 -z` entries. Records are consumed
 * sequentially: a rename/copy record is followed by its source path as a
 * bare NUL-terminated field — no `XY ` prefix — that must be consumed with
 * its record, or a source like `my file.txt` (space at index 2) is
 * miscounted as another entry and a single rename reports two uncommitted
 * files.
 */
function countPorcelainEntries(raw: string): number {
	let count = 0
	const fields = raw.split("\0")
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i]
		if (field.length < 4 || field[2] !== " ") continue
		count++
		// `R` and `C` appear only in the index column, never the work-tree
		// one — both columns are checked so a source field is never left behind.
		if (field[0] === "R" || field[0] === "C" || field[1] === "R" || field[1] === "C") i++
	}
	return count
}

/** Extract the added skip/only-marker lines of a unified diff and flag the first. */
function pushSkipMarkerFlag(diff: string, path: string, flags: PendingTestInventoryFlag[]): void {
	const addedLines = diff
		.split("\n")
		.filter((line) => line.startsWith("+") && !line.startsWith("+++"))
		.map((line) => line.slice(1).trim())
		.filter((line) => line.length > 0 && isSkipMarkerLine(line))
	if (addedLines.length === 0) return
	const first = addedLines[0].slice(0, MAX_MARKER_DETAIL_CHARS)
	flags.push({
		kind: "skip_marker_added",
		path,
		detail: addedLines.length > 1 ? `${first} (+${addedLines.length - 1} more)` : first,
	})
}

interface PendingTestInventoryFlag {
	kind: TestInventoryFlagKind
	path: string
	detail?: string
	requirementId?: string
}

/**
 * Gather workspace facts against the ferment baseline: changed files
 * (A/M/D/R, untracked-at-start files included — both snapshots carry them),
 * the diff stat, git state, and test-inventory flags.
 *
 * Flags fire for test files that existed at the baseline (deleted, renamed,
 * modified), for kept probes from previous verifier runs (modified, deleted,
 * renamed away), and for added lines matching skip/only markers in changed
 * test files and Rust sources — inline `#[cfg(test)]` tests elude the
 * filename heuristic, so every changed `.rs` file is scanned — including
 * rename destinations, eligible through either side of the rename (a test
 * file moved out of every path heuristic stays scannable) and compared
 * against their baseline source. Each flag gets a sequential `f1, f2, …` ID;
 * the verifier must address every ID in a check before a `met` verdict is
 * accepted.
 *
 * `baseline` is the ferment baseline commit, or HEAD when the ferment has
 * none. Returns undefined when the baseline diff cannot be computed (git
 * failure, baseline object garbage-collected) — callers report the facts as
 * unavailable.
 */
export async function gatherWorkspaceFacts(
	cwd: string,
	baseline: string,
	current: WorkspaceSnapshot,
	keptProbes: readonly { path: string; requirementId: string }[],
	signal?: AbortSignal,
): Promise<WorkspaceFacts | undefined> {
	// Every command runs from the repository root with root-relative paths:
	// from a session subdirectory, `ls-tree` lists only the subtree with
	// subtree-relative paths while `diff --name-status` emits root-relative
	// paths (so baseline test files would never match changed paths), and
	// git pathspecs — the marker diffs — resolve against the cwd (so a
	// root-relative path would match nothing).
	let root: string
	try {
		root = await workspaceRoot(cwd, signal)
	} catch {
		return undefined
	}
	const git = createGitRunner(root)
	const optional = async (
		args: readonly string[],
		options?: { env?: Record<string, string> },
	): Promise<string | undefined> => {
		try {
			return await git.run(args, { signal, ...options })
		} catch {
			return undefined
		}
	}

	let nameStatus: string
	try {
		nameStatus = await git.run(["diff", "--name-status", "-M", "-z", baseline, current.commit], { signal })
	} catch {
		return undefined
	}
	const [diffStatRaw, branchRaw, headRaw, commitsRaw, statusRaw, baselineTreeRaw] = await Promise.all([
		optional(["diff", "--stat", "-M", baseline, current.commit]),
		optional(["rev-parse", "--abbrev-ref", "HEAD"]),
		optional(["rev-parse", "--verify", "HEAD"]),
		optional(["rev-list", "--count", `${baseline}..HEAD`]),
		// --untracked-files=all makes the count match the snapshot semantics
		// (every untracked, non-ignored file counted): the default collapses an
		// untracked directory to a single record, and a repository's
		// status.showUntrackedFiles=no would hide untracked files entirely.
		optional(["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
		optional(["ls-tree", "-r", "--name-only", "-z", baseline]),
	])

	const keptProbeByPath = new Map(keptProbes.map((probe) => [probe.path, probe]))
	// A failed baseline enumeration silently empties the pre-existing test
	// inventory (no deleted/renamed/modified flag would fire), so it marks the
	// facts incomplete — the verifier is then told to inspect test files itself.
	let inventoryIncomplete = baselineTreeRaw === undefined
	const baselineTestFiles = new Set(
		(baselineTreeRaw === undefined ? [] : baselineTreeRaw.split("\0").filter((path) => path.length > 0)).filter(
			isTestFilePath,
		),
	)

	const changedFiles: WorkspaceChangedFile[] = []
	const flags: PendingTestInventoryFlag[] = []
	/** Changed files (modified or added) whose added lines are scanned for skip/only markers: test files by path heuristic, and Rust sources for their inline tests. */
	const markerScanFiles: string[] = []
	/** Renamed marker-scan destinations, compared against their baseline source. */
	const renamedScanFiles: { from: string; to: string }[] = []

	for (const { status, path, newPath } of parseNameStatus(nameStatus)) {
		const kind = status[0]
		const keptProbe = keptProbeByPath.get(path)
		if (kind === "R" || kind === "C") {
			const to = newPath ?? path
			changedFiles.push({ status: "R", path: to, ...(path === to ? {} : { from: path }) })
			if (keptProbe !== undefined) {
				// A kept probe moved elsewhere is gone from its registered path.
				flags.push({
					kind: "kept_probe_deleted",
					path,
					detail: `renamed to ${to}`,
					requirementId: keptProbe.requirementId,
				})
			} else if (baselineTestFiles.has(path)) {
				flags.push({ kind: "test_file_renamed", path: to, detail: `was ${path}` })
			}
			// The rename destination is scanned for markers against its baseline
			// source below — a rename must not conceal an added skip/only marker.
			// Eligibility carries over from the baseline source as well: a test
			// file renamed out of every path heuristic (tests/a.ts → cases/a.ts)
			// stays scannable, or the rename would hide an added marker even
			// when a runner still imports the file.
			if (isMarkerScanPath(to) || isMarkerScanPath(path)) renamedScanFiles.push({ from: path, to })
			continue
		}
		if (kind === "A") {
			changedFiles.push({ status: "A", path })
			if (isMarkerScanPath(path)) markerScanFiles.push(path)
			continue
		}
		if (kind === "D") {
			changedFiles.push({ status: "D", path })
			if (keptProbe !== undefined) {
				flags.push({ kind: "kept_probe_deleted", path, requirementId: keptProbe.requirementId })
			} else if (baselineTestFiles.has(path)) {
				flags.push({ kind: "test_file_deleted", path })
			}
			continue
		}
		// Modified, type-changed, or unmerged: the file exists on both sides.
		changedFiles.push({ status: "M", path })
		if (keptProbe !== undefined) {
			flags.push({ kind: "kept_probe_modified", path, requirementId: keptProbe.requirementId })
		} else if (baselineTestFiles.has(path)) {
			flags.push({ kind: "test_file_modified", path })
		}
		if (isMarkerScanPath(path)) markerScanFiles.push(path)
	}

	// The flag inventory is complete: every changed test file and Rust source
	// is scanned and no flag is dropped, because the host validates a `met`
	// verdict against these IDs — a cap here would silently exempt the changes
	// beyond it. A diff that *fails* (git error, output beyond the runner's
	// buffer) never silently drops its flag either: it marks the inventory
	// incomplete, which the verifier prompt reports.
	for (const path of markerScanFiles) {
		// Repository diff configuration must not conceal markers: `--text`
		// overrides a `-diff` (binary) attribute, `--no-ext-diff` and
		// `--no-textconv` disable configured diff drivers and filters,
		// `--no-color` keeps a `color.ui=always` from prefixing added lines
		// with ANSI escapes the scan would not recognize, and literal pathspecs
		// keep a path starting with `:` (or carrying glob characters) matching
		// the file itself instead of pathspec magic.
		const diff = await optional(
			["diff", "--text", "--no-color", "--no-ext-diff", "--no-textconv", baseline, current.commit, "--", path],
			{ env: { GIT_LITERAL_PATHSPECS: "1" } },
		)
		if (diff === undefined) {
			inventoryIncomplete = true
			continue
		}
		pushSkipMarkerFlag(diff, path, flags)
	}
	// A renamed test destination is compared against its baseline source blob:
	// `git diff <commit>:<from> <commit>:<to>` pairs the two directly, so added
	// markers surface regardless of rename-detection similarity (a pathspec-
	// restricted `git diff -M` shows a heavily rewritten rename as a new file,
	// flagging pre-existing markers as additions).
	for (const { from, to } of renamedScanFiles) {
		// Colons in either path are fine: in `<commit>:<path>` the first colon
		// separates the revision, the rest is the path verbatim.
		const diff = await optional([
			"diff",
			"--text",
			"--no-color",
			"--no-ext-diff",
			"--no-textconv",
			`${baseline}:${from}`,
			`${current.commit}:${to}`,
		])
		if (diff === undefined) {
			inventoryIncomplete = true
			continue
		}
		pushSkipMarkerFlag(diff, to, flags)
	}

	let truncated = changedFiles.length > MAX_CHANGED_FILES
	const diffStat = (() => {
		const stat = (diffStatRaw ?? "").trim()
		if (stat.length <= MAX_DIFF_STAT_CHARS) return stat
		truncated = true
		const summary = stat.split("\n").at(-1) ?? ""
		return `${stat.slice(0, MAX_DIFF_STAT_CHARS)}\n…\n${summary}`
	})()

	const commits = commitsRaw === undefined ? undefined : Number.parseInt(commitsRaw.trim(), 10)

	return {
		baseline,
		changedFiles: changedFiles.slice(0, MAX_CHANGED_FILES).map((file) => ({ ...file })),
		diffStat,
		testInventoryFlags: flags.map((flag, index) => ({
			id: `f${index + 1}`,
			...flag,
		})),
		testInventoryIncomplete: inventoryIncomplete,
		git: {
			branch: branchRaw?.trim() || undefined,
			head: headRaw?.trim() || undefined,
			commitsSinceBaseline:
				commits !== undefined && Number.isSafeInteger(commits) && commits >= 0 ? commits : undefined,
			uncommittedFiles: statusRaw === undefined ? 0 : countPorcelainEntries(statusRaw),
		},
		truncated,
	}
}

// ---------------------------------------------------------------------------
// Baseline worktree
// ---------------------------------------------------------------------------

/**
 * Prefix of temporary baseline-worktree directories. The owning process id
 * follows the prefix (`…-<pid>-<random>`), so pruning can tell a leftover
 * from a worktree a live session is still using.
 */
export const BASELINE_WORKTREE_PREFIX = "kimchi-ferment-v2-baseline-"

/**
 * Baseline worktrees this process created and has not disposed yet —
 * reserved before the asynchronous `worktree add` starts, so a concurrent
 * prune never mistakes an in-flight creation for a leftover.
 */
const liveBaselineWorktrees = new Set<string>()

/** Whether the given process id still exists (EPERM: alive, owned by another user). */
function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM"
	}
}

/** The owning process id encoded in a baseline-worktree directory name, when parseable. */
function baselineWorktreeOwnerPid(path: string): number | undefined {
	const name = realPath(path).split(/[\\/]/).at(-1) ?? ""
	if (!name.startsWith(BASELINE_WORKTREE_PREFIX)) return undefined
	const match = /^(\d+)-/.exec(name.slice(BASELINE_WORKTREE_PREFIX.length))
	return match ? Number.parseInt(match[1], 10) : undefined
}

export interface BaselineWorktree {
	/** Absolute path reserved for the worktree; checked out at the baseline commit by `ensure`. */
	path: string
	/**
	 * Check the baseline out into the reserved path on first call; later calls
	 * return the same outcome. False when the worktree could not be created.
	 */
	ensure(signal?: AbortSignal): Promise<boolean>
	/** Remove the worktree (if created), prune git's administrative state, and delete the reservation; always safe to call. */
	dispose(): Promise<void>
}

/**
 * Reserve a temporary directory for the baseline worktree. Nothing is checked
 * out until `ensure` runs, so a verifier run that never touches the baseline
 * costs no checkout. `ensure` runs `git worktree add --detach` at the
 * baseline commit so the verifier can run code at the pre-change tree
 * (attribute pre-existing failures, check that new tests fail without the
 * change); the repository root's `node_modules`, when present, is symlinked
 * into it so project commands work without a fresh install.
 *
 * Returns undefined when the directory cannot be reserved.
 */
export function reserveBaselineWorktree(cwd: string, baseline: string): BaselineWorktree | undefined {
	const git = createGitRunner(cwd)
	let dir: string
	try {
		// The directory name carries this process's pid, so another session's
		// pruning never removes a worktree this process is still using.
		dir = mkdtempSync(join(tmpdir(), `${BASELINE_WORKTREE_PREFIX}${process.pid}-`))
	} catch {
		return undefined
	}
	// Ownership is reserved before the asynchronous add begins: a concurrent
	// session-start prune in this same process lists the worktree as soon as
	// git registers it — before the add's await resolves — and would classify
	// a not-yet-registered, same-pid worktree as a dead session's leftover.
	// Released on disposal.
	const canonical = realPath(dir)
	liveBaselineWorktrees.add(canonical)
	let creation: Promise<boolean> | undefined

	const create = async (signal?: AbortSignal): Promise<boolean> => {
		try {
			await git.run(["worktree", "add", "--detach", dir, baseline], { signal })
		} catch {
			try {
				await git.run(["worktree", "prune"])
			} catch {}
			return false
		}
		// Share the main tree's node_modules — the root one and nested package
		// ones (monorepos, backend/ + frontend/ layouts): without them, project
		// commands inside the worktree would need a fresh install, and the
		// verifier's own symlink attempts are classifier-gated.
		try {
			const root = (await git.run(["rev-parse", "--show-toplevel"], { signal })).trim()
			if (root) linkNodeModules(root, dir)
		} catch {
			// Best-effort: the verifier is told the worktree may lack dependencies.
		}
		return true
	}

	return {
		path: dir,
		ensure: (signal) => {
			creation ??= create(signal)
			return creation
		},
		dispose: async () => {
			const created = creation ? await creation : false
			liveBaselineWorktrees.delete(canonical)
			if (created) {
				try {
					await git.run(["worktree", "remove", "--force", dir])
				} catch {
					// A dirty or locked worktree may refuse removal; the directory
					// cleanup below and the prune still leave git consistent.
				}
				try {
					await git.run(["worktree", "prune"])
				} catch {}
			}
			rmSync(dir, { recursive: true, force: true })
		},
	}
}

/** How deep below the repository root nested `node_modules` directories are linked into the worktree. */
const NODE_MODULES_LINK_DEPTH = 3

/**
 * Symlink every `node_modules` directory of the main tree — the root one and
 * nested ones up to NODE_MODULES_LINK_DEPTH levels below it — into the same
 * place in the worktree, when that place exists there and has none yet.
 * Hidden directories and `node_modules` contents are not descended into.
 */
export function linkNodeModules(mainRoot: string, worktreeRoot: string): void {
	const visit = (relativeDir: string, depth: number): void => {
		let entries: Dirent[]
		try {
			entries = readdirSync(join(mainRoot, relativeDir), { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith(".")) continue
			const child = relativeDir ? join(relativeDir, entry.name) : entry.name
			if (entry.name === "node_modules") {
				const target = join(worktreeRoot, child)
				if (existsSync(join(worktreeRoot, relativeDir)) && !existsSync(target)) {
					try {
						symlinkSync(join(mainRoot, child), target)
					} catch {
						// Best-effort per directory.
					}
				}
				continue
			}
			if (depth < NODE_MODULES_LINK_DEPTH) visit(child, depth + 1)
		}
	}
	visit("", 0)
}

/** Absolute path with symlinks resolved (macOS keeps /tmp under /private), falling back to lexical resolution. */
function realPath(path: string): string {
	try {
		return realpathSync(path)
	} catch {
		return resolve(path)
	}
}

/** Whether a path is one of our temporary baseline worktrees (prefix + inside the OS temp dir). */
function isBaselineWorktreePath(path: string): boolean {
	const absolute = realPath(path)
	const temp = realPath(tmpdir())
	return (
		dirname(absolute) !== absolute &&
		(absolute === temp || isInside(absolute, temp)) &&
		(absolute.split(/[\\/]/).at(-1) ?? "").startsWith(BASELINE_WORKTREE_PREFIX)
	)
}

/**
 * Whether a registered baseline worktree is provably abandoned: not held by
 * this process (live runs register theirs), and either without a readable
 * owner pid, owned by this process (a dead session in a shared ACP process
 * leaked it), or owned by a process that no longer exists.
 */
function isAbandonedBaselineWorktree(path: string): boolean {
	if (liveBaselineWorktrees.has(realPath(path))) return false
	const owner = baselineWorktreeOwnerPid(path)
	if (owner === undefined || owner === process.pid) return true
	return !isProcessAlive(owner)
}

/**
 * Remove baseline worktrees left behind by crashed runs (a session start
 * never inherits one): every registered worktree under our temporary prefix
 * that is provably abandoned — not in use by this process or by a live owner
 * process — is force-removed, then git's worktree administration is pruned.
 * A non-git directory is a no-op.
 */
export async function pruneStaleBaselineWorktrees(cwd: string): Promise<void> {
	const git = createGitRunner(cwd)
	let list: string
	try {
		list = await git.run(["worktree", "list", "--porcelain"])
	} catch {
		return
	}
	const stale = list
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length).trim())
		.filter((path) => path.length > 0 && isBaselineWorktreePath(path))
		.filter((path) => isAbandonedBaselineWorktree(path))
	for (const path of stale) {
		try {
			await git.run(["worktree", "remove", "--force", path])
		} catch {}
	}
	try {
		await git.run(["worktree", "prune"])
	} catch {}
}
