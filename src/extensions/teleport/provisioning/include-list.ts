import { type ChildProcess, spawn as defaultSpawn, type spawn } from "node:child_process"
import type { Dirent } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { join, posix } from "node:path"

/**
 * Basenames excluded outright regardless of where they appear in the tree.
 * Derived from the file-shape (non-directory) entries of `BASE_EXCLUDE_GLOBS`
 * in `rsync-runner.ts`. Kept in sync by construction — see the test in
 * `include-list.test.ts`.
 */
const BASE_FILE_PATTERN_EXACT: ReadonlySet<string> = new Set([".env", ".envrc", ".DS_Store"])
const BASE_FILE_PATTERN_PREFIX: readonly string[] = [".env."] // matches .env.local, .env.production, etc.
const BASE_FILE_PATTERN_EXT: readonly string[] = [".log", ".tmp"]

/**
 * Returns true if the relative path's basename matches one of the
 * file-shape `BASE_EXCLUDE_GLOBS`. Used to filter the explicit include
 * list so behaviour mirrors the legacy `--exclude-from` flow for these
 * patterns.
 */
export function excludesBaseFilePattern(relPath: string): boolean {
	const slash = relPath.lastIndexOf("/")
	const base = slash === -1 ? relPath : relPath.slice(slash + 1)
	if (BASE_FILE_PATTERN_EXACT.has(base)) return true
	for (const prefix of BASE_FILE_PATTERN_PREFIX) {
		if (base.startsWith(prefix)) return true
	}
	for (const ext of BASE_FILE_PATTERN_EXT) {
		if (base.endsWith(ext)) return true
	}
	return false
}

/**
 * Run `git ls-files` with the given mode flags in `cwd`. Always uses `-z`
 * so paths with newlines / special chars survive intact. Returns the
 * NUL-split paths, or `[]` if git fails (not a repo, git missing, etc.).
 */
function runGitLsFiles(
	cwd: string,
	modeArgs: readonly string[],
	signal: AbortSignal | undefined,
	spawner: typeof spawn,
): Promise<string[]> {
	return new Promise((resolve) => {
		let stdout = Buffer.alloc(0)
		let child: ChildProcess
		try {
			child = spawner("git", ["ls-files", ...modeArgs, "-z"], {
				cwd,
				signal,
				stdio: ["ignore", "pipe", "pipe"],
			})
		} catch {
			resolve([])
			return
		}
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = Buffer.concat([stdout, chunk])
		})
		child.on("error", () => resolve([]))
		child.on("close", (code) => {
			if (code !== 0) {
				resolve([])
				return
			}
			const list = stdout
				.toString("utf-8")
				.split("\0")
				.filter((s) => s.length > 0)
			resolve(list)
		})
	})
}

/**
 * Tracked files (entries in the git index). No safety filter is applied
 * to these by the caller — the user committed them deliberately, so
 * leaving them out of the upload list would surface as `deleted:` lines
 * on the remote's `git status`.
 */
export async function listGitTrackedFiles(
	cwd: string,
	signal?: AbortSignal,
	spawner: typeof spawn = defaultSpawn,
): Promise<string[]> {
	return runGitLsFiles(cwd, ["--cached"], signal, spawner)
}

/**
 * Tracked files whose working-tree copy is missing (deleted on disk but the
 * deletion not yet staged/committed). The caller filters these out of the
 * tracked list so rsync isn't asked to stat a source that no longer exists —
 * which would fail the whole transfer with code 23 ("partial transfer due to
 * error"). Reported relative to `cwd` with the same prefix behavior as
 * `--cached`, so the paths match for set membership.
 */
export async function listGitDeletedFiles(
	cwd: string,
	signal?: AbortSignal,
	spawner: typeof spawn = defaultSpawn,
): Promise<string[]> {
	return runGitLsFiles(cwd, ["--deleted"], signal, spawner)
}

/**
 * Untracked files that git would otherwise see (i.e. not gitignored).
 * The caller is expected to apply `excludesBaseFilePattern()` to this
 * list — these are the candidates for the "accidental .env / .DS_Store"
 * safety net.
 */
export async function listGitUntrackedFiles(
	cwd: string,
	signal?: AbortSignal,
	spawner: typeof spawn = defaultSpawn,
): Promise<string[]> {
	return runGitLsFiles(cwd, ["--others", "--exclude-standard"], signal, spawner)
}

