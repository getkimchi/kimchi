/**
 * Git worktree support for kimchi.
 *
 * Pure functions over `execFile("git", …)` (no pi imports), used by both the
 * `--worktree` CLI flag (slice 1, pre-main in cli.ts), subagent isolation
 * (slice 2), the shared hook events `WorktreeCreate`/`WorktreeRemove` (slice 3),
 * and the mid-session `EnterWorktree`/`ExitWorktree` tools (slice 4).
 *
 * Design mirrors Claude Code's worktree feature where it makes sense, but
 * lives under `<mainRoot>/.kimchi/worktrees/<name>` per the approved plan
 * (`.kimchi/` is kimchi's project folder).
 *
 * Naming convention: `worktree-<name>` for the branch, `<name>` for the
 * directory. Auto-generated names look like `bold-oak-a3f2`.
 */

import { execFile } from "node:child_process"
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs"
import { cp, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, resolve, sep } from "node:path"
import { promisify } from "node:util"

import micromatch from "micromatch"

const execFileAsync = promisify(execFile)

const ADJECTIVES = [
	"bold",
	"calm",
	"clear",
	"deep",
	"fair",
	"glad",
	"keen",
	"kind",
	"loud",
	"lucid",
	"merry",
	"neat",
	"nimble",
	"quick",
	"quiet",
	"sharp",
	"sleek",
	"smart",
	"smooth",
	"swift",
	"warm",
	"wild",
	"wise",
	"witty",
] as const

const NOUNS = [
	"cedar",
	"crane",
	"ember",
	"falcon",
	"fern",
	"harbor",
	"heron",
	"lake",
	"lotus",
	"maple",
	"meadow",
	"oak",
	"otter",
	"pine",
	"river",
	"robin",
	"rose",
	"sage",
	"shore",
	"spruce",
	"stone",
	"stream",
	"willow",
	"wren",
] as const

export const WORKTREE_BRANCH_PREFIX = "worktree-"
export const WORKTREE_DIR_NAME = ".kimchi/worktrees"
export const WORKTREE_INCLUDE_FILE = ".worktreeinclude"
/** File dropped at <mainRoot>/.kimchi/worktrees/.gitignore so the dir itself
 *  doesn't show up as untracked in the main checkout. */
export const WORKTREE_GITIGNORE_BODY = "*\n"

export type BaseRefMode = "fresh" | "head"

export interface RepoRoots {
	/** The main repo root (the worktree's parent in the .git/worktrees/ tree). */
	mainRoot: string
	/** If `cwd` is itself a worktree, the directory at <mainRoot>/.kimchi/worktrees/<name>. Undefined when cwd is the main checkout. */
	worktreeRoot?: string
}

export interface WorktreeEntry {
	/** Absolute path to the worktree directory. */
	path: string
	/** Current HEAD commit. */
	head: string
	/** Branch name. Empty for detached worktrees. */
	branch: string
	/** Whether this is the main checkout. */
	isMain: boolean
}

export interface WorktreeStatus {
	/** True when `git status --porcelain` reports any tracked changes. */
	dirty: boolean
	/** True when there are untracked files that aren't ignored. */
	untracked: boolean
	/** Commits on the worktree's branch not reachable from the main checkout's HEAD. */
	ownCommits: number
}

export interface CreateWorktreeOptions {
	mainRoot: string
	name: string
	/** "fresh" → resolve to origin/HEAD then local HEAD; "head" → HEAD. */
	baseRef?: BaseRefMode
	/**
	 * When dir already exists, reuse it: registered worktrees are left alone
	 * unless they are clean AND still on `worktree-<name>` AND have no own
	 * commits — then their branch is reset to baseRef. When false, an
	 * existing directory is an error.
	 */
	reuseExisting?: boolean
}

export interface CreatedWorktree {
	path: string
	name: string
	branch: string
	baseRef: string
}

