import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { lstatSync, readlinkSync } from "node:fs"
import { realpath } from "node:fs/promises"
import { isAbsolute, join } from "node:path"
import { promisify } from "node:util"
import { appendWorkRecord, getToolRequest, getWorkId, pinWorkContext, type WorkContext } from "../work-attribution.js"
import { debugWorkAttribution } from "./diagnostics.js"
import { type FileState, readAttributedFileStates } from "./file-transitions.js"

const execFileAsync = promisify(execFile)
const SNAPSHOT_BUDGET_MS = 1000
/** A diff of about 600,000 paths between two HEADs; above it a comparison is incomplete. */
const HEAD_DIFF_BYTES = 64 * 1024 * 1024
/** Git's empty tree by object ID length: SHA-1 and SHA-256. An unborn HEAD compares as it. */
const EMPTY_TREES: Record<number, string> = {
	40: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
	64: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321",
}
/** Changed paths kept per observation; cost allocation only needs to know that something changed. */
const MAX_OBSERVED_PATHS = 128
/** Requests that already recorded an incomplete scan; one is enough to keep their spend from being confirmed. */
const incompleteRequests = new Set<string>()
/** A Git state; for a dirty path Kimchi does not hash, a cheap identity; undefined when neither is known. */
type State = FileState | null | string | undefined
interface Snapshot {
	repository: string
	worktree: string
	head: string | null
	/** The disk state of each path git status reports. Every other path matches its HEAD entry. */
	dirty: Map<string, State>
	/** The HEAD entry of each reported path. */
	committed: Map<string, FileState | null | undefined>
	complete: boolean
}
interface Change {
	path: string
	before: FileState | null
	after: FileState | null
}

async function git(cwd: string, args: string[], signal: AbortSignal, maxBuffer = 8 * 1024 * 1024): Promise<string> {
	const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0" }
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[key]
	return (await execFileAsync("git", ["-C", cwd, ...args], { env, timeout: SNAPSHOT_BUDGET_MS, signal, maxBuffer }))
		.stdout
}

function entry(mode: string, blob: string): FileState | null {
	return /^0+$/.test(mode) ? null : { mode, blob }
}

/** A dirty symlink, nested repository, oversized or filtered file has no Git state here; it still shows a change. */
function diskIdentity(file: string): string | undefined {
	try {
		const stat = lstatSync(file, { bigint: true })
		return stat.isSymbolicLink()
			? `120000 ${createHash("sha256").update(readlinkSync(file)).digest("hex")}`
			: `${stat.ino} ${stat.size} ${stat.mtimeNs}`
	} catch {
		return undefined
	}
}

/** Only paths git status reports need a disk read; every other path matches HEAD. Never read ignored files. */
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
			head: null,
			dirty: new Map(),
			committed: new Map(),
			complete: false,
		}
		// Without rename detection a rename is its old and new path, the same two paths as before, and cheaper.
		const status = await git(
			result.worktree,
			["status", "--porcelain=v2", "--branch", "--no-ahead-behind", "-z", "--untracked-files=all", "--no-renames"],
			signal,
		)
		for (const line of status.split("\0")) {
			const fields = line.split(" ")
			if (line.startsWith("# branch.oid ")) result.head = fields[2] === "(initial)" ? null : fields[2]
			else if (fields[0] === "1") result.committed.set(fields.slice(8).join(" "), entry(fields[3], fields[6]))
			// Git reports no HEAD entry for an unmerged path.
			else if (fields[0] === "u") result.committed.set(fields.slice(10).join(" "), undefined)
			// A path removed from the index is also untracked; it keeps its HEAD entry.
			else if (fields[0] === "?") result.committed.set(line.slice(2), result.committed.get(line.slice(2)) ?? null)
			else if (line && fields[0] !== "#") return result
		}
		const paths = [...result.committed.keys()]
		// ponytail: at most 128 dirty paths per snapshot; larger windows stay explicitly incomplete.
		if (paths.length > 128 || Date.now() > deadline) return result
		if (paths.some((path) => !path || isAbsolute(path) || path.split("/").includes(".."))) return result
		const states = await readAttributedFileStates(result.worktree, paths, signal)
		if (!states) return result
		for (const [path, state] of states)
			result.dirty.set(path, state === undefined ? diskIdentity(join(result.worktree, path)) : state)
		result.complete = true
		return result
	} catch {
		return result
	}
}

/** Files changed between two complete snapshots of one worktree, or undefined when a change cannot be stated. */
async function changes(before: Snapshot, after: Snapshot): Promise<Change[] | undefined> {
	// A commit, checkout or reset changes clean paths without leaving them dirty; Git lists both HEAD entries.
	const headChanges = new Map<string, [FileState | null, FileState | null]>()
	if (before.head !== after.head) {
		const empty = EMPTY_TREES[(before.head ?? after.head ?? "").length]
		const diff = await git(
			after.worktree,
			["diff-tree", "-r", "-z", "--no-renames", before.head ?? empty, after.head ?? empty],
			AbortSignal.timeout(SNAPSHOT_BUDGET_MS),
			HEAD_DIFF_BYTES,
		)
		const fields = diff.split("\0")
		for (let index = 0; index + 1 < fields.length; index += 2) {
			const [fromMode, toMode, fromBlob, toBlob] = fields[index].slice(1).split(" ")
			headChanges.set(fields[index + 1], [entry(fromMode, fromBlob), entry(toMode, toBlob)])
		}
	}
	// A clean path has its HEAD entry: from the diff when HEAD changed it, else as the other snapshot reported it.
	const state = (snapshot: Snapshot, side: 0 | 1, path: string): State =>
		snapshot.dirty.has(path)
			? snapshot.dirty.get(path)
			: headChanges.has(path)
				? headChanges.get(path)?.[side]
				: (before.committed.has(path) ? before.committed : after.committed).get(path)
	const files: Change[] = []
	for (const path of new Set([...before.dirty.keys(), ...after.dirty.keys(), ...headChanges.keys()])) {
		const previous = state(before, 0, path)
		const current = state(after, 1, path)
		if (typeof previous === "object" && typeof current === "object") {
			if (previous?.blob !== current?.blob || previous?.mode !== current?.mode)
				files.push({ path, before: previous, after: current })
		} else if (previous === undefined || previous !== current) return
	}
	return files
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
				const changed =
					sameRepository && before.complete && after?.complete
						? await changes(before, after).catch(() => undefined)
						: undefined
				const complete = changed !== undefined
				const files = changed ?? []
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
