/**
 * `kimchi worktree list|remove|prune` (slice 3).
 *
 * Operates on the kimchi-managed worktrees under `<mainRoot>/.kimchi/worktrees/`
 * only — user worktrees created elsewhere are never touched (removeWorktree
 * itself refuses paths outside that directory).
 *
 * Runs pre-session (no pi context): hook emission is fail-closed for
 * project-scoped hooks — only user-scope hook config runs from here.
 */

import { basename, join } from "node:path"

import {
	listWorktrees,
	removeWorktree,
	resolveRepoRoots,
	validateWorktreeName,
	WORKTREE_BRANCH_PREFIX,
	type WorktreeEntry,
	WorktreeError,
	worktreeStatus,
} from "../shared/git/worktree.js"
import { emitWorktreeHook } from "../worktree-hooks.js"

function printUsage(): void {
	console.log(`kimchi worktree — manage kimchi git worktrees

Usage:
  kimchi worktree list [--json]       List worktrees under .kimchi/worktrees/
  kimchi worktree remove <name> [-f]  Remove a worktree and its branch (refuses dirty work)
  kimchi worktree prune               Remove every clean, commitless kimchi worktree

Worktrees are created with \`kimchi --worktree [name]\` and by subagents spawned
with isolation: "worktree". See docs/worktrees.md.`)
}

interface Row {
	name: string
	branch: string
	path: string
	status: "clean" | "dirty" | "commits" | "dirty+commits" | "gone"
}

async function statusLabel(entry: WorktreeEntry, mainRoot: string): Promise<Row["status"]> {
	try {
		const status = await worktreeStatus(entry.path, mainRoot)
		const dirty = status.dirty || status.untracked
		const commits = status.ownCommits > 0
		if (dirty && commits) return "dirty+commits"
		if (dirty) return "dirty"
		if (commits) return "commits"
		return "clean"
	} catch {
		return "gone" // directory vanished but registration lingers — prune picks it up
	}
}

async function collectRows(mainRoot: string): Promise<WorktreeEntry[]> {
	const all = await listWorktrees(mainRoot)
	const managed = join(mainRoot, ".kimchi", "worktrees")
	return all.filter((entry) => !entry.isMain && entry.path.startsWith(`${managed}/`))
}

async function cmdList(mainRoot: string, json: boolean): Promise<number> {
	const managed = await collectRows(mainRoot)
	const rows: Row[] = await Promise.all(
		managed.map(async (entry) => ({
			name: basename(entry.path),
			branch: entry.branch,
			path: entry.path,
			status: await statusLabel(entry, mainRoot),
		})),
	)
	if (json) {
		console.log(JSON.stringify(rows, null, 2))
		return 0
	}
	if (rows.length === 0) {
		console.log("No kimchi worktrees. Start one with: kimchi --worktree <name>")
		return 0
	}
	const width = Math.max(...rows.map((r) => r.name.length))
	for (const row of rows) {
		console.log(`${row.name.padEnd(width)}  ${row.status.padEnd("dirty+commits".length)}  ${row.branch}  ${row.path}`)
	}
	return 0
}

async function cmdRemove(mainRoot: string, name: string | undefined, force: boolean): Promise<number> {
	if (!name) {
		console.error("error: missing worktree name (kimchi worktree remove <name>)")
		return 1
	}
	validateWorktreeName(name)
	const dir = join(mainRoot, ".kimchi", "worktrees", name)
	const branch = `${WORKTREE_BRANCH_PREFIX}${name}`
	if (!force) {
		const status = await worktreeStatus(dir, mainRoot)
		if (status.dirty || status.untracked || status.ownCommits > 0) {
			console.error(
				`error: worktree ${name} contains work (dirty, untracked, or ${status.ownCommits} unpushed commit(s)). ` +
					"Commit/merge it first, or pass --force to discard.",
			)
			return 1
		}
	}
	await removeWorktree({ dir, branch, force })
	await emitWorktreeHook("WorktreeRemove", { name, dir, branch, mainRoot, kind: "user" }, false)
	console.log(`Removed worktree ${name} (${dir})`)
	return 0
}

async function cmdPrune(mainRoot: string): Promise<number> {
	const managed = await collectRows(mainRoot)
	let pruned = 0
	let kept = 0
	for (const entry of managed) {
		const name = basename(entry.path)
		const status = await statusLabel(entry, mainRoot)
		if (status === "clean" || status === "gone") {
			try {
				await removeWorktree({ dir: entry.path, branch: entry.branch || `${WORKTREE_BRANCH_PREFIX}${name}` })
				await emitWorktreeHook(
					"WorktreeRemove",
					{ name, dir: entry.path, branch: entry.branch, mainRoot, kind: "user" },
					false,
				)
				console.log(`Pruned ${name} (clean)`)
				pruned++
				continue
			} catch (err) {
				console.error(`warning: could not prune ${name}: ${err instanceof Error ? err.message : String(err)}`)
			}
		}
		kept++
	}
	console.log(`Prune complete: ${pruned} removed, ${kept} kept (has work).`)
	return 0
}

export async function runWorktree(args: string[]): Promise<number> {
	const sub = args[0]
	const rest = args.slice(1)
	if (!sub || sub === "--help" || sub === "-h") {
		printUsage()
		return 0
	}
	try {
		const { mainRoot } = resolveRepoRoots(process.cwd())
		switch (sub) {
			case "list":
				return await cmdList(mainRoot, rest.includes("--json"))
			case "remove":
				return await cmdRemove(
					mainRoot,
					rest.find((a) => !a.startsWith("-")),
					rest.includes("--force") || rest.includes("-f"),
				)
			case "prune":
				return await cmdPrune(mainRoot)
			default:
				console.error(`error: unknown subcommand '${sub}'`)
				printUsage()
				return 1
		}
	} catch (err) {
		if (err instanceof WorktreeError) {
			console.error(`error: ${err.message}`)
			return 1
		}
		throw err
	}
}