export interface RemoveWorktreeOptions {
	/** Absolute path of the worktree directory to remove. */
	dir: string
	/** Branch to delete after `git worktree remove` succeeds. Omit when the
	 *  branch should remain (e.g. the user re-uses the branch in another
	 *  worktree). */
	branch?: string
	/** Force-remove even when `worktreeStatus` reports dirty/untracked work.
	 *  The exit prompt only sets this after a confirmation; the API does not
	 *  silently drop work. */
	force?: boolean
}

/** Throws if the user-supplied name isn't a safe filesystem segment. */
export function validateWorktreeName(name: string): void {
	if (name.length === 0) throw new WorktreeError("worktree name must not be empty")
	if (name.length > 64) throw new WorktreeError(`worktree name too long (${name.length} > 64)`)
	if (name.startsWith("-")) throw new WorktreeError("worktree name must not start with a dash")
	if (name.includes("..")) throw new WorktreeError("worktree name must not contain '..'")
	if (name.includes("/") || name.includes(sep) || name.includes("\\")) {
		throw new WorktreeError("worktree name must not contain a path separator")
	}
	if (!/^[A-Za-z0-9._-]+$/.test(name)) {
		throw new WorktreeError(`worktree name '${name}' contains invalid characters (allowed: A-Z a-z 0-9 . _ -)`)
	}
}

/** Returns a random `adjective-noun-xxxx` name in Claude Code's style. */
export function generateWorktreeName(): string {
	const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]
	const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)]
	const hex = Math.floor(Math.random() * 0xffff)
		.toString(16)
		.padStart(4, "0")
	return `${adj}-${noun}-${hex}`
}

export class WorktreeError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "WorktreeError"
	}
}

/** Git pinned to `cwd`: no `GIT_*` variable can point it elsewhere. Uses
 *  the same pattern as `src/extensions/build-info.ts`. */
function gitFreeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	return Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith("GIT_")))
}

async function runGit(cwd: string, args: readonly string[], opts: { timeoutMs?: number } = {}): Promise<string> {
	const { stdout } = await execFileAsync("git", args, {
		cwd,
		env: gitFreeEnv(process.env),
		timeout: opts.timeoutMs ?? 10_000,
		maxBuffer: 16 * 1024 * 1024,
	})
	return stdout
}

async function tryGit(cwd: string, args: readonly string[]): Promise<string | undefined> {
	try {
		return await runGit(cwd, args)
	} catch {
		return undefined
	}
}

/** True when `.git` at `cwd` is a `gitdir: <path>` pointer file (a linked worktree). */
function isWorktreePointer(cwd: string): boolean {
	const dotGitPath = join(cwd, ".git")
	if (!existsSync(dotGitPath)) return false
	if (statSync(dotGitPath).isDirectory()) return false
	const content = readFileSync(dotGitPath, "utf-8").trim()
	return /^gitdir:\s*.+$/m.test(content)
}

/** True when `cwd` refers to a real directory; falls back to the logical
 *  path for comparisons when the path no longer exists (e.g. after a remove). */
function normalizeReal(cwd: string): string {
	try {
		return realpathSync(cwd)
	} catch {
		return isAbsolute(cwd) ? cwd : resolve(cwd)
	}
}

/**
 * Resolve `cwd` against the worktree graph: returns the main repo root and,
 * when `cwd` is itself a linked worktree, that worktree's path.
 *
 * All returned paths are realpaths — git resolves the `.git` pointer to the
 * canonical path (e.g. `/private/var/...` on macOS where `/var` is a symlink),
 * so callers must compare against realpaths to avoid false negatives.
 *
 * Mirrors the existing `findMainRepoRoot` helper in `src/extensions/lsp/servers.ts`,
 * kept here so slice 1 can move it later. The current callers (`servers.ts`)
 * continue to import from there until the refactor lands.
 */