/**
 * Recursively walk `<cwd>/.git/` (if present) and return every file
 * path relative to `cwd`, POSIX-separated. Symlinks are skipped. Per-
 * entry errors (file disappeared, permission denied) are swallowed —
 * the caller's fallback handles top-level failure.
 */
export async function walkGitDir(cwd: string, signal?: AbortSignal): Promise<string[]> {
	const root = join(cwd, ".git")
	try {
		const rootStat = await stat(root)
		if (!rootStat.isDirectory()) return []
	} catch {
		return []
	}
	const out: string[] = []
	async function walk(absDir: string, relDir: string): Promise<void> {
		if (signal?.aborted) throw new Error("aborted")
		let entries: Dirent[]
		try {
			entries = await readdir(absDir, { withFileTypes: true })
		} catch {
			return
		}
		await Promise.all(
			entries.map(async (entry) => {
				if (signal?.aborted) return
				const name = entry.name
				const relPath = relDir.length === 0 ? name : posix.join(relDir, name)
				if (entry.isDirectory()) {
					await walk(join(absDir, name), relPath)
					return
				}
				if (entry.isSymbolicLink()) return
				if (!entry.isFile()) return
				out.push(relPath)
			}),
		)
	}
	await walk(root, ".git")
	return out
}

/**
 * Tracked + untracked working-tree files, relative to `cwd`,
 * POSIX-separated. Shared core of `buildIncludeList` /
 * `buildWorkingTreeList`:
 *   1. `git ls-files --cached -z` — tracked files, minus any that
 *      `git ls-files --deleted -z` reports as missing from the working
 *      tree. Tracked entries are otherwise explicit user intent — if we
 *      drop a present one, the remote's `git status` shows it deleted —
 *      but a tracked file the user has `rm`'d (deletion not yet staged)
 *      isn't on disk, so feeding it to rsync fails the transfer with
 *      code 23. Excluding it just mirrors the local deleted state.
 *   2. `git ls-files --others --exclude-standard -z` — untracked files
 *      git would otherwise see. The basename safety filter is applied
 *      here so an accidentally-left-around `.env` / `.DS_Store` doesn't
 *      leak to the sandbox.
 *
 * Per-source git errors (git missing, not a repo) are swallowed so a
 * partial list is still useful.
 */
async function buildWorkingTreeEntries(
	cwd: string,
	signal: AbortSignal | undefined,
	spawner: typeof spawn,
): Promise<string[]> {
	const [tracked, others, deleted] = await Promise.all([
		listGitTrackedFiles(cwd, signal, spawner),
		listGitUntrackedFiles(cwd, signal, spawner),
		listGitDeletedFiles(cwd, signal, spawner),
	])
	const deletedSet = new Set(deleted)
	const liveTracked = tracked.filter((p) => !deletedSet.has(p))
	const safeOthers = others.filter((p) => !excludesBaseFilePattern(p))
	return [...liveTracked, ...safeOthers]
}

/**
 * Build the rsync `--files-from` include list for teleport: every path
 * the workspace upload should consist of, relative to `cwd`,
 * POSIX-separated.
 *
 * Composed of the working-tree entries (see `buildWorkingTreeEntries`)
 * plus a recursive walk of `<cwd>/.git/` — git's metadata dir, which the
 * teleport flow currently uploads (it's not in `BASE_EXCLUDE_GLOBS`)
 * but which `git ls-files` never lists.
 *
 * Cheap: no remote roundtrip, no rsync subprocess. Per-source errors
 * (git missing, `.git` unreadable) are swallowed so a partial list is
 * still useful.
 */
export async function buildIncludeList(
	cwd: string,
	signal?: AbortSignal,
	spawner: typeof spawn = defaultSpawn,
): Promise<string[]> {
	const [entries, gitDirFiles] = await Promise.all([
		buildWorkingTreeEntries(cwd, signal, spawner),
		walkGitDir(cwd, signal),
	])
	return [...entries, ...gitDirFiles]
}

/**
 * Like `buildIncludeList` but WITHOUT the `<cwd>/.git/` walk — the
 * `/teleport --fast` diff-rsync variant, where the remote side already
 * has a fresh clone's `.git` and only the working-tree diff is synced.
 */
export async function buildWorkingTreeList(
	cwd: string,
	signal?: AbortSignal,
	spawner: typeof spawn = defaultSpawn,
): Promise<string[]> {
	return buildWorkingTreeEntries(cwd, signal, spawner)
}

