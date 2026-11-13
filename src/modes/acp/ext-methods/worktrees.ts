/**
 * `_kimchi.dev/worktree/create|list|remove` ext methods (slice 4).
 *
 * The TUI's restart-in-place dance has no ACP equivalent (the client owns
 * process lifecycle), so IDE clients manage worktrees explicitly: create +
 * list + remove here, then open a session with `cwd` set to the worktree
 * directory. Handlers are sessionless — the repo is identified by the
 * `cwd` param (falling back to the server's cwd).
 */

import { basename, join } from "node:path"

import {
	createWorktree,
	generateWorktreeName,
	listWorktrees,
	removeWorktree,
	resolveRepoRoots,
	validateWorktreeName,
	WORKTREE_BRANCH_PREFIX,
	WorktreeError,
	worktreeStatus,
} from "../../../shared/git/worktree.js"
import { emitWorktreeHook } from "../../../worktree-hooks.js"

export interface WorktreeCreateResult {
	name: string
	dir: string
	branch: string
	mainRoot: string
	baseRef: string
}

export interface WorktreeRow {
	name: string
	branch: string
	path: string
	/** clean | dirty | commits | dirty+commits | gone */
	status: string
}

function requireCwd(params: Record<string, unknown>): string {
	const cwd = params.cwd
	if (typeof cwd !== "string" || !cwd) throw new WorktreeError("cwd is required")
	return cwd
}

function optionalName(params: Record<string, unknown>): string | undefined {
	const name = params.name
	return typeof name === "string" && name ? name : undefined
}

export async function handleWorktreeCreate(params: Record<string, unknown>): Promise<WorktreeCreateResult> {
	const cwd = requireCwd(params)
	const name = optionalName(params) ?? generateWorktreeName()
	validateWorktreeName(name)
	const { mainRoot, worktreeRoot } = resolveRepoRoots(cwd)
	if (worktreeRoot) throw new WorktreeError("nested worktrees are not supported (cwd is already a linked worktree)")
	const created = await createWorktree({ mainRoot, name, baseRef: "fresh" })
	await emitWorktreeHook(
		"WorktreeCreate",
		{ name: created.name, dir: created.path, branch: created.branch, mainRoot, kind: "user" },
		false,
	)
	return { name: created.name, dir: created.path, branch: created.branch, mainRoot, baseRef: created.baseRef }
}

export async function handleWorktreeList(params: Record<string, unknown>): Promise<{ worktrees: WorktreeRow[] }> {
	const cwd = requireCwd(params)
	const { mainRoot } = resolveRepoRoots(cwd)
	const managed = join(mainRoot, ".kimchi", "worktrees")
	const entries = (await listWorktrees(mainRoot)).filter(
		(entry) => !entry.isMain && entry.path.startsWith(`${managed}/`),
	)
	const worktrees: WorktreeRow[] = await Promise.all(
		entries.map(async (entry) => {
			let status = "gone"
			try {
				const s = await worktreeStatus(entry.path, mainRoot)
				const dirty = s.dirty || s.untracked
				const commits = s.ownCommits > 0
				status = dirty && commits ? "dirty+commits" : dirty ? "dirty" : commits ? "commits" : "clean"
			} catch {
				// registration lingers but the directory is gone
			}
			return { name: basename(entry.path), branch: entry.branch, path: entry.path, status }
		}),
	)
	return { worktrees }
}

export async function handleWorktreeRemove(params: Record<string, unknown>): Promise<{ removed: boolean }> {
	const cwd = requireCwd(params)
	const name = optionalName(params)
	if (!name) throw new WorktreeError("name is required")
	validateWorktreeName(name)
	const { mainRoot } = resolveRepoRoots(cwd)
	const dir = join(mainRoot, ".kimchi", "worktrees", name)
	const branch = `${WORKTREE_BRANCH_PREFIX}${name}`
	const force = params.force === true
	if (!force) {
		const status = await worktreeStatus(dir, mainRoot)
		if (status.dirty || status.untracked || status.ownCommits > 0) {
			throw new WorktreeError(
				"worktree contains work (dirty, untracked, or unpushed commits) — pass force: true to discard",
			)
		}
	}
	await removeWorktree({ dir, branch, force })
	await emitWorktreeHook("WorktreeRemove", { name, dir, branch, mainRoot, kind: "user" }, false)
	return { removed: true }
}