export function resolveRepoRoots(cwd: string): RepoRoots {
	const absCwd = normalizeReal(cwd)
	const dotGitPath = join(absCwd, ".git")
	if (!existsSync(dotGitPath) || statSync(dotGitPath).isDirectory()) {
		// No repo here, or .git is a directory → cwd is the main checkout.
		return { mainRoot: absCwd }
	}
	const content = readFileSync(dotGitPath, "utf-8").trim()
	const gitdirMatch = content.match(/^gitdir:\s*(.+)$/m)
	if (!gitdirMatch) return { mainRoot: absCwd }
	const gitdir = gitdirMatch[1]
	const wtMatch = gitdir.match(/^(.+?\/\.git)\/worktrees\/[^/]+$/)
	if (!wtMatch) return { mainRoot: absCwd }
	const mainRoot = normalizeReal(dirname(wtMatch[1]))
	return { mainRoot, worktreeRoot: absCwd }
}

/** Path of the worktrees directory under the main checkout, and ensure the
 *  self-ignoring `.gitignore` is in place. Idempotent. */
export async function worktreeDir(mainRoot: string): Promise<string> {
	const dir = join(mainRoot, WORKTREE_DIR_NAME)
	await mkdir(dir, { recursive: true })
	const gi = join(dir, ".gitignore")
	if (!existsSync(gi)) {
		await writeFile(gi, WORKTREE_GITIGNORE_BODY, "utf-8")
	}
	return dir
}

/**
 * Synchronous directory-level enumeration of linked worktrees under a repo:
 * every `<mainRoot>/.kimchi/worktrees/*` entry whose `.git` is a `gitdir:`
 * pointer file. Used by the session listing paths (TUI resume picker, ACP
 * listSessions) to surface worktree sessions from the main checkout.
 *
 * Returns [] when `dir` is not a repo root, not a main checkout (i.e. itself
 * a linked worktree — no nested worktrees per slice 1), or nothing is there.
 */
export function listWorktreeDirsUnder(dir: string): string[] {
	const roots = resolveRepoRoots(dir)
	// Only the main checkout owns linked worktrees; a worktree's own dir is not
	// enumerated (its sessions are reached via the main checkout's list).
	if (roots.worktreeRoot !== undefined) return []
	const wtRoot = join(roots.mainRoot, WORKTREE_DIR_NAME)
	let entries: string[]
	try {
		entries = readdirSync(wtRoot)
	} catch {
		return []
	}
	const result: string[] = []
	for (const entry of entries) {
		const path = join(wtRoot, entry)
		if (isWorktreePointer(path)) result.push(path)
	}
	return result
}

/** Parse `git worktree list --porcelain` (newline-separated records). Returned
 *  paths are git's realpaths; `mainRoot` is normalized the same way so the
 *  `isMain` comparison is stable across symlinked tmp dirs. */