/**
 * Files that differ from the upstream tracking ref — only what the diff
 * rsync actually needs to transfer after a server-side clone. Uses
 * `git diff @{upstream}` to capture both unpushed commits AND uncommitted
 * changes. Falls back to `git diff HEAD` (uncommitted only) when no
 * upstream is set (unpushed branch with no tracking ref).
 *
 * On a clean tree with no unpushed commits, this returns ~0 files.
 */
export async function buildChangedFilesList(
	cwd: string,
	signal?: AbortSignal,
	spawner: typeof spawn = defaultSpawn,
): Promise<string[]> {
	const [changed, others] = await Promise.all([
		listGitChangedFiles(cwd, signal, spawner),
		listGitUntrackedFiles(cwd, signal, spawner),
	])
	const safeOthers = others.filter((p) => !excludesBaseFilePattern(p))
	return [...changed, ...safeOthers]
}

function listGitChangedFiles(cwd: string, signal: AbortSignal | undefined, spawner: typeof spawn): Promise<string[]> {
	return new Promise((resolve) => {
		let stdout = Buffer.alloc(0)
		let child: ChildProcess
		try {
			// @{upstream} = origin/<branch>. Captures both unpushed commits
			// and uncommitted changes in one diff.
			child = spawner("git", ["-C", cwd, "diff", "--name-only", "--diff-filter=ACMRTUXB", "@{upstream}", "-z"], {
				cwd,
				signal,
				stdio: ["ignore", "pipe", "pipe"],
			})
		} catch {
			resolve([])
			return
		}
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = Buffer.concat([stdout, chunk])
		})
		child.on("error", () => resolve([]))
		child.on("close", (code) => {
			if (code !== 0) {
				// No upstream set (unpushed branch) — fall back to HEAD + local-only commits.
				resolve(listGitChangedFilesFallback(cwd, signal, spawner))
				return
			}
			resolve(
				stdout
					.toString("utf-8")
					.split("\0")
					.filter((s) => s.length > 0),
			)
		})
	})
}

/**
 * Fallback when no upstream tracking ref is set (unpushed branch).
 * Combines:
 *   1. `git diff HEAD` — uncommitted changes (staged + unstaged).
 *   2. `git log --branches --not --remotes --name-only` — files changed in
 *      commits that exist locally but not on any remote (unpushed commits).
 * Together these capture everything the remote clone is missing.
 */
async function listGitChangedFilesFallback(
	cwd: string,
	signal: AbortSignal | undefined,
	spawner: typeof spawn,
): Promise<string[]> {
	const [uncommitted, localOnly] = await Promise.all([
		runGitDiffHEAD(cwd, signal, spawner),
		runGitLogLocalOnly(cwd, signal, spawner),
	])
	return [...new Set([...uncommitted, ...localOnly])]
}

function runGitDiffHEAD(cwd: string, signal: AbortSignal | undefined, spawner: typeof spawn): Promise<string[]> {
	return new Promise((resolve) => {
		let stdout = Buffer.alloc(0)
		let child: ChildProcess
		try {
			child = spawner("git", ["-C", cwd, "diff", "--name-only", "--diff-filter=ACMRTUXB", "HEAD", "-z"], {
				cwd,
				signal,
				stdio: ["ignore", "pipe", "pipe"],
			})
		} catch {
			resolve([])
			return
		}
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = Buffer.concat([stdout, chunk])
		})
		child.on("error", () => resolve([]))
		child.on("close", (code) => {
			if (code !== 0) {
				resolve([])
				return
			}
			resolve(
				stdout
					.toString("utf-8")
					.split("\0")
					.filter((s) => s.length > 0),
			)
		})
	})
}

function runGitLogLocalOnly(cwd: string, signal: AbortSignal | undefined, spawner: typeof spawn): Promise<string[]> {
	return new Promise((resolve) => {
		let stdout = Buffer.alloc(0)
		let child: ChildProcess
		try {
			// List files changed in commits that exist on local branches
			// but not on any remote — i.e. unpushed commits.
			child = spawner(
				"git",
				["-C", cwd, "log", "--branches", "--not", "--remotes", "--name-only", "--pretty=format:", "-z"],
				{
					cwd,
					signal,
					stdio: ["ignore", "pipe", "pipe"],
				},
			)
		} catch {
			resolve([])
			return
		}
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout = Buffer.concat([stdout, chunk])
		})
		child.on("error", () => resolve([]))
		child.on("close", (code) => {
			if (code !== 0) {
				resolve([])
				return
			}
			resolve(
				stdout
					.toString("utf-8")
					.split("\0")
					.filter((s) => s.length > 0),
			)
		})
	})
}
