import { execFileSync } from "node:child_process"
import { lstatSync, realpathSync, statSync } from "node:fs"
import { dirname, join } from "node:path"

export interface Worktree {
	path: string
	branch?: string
	locked?: boolean
	prunable?: boolean
}

export interface PreparedWorktree {
	path: string
	branch: string
	created: boolean
}

function git(cwd: string, args: string[]): string {
	const overrides = ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"].filter(
		(name) => process.env[name] !== undefined,
	)
	if (overrides.length) throw new Error(`Unset ${overrides.join(", ")} before using Kimchi worktrees or branches.`)
	return execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).replace(/\r?\n$/, "")
}

export function listWorktrees(cwd: string): Worktree[] {
	return git(cwd, ["worktree", "list", "--porcelain", "-z"])
		.split("\0\0")
		.filter(Boolean)
		.map((record) => {
			const fields = record.split("\0")
			const branch = fields.find((field) => field.startsWith("branch refs/heads/"))
			return {
				path: fields[0].slice("worktree ".length),
				...(branch ? { branch: branch.slice("branch refs/heads/".length) } : {}),
				...(fields.some((field) => field === "locked" || field.startsWith("locked ")) ? { locked: true } : {}),
				...(fields.some((field) => field === "prunable" || field.startsWith("prunable ")) ? { prunable: true } : {}),
			}
		})
}

function prepareRepository(cwd: string, branch: string): string {
	const checkedBranch = git(cwd, ["check-ref-format", "--branch", branch])
	if (checkedBranch !== branch) throw new Error("Use a literal branch name instead of previous-checkout shorthand.")
	const root = git(cwd, ["rev-parse", "--show-toplevel"])
	try {
		git(cwd, ["rev-parse", "--verify", "HEAD^{commit}"])
	} catch {
		throw new Error("The repository has no HEAD commit. Create an initial commit before starting a worktree or branch.")
	}
	return realpathSync(root)
}

function hasBranch(cwd: string, branch: string): boolean {
	return git(cwd, ["for-each-ref", "--format=%(refname)", `refs/heads/${branch}`]) === `refs/heads/${branch}`
}

function requireAvailable(worktree: Worktree): void {
	if (worktree.locked) throw new Error(`Worktree ${worktree.path} is locked. Unlock it before using it.`)
	if (worktree.prunable)
		throw new Error(`Worktree ${worktree.path} is prunable. Repair its registration before using it.`)
	if (!statSync(worktree.path, { throwIfNoEntry: false })?.isDirectory()) {
		throw new Error(`Worktree ${worktree.path} is missing. Repair its registration before using it.`)
	}
}

function requireVacantDestination(path: string, base: string): void {
	for (let current = path; ; current = dirname(current)) {
		const entry = lstatSync(current, { throwIfNoEntry: false })
		if (entry?.isSymbolicLink())
			throw new Error(`Worktree destination ${current} is a symbolic link. Choose another branch.`)
		if (entry && (current === path || !entry.isDirectory())) {
			throw new Error(`Worktree destination ${current} already exists. Choose another branch.`)
		}
		if (current === base) return
	}
}

export function prepareWorktree(cwd: string, branch: string): PreparedWorktree {
	const source = prepareRepository(cwd, branch)
	const worktrees = listWorktrees(cwd)
	const existing = worktrees.find((worktree) => worktree.branch === branch)
	if (existing) {
		requireAvailable(existing)
		if (realpathSync(existing.path) === source) {
			throw new Error(`Branch ${branch} is the current checkout. Choose a different branch for an isolated worktree.`)
		}
		return { path: existing.path, branch, created: false }
	}
	const base = `${worktrees[0].path}.worktrees`
	const path = join(base, branch)
	requireVacantDestination(path, base)
	const existingBranch = hasBranch(cwd, branch)
	git(cwd, ["worktree", "add", ...(existingBranch ? [] : ["-b", branch]), "--", path, existingBranch ? branch : "HEAD"])
	return { path, branch, created: true }
}

export function prepareBranch(cwd: string, branch: string): PreparedWorktree {
	const path = prepareRepository(cwd, branch)
	const existing = listWorktrees(cwd).find((worktree) => worktree.branch === branch)
	if (existing) {
		requireAvailable(existing)
		if (realpathSync(existing.path) !== path) {
			throw new Error(
				`Branch ${branch} is already checked out at ${existing.path}. Use --worktree ${branch} to open it.`,
			)
		}
		return { path, branch, created: false }
	}
	const created = !hasBranch(cwd, branch)
	git(cwd, ["switch", ...(created ? ["-c"] : []), branch])
	return { path, branch, created }
}