export async function listWorktrees(mainRoot: string): Promise<WorktreeEntry[]> {
	const root = normalizeReal(mainRoot)
	const out = await runGit(root, ["worktree", "list", "--porcelain"])
	const records = out.split("\n").reduce<string[][]>((acc, line) => {
		if (line === "") {
			if (acc.length > 0 && acc[acc.length - 1].length > 0) acc.push([])
		} else {
			if (acc.length === 0) acc.push([])
			acc[acc.length - 1].push(line)
		}
		return acc
	}, [])
	const result: WorktreeEntry[] = []
	for (const rec of records) {
		const path = rec.find((l) => l.startsWith("worktree "))?.slice("worktree ".length)
		const head = rec.find((l) => l.startsWith("HEAD "))?.slice("HEAD ".length) ?? ""
		const branch =
			rec
				.find((l) => l.startsWith("branch "))
				?.slice("branch ".length)
				.replace(/^refs\/heads\//, "") ?? ""
		if (!path) continue
		// The main checkout carries a `branch` line too — only a path equality
		// check distinguishes it.
		result.push({ path, head, branch, isMain: path === root })
	}
	return result
}

/** Resolve the base ref for a new worktree. "fresh" follows Claude Code's
 *  default: prefer `origin/HEAD`, fall back to local `HEAD` when the
 *  upstream isn't reachable. "head" always uses local `HEAD`. */
export async function resolveBaseRef(mainRoot: string, mode: BaseRefMode = "fresh"): Promise<string> {
	if (mode === "head") {
		const head = await runGit(mainRoot, ["rev-parse", "HEAD"])
		return head.trim()
	}
	const originHead = await tryGit(mainRoot, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
	if (originHead) {
		const trimmed = originHead.trim()
		if (trimmed.length > 0) return trimmed
	}
	const head = await runGit(mainRoot, ["rev-parse", "HEAD"])
	return head.trim()
}

/**
 * Create a worktree. Returns the new path, name, branch and resolved base.
 *
 * Steps:
 *   1. Resolve base ref and compute target dir + branch.
 *   2. `git worktree add -b <branch> <dir> <base>`; when the dir already
 *      exists and `reuseExisting` is set, reuse per the option's contract
 *      (clean worktrees still on `worktree-<name>` reset to base).
 *   3. Run `applyWorktreeInclude` so the user's `.worktreeinclude` rules
 *      seed `.kimchi/` etc.
 */
export async function createWorktree(opts: CreateWorktreeOptions): Promise<CreatedWorktree> {
	validateWorktreeName(opts.name)
	const baseRef = await resolveBaseRef(opts.mainRoot, opts.baseRef ?? "fresh")
	const dir = join(await worktreeDir(opts.mainRoot), opts.name)
	const branch = `${WORKTREE_BRANCH_PREFIX}${opts.name}`

	if (existsSync(dir)) {
		if (!opts.reuseExisting) {
			throw new WorktreeError(`a worktree already exists at ${dir} (reuse with reuseExisting:true)`)
		}
		// Reuse: confirm the dir is still a linked worktree before touching it.
		if (!isWorktreePointer(dir)) {
			throw new WorktreeError(`refusing to reuse '${dir}': not a git worktree`)
		}
		const status = await worktreeStatus(dir, opts.mainRoot)
		const onBranch = await tryGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"])
		const branchMatches = onBranch !== undefined && onBranch.trim() === branch
		// Reset to base only when nothing would be lost: clean tree, still on
		// our branch, no commits ahead of the main checkout.
		if (!status.dirty && !status.untracked && status.ownCommits === 0 && branchMatches) {
			await runGit(dir, ["reset", "--hard", baseRef], { timeoutMs: 30_000 })
		}
	} else {
		try {
			await runGit(opts.mainRoot, ["worktree", "add", "-b", branch, dir, baseRef], { timeoutMs: 30_000 })
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err)
			throw new WorktreeError(`git worktree add failed: ${msg}`)
		}
	}

	await applyWorktreeInclude(opts.mainRoot, dir)
	return { path: dir, name: opts.name, branch, baseRef }
}

/**
 * Copy files from the main checkout into the worktree based on `.worktreeinclude`.
 * The include file lives at <mainRoot>/.worktreeinclude and follows a
 * gitignore-like pattern syntax (one glob per line; `#` for comments).
 * It's the user's knob for "carry over `.kimchi/config.json` and
 * `.kimchi/permissions.local.json` into a fresh worktree". Missing file → no-op.
 *
 * Candidates are tracked + untracked files, INCLUDING ignored ones
 * (`git ls-files --cached --others` without `--exclude-standard`): an entry in
 * `.worktreeinclude` is explicit user intent that overrides `.gitignore` — that
 * is the whole point of the file (`.kimchi/` is gitignored in most repos).
 */
export async function applyWorktreeInclude(mainRoot: string, worktreePath: string): Promise<string[]> {
	const includePath = join(mainRoot, WORKTREE_INCLUDE_FILE)
	if (!existsSync(includePath)) return []
	const raw = await readFile(includePath, "utf-8")
	const patterns = raw
		.split(/\r?\n/)
		.map((l) => l.trim())
		.filter((l) => l.length > 0 && !l.startsWith("#"))
	if (patterns.length === 0) return []

	// Tracked + untracked (ignored included), NUL-separated so weird paths survive.
	const out = await runGit(mainRoot, ["ls-files", "--cached", "--others", "-z"])
	const candidates = out.split("\0").filter((s) => s.length > 0)

	const matched = micromatch(candidates, patterns, { dot: true, posix: true })
	const copied: string[] = []
	for (const relPath of matched) {
		const src = join(mainRoot, relPath)
		const dst = join(worktreePath, relPath)
		if (!existsSync(src)) continue
		await mkdir(dirname(dst), { recursive: true })
		await cp(src, dst, { recursive: true, preserveTimestamps: true })
		copied.push(relPath)
	}
	return copied
}

/** Status of a worktree, used by the exit prompt and by auto-cleanup. Each
 *  field is independently best-effort — a partial answer is fine. */
export async function worktreeStatus(dir: string, mainRoot: string): Promise<WorktreeStatus> {
	const status = (await tryGit(dir, ["status", "--porcelain"])) ?? ""
	const lines = status.split("\n").filter((l) => l.length > 0)
	let dirty = false
	let untracked = false
	for (const line of lines) {
		// `?? <path>` for untracked, otherwise tracked change (M/A/D/...).
		if (line.startsWith("??")) untracked = true
		else dirty = true
	}

	let ownCommits = 0
	const head = await tryGit(dir, ["rev-parse", "HEAD"])
	if (head) {
		const mergeBase = await tryGit(mainRoot, ["merge-base", head.trim(), "HEAD"])
		if (mergeBase) {
			const aheadOut = await tryGit(dir, ["rev-list", "--count", `${mergeBase.trim()}..HEAD`])
			if (aheadOut) ownCommits = Number.parseInt(aheadOut.trim(), 10) || 0
		}
	}

	return { dirty, untracked, ownCommits }
}

/** Resolve `dir` to `<mainRoot>/.kimchi/worktrees/...`: returns the main
 *  root when `dir` is a linked worktree at that location, else null. */
function worktreeDirMainRoot(dir: string): string | null {
	const realDir = normalizeReal(dir)
	const roots = resolveRepoRoots(realDir)
	if (roots.worktreeRoot !== realDir) return null
	// Safety: only worktrees under <mainRoot>/.kimchi/worktrees/ are ours to
	// remove. Anything else (the main checkout, .claude/worktrees, bare repos)
	// is refused so a confused model cannot do damage through this tool.
	const expected = join(roots.mainRoot, WORKTREE_DIR_NAME)
	if (dirname(realDir) !== expected) return null
	return roots.mainRoot
}

/**
 * Remove a worktree and (optionally) its branch. Refuses to operate on the
 * main checkout or anything outside `<mainRoot>/.kimchi/worktrees/` (the
 * `worktreeDirMainRoot` check). When `force` is false and the worktree has
 * dirty/untracked work or unpushed commits, throws — the exit prompt must
 * confirm before force-removing.
 */
export async function removeWorktree(opts: RemoveWorktreeOptions): Promise<void> {
	const mainRoot = isWorktreePointer(normalizeReal(opts.dir)) ? worktreeDirMainRoot(opts.dir) : null
	if (mainRoot === null) {
		throw new WorktreeError(`refusing to remove '${opts.dir}': not under <repo>/.kimchi/worktrees/`)
	}
	if (!existsSync(opts.dir)) return // already gone

	if (!opts.force) {
		const status = await worktreeStatus(opts.dir, mainRoot)
		if (status.dirty || status.untracked || status.ownCommits > 0) {
			throw new WorktreeError(`worktree has uncommitted, untracked, or unpushed work — pass force:true to discard`)
		}
	}

	try {
		const args = ["worktree", "remove"]
		if (opts.force) args.push("--force")
		args.push(opts.dir)
		await runGit(mainRoot, args, { timeoutMs: 30_000 })
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err)
		throw new WorktreeError(`git worktree remove failed: ${msg}`)
	}

	if (opts.branch) {
		const name = opts.branch.startsWith(WORKTREE_BRANCH_PREFIX)
			? opts.branch
			: `${WORKTREE_BRANCH_PREFIX}${opts.branch}`
		await tryGit(mainRoot, ["branch", "-D", name])
	}
}
