import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { realpath } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { promisify } from "node:util"
import { appendWorkRecord, getToolRequest, getWorkId, pinWorkContext, type WorkContext } from "../work-attribution.js"
import { debugWorkAttribution } from "./diagnostics.js"
import { type FileState, readAttributedFileStates } from "./file-transitions.js"

const execFileAsync = promisify(execFile)
const SNAPSHOT_BUDGET_MS = 1000
/** An index listing of about 600,000 paths; above it a scan is incomplete. */
const INDEX_LISTING_BYTES = 64 * 1024 * 1024
/** Changed paths kept per observation; cost allocation only needs to know that something changed. */
const MAX_OBSERVED_PATHS = 128
/** Requests that already recorded an incomplete scan; one is enough to keep their spend from being confirmed. */
const incompleteRequests = new Set<string>()
interface Snapshot {
	repository: string
	worktree: string
	files: Map<string, FileState | null | undefined>
	complete: boolean
}

async function git(cwd: string, args: string[], signal: AbortSignal, maxBuffer = 8 * 1024 * 1024): Promise<string> {
	const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[key]
	return (await execFileAsync("git", ["-C", cwd, ...args], { env, timeout: SNAPSHOT_BUDGET_MS, signal, maxBuffer }))
		.stdout
}

/** Clean files come from the index; only dirty paths need a disk read. Never read ignored files. */
async function snapshot(cwd: string): Promise<Snapshot | undefined> {
	let result: Snapshot | undefined
	try {
		const deadline = Date.now() + SNAPSHOT_BUDGET_MS
		const signal = AbortSignal.timeout(SNAPSHOT_BUDGET_MS)
		const roots = (
			await git(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], signal)
		)
			.trimEnd()
			.split("\n")
		if (roots.length !== 2) return
		result = {
			worktree: await realpath(roots[0]),
			repository: await realpath(roots[1]),
			files: new Map(),
			complete: false,
		}
		// The index listing and the dirty set are independent, so both Git processes run at once.
		const [index, porcelain] = await Promise.all([
			git(result.worktree, ["ls-files", "--stage", "-z"], signal, INDEX_LISTING_BYTES),
			// Without rename detection a rename is its old and new path, the same two paths as before, and cheaper.
			git(result.worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], signal),
		])
		for (const entry of index.split("\0")) {
			if (!entry) continue
			const match = /^(\d{6}) ([a-f\d]+) ([0-3])\t(.+)$/s.exec(entry)
			if (!match) return result
			const [, mode, blob, stage, path] = match
			// Clean symlinks and submodules keep their index state; only a dirty one is unknown.
			result.files.set(path, stage === "0" ? { mode, blob } : undefined)
		}
		const dirty = new Set(
			porcelain
				.split("\0")
				.filter(Boolean)
				.map((line) => line.slice(3)),
		)
		// ponytail: at most 128 dirty paths per snapshot; larger windows stay explicitly incomplete.
		if (dirty.size > 128 || Date.now() > deadline) return result
		const paths = [...dirty]
		if (paths.some((path) => !path || isAbsolute(path) || path.split("/").includes(".."))) return result
		const states = await readAttributedFileStates(result.worktree, paths, signal)
		if (!states) return result
		for (const [path, state] of states) result.files.set(path, state)
		result.complete = [...result.files.values()].every((state) => state !== undefined)
		return result
	} catch {
		return result
	}
}

/** A tool window can overlap human edits. Observations are candidates, never exclusive mutation proof. */
export async function observeToolFiles<T>(
	ctx: WorkContext,
	toolCallId: string,
	source: "bash" | "mcp",
	run: () => Promise<T>,
	identity?: { workId: string; requestId?: string },
): Promise<T> {
	const pinned = pinWorkContext(ctx)
	const origin = identity ?? getToolRequest(pinned, toolCallId)
	// MCP remains usable when work tracking is absent; only an attributed model tool call can opt in.
	if (source === "mcp" && !origin) return run()
	let workId: string
	try {
		workId = origin?.workId ?? getWorkId(pinned)
	} catch {
		return run()
	}
	const before = await snapshot(pinned.cwd)
	const startedAt = new Date().toISOString()
	try {
		return await run()
	} finally {
		if (before) {
			try {
				const after = await snapshot(pinned.cwd)
				const sameRepository = after?.repository === before.repository && after?.worktree === before.worktree
				const complete = before.complete && !!after?.complete && sameRepository
				const files: { path: string; before: FileState | null; after: FileState | null }[] = []
				if (sameRepository && before.complete && after?.complete) {
					for (const path of new Set([...before.files.keys(), ...after.files.keys()])) {
						const previous = before.files.get(path) ?? null
						const current = after.files.get(path) ?? null
						if (previous?.blob !== current?.blob || previous?.mode !== current?.mode)
							files.push({ path, before: previous, after: current })
					}
				}
				// One incomplete scan per request already keeps its spend from being confirmed.
				const requestId = origin?.requestId
				const repeated = !files.length && !complete && requestId !== undefined && incompleteRequests.has(requestId)
				if (!complete && requestId !== undefined) incompleteRequests.add(requestId)
				if ((files.length || !complete) && !repeated)
					appendWorkRecord(
						pinned,
						{
							type: "file_observation",
							observationId: randomUUID(),
							source,
							toolCallId,
							requestId: origin?.requestId,
							repository: before.repository,
							worktree: before.worktree,
							startedAt,
							complete,
							files: files.slice(0, MAX_OBSERVED_PATHS),
							...(files.length > MAX_OBSERVED_PATHS ? { changedPaths: files.length, truncated: true } : {}),
							...(!complete ? { reason: "incomplete-snapshot" } : {}),
						},
						workId,
					)
			} catch (error) {
				debugWorkAttribution("Could not record tool file observations:", error)
			}
		}
	}
}
