import { execFileSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants, existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs"
import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative } from "node:path"
import {
	createEditTool,
	createWriteTool,
	type EditOperations,
	getAgentDir,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent"
import { isWorkId } from "../../shared/work-id.js"
import {
	appendWorkRecord,
	getWorkId,
	tryWorkAttribution,
	type WorkContext,
	workLedgerPath,
} from "../work-attribution.js"

const GIT_TIMEOUT_MS = 2000
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_COMMITS = 512
const RECONCILIATION_BUDGET_MS = 3000
interface FileState {
	blob: string
	mode: string
}
interface Cursor {
	bytes: number
	digest: string
}
interface Transition {
	type: "file_transition"
	transitionId: string
	toolCallId: string
	sessionId: string
	workId: string
	cwd: string
	repository: string
	worktree: string
	path: string
	baseline: string | null
	baselineFile: FileState | null
	before: FileState | null
	after: FileState
	cursor: Cursor
}
function git(cwd: string, args: string[], input?: Buffer): string {
	const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1" }
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[key]
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: MAX_FILE_BYTES,
		input,
		env,
		stdio: ["pipe", "pipe", "pipe"],
	}).trimEnd()
}
function digest(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex")
}
function same(a: FileState | null, b: FileState | null): boolean {
	return a?.blob === b?.blob && a?.mode === b?.mode
}
function supportsGitAttributes(path: string): boolean {
	// Attribute files may themselves have changed during the native write.
	const attrs = git(dirname(path), ["check-attr", "-z", "filter", "working-tree-encoding", "--", path]).split("\0")
	for (let i = 2; i < attrs.length; i += 3) if (attrs[i] !== "unspecified" && attrs[i] !== "unset") return false
	return true
}
function diskState(path: string): FileState | null | undefined {
	if (!existsSync(path)) return null
	const stat = lstatSync(path)
	if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("Unsupported file for work attribution")
	if (!supportsGitAttributes(path)) return undefined
	const parent = dirname(path)
	let mode = stat.mode & 0o111 ? "100755" : "100644"
	if (git(parent, ["config", "--type=bool", "--default=true", "--get", "core.filemode"]) === "false") {
		mode = git(parent, ["ls-files", "--stage", "--", path]).split(" ")[0] || "100644"
	}
	return { blob: git(parent, ["hash-object", "--stdin", `--path=${path}`], readFileSync(path)), mode }
}
function treeState(cwd: string, sha: string | null, path: string): FileState | null {
	if (!sha) return null
	const entry = git(cwd, ["ls-tree", "-z", sha, "--", path])
	if (!entry) return null
	const [mode, kind, object] = entry.slice(0, entry.indexOf("\t")).split(" ")
	if (kind !== "blob" || (mode !== "100644" && mode !== "100755")) throw new Error("Unsupported Git file mode")
	return { blob: object, mode }
}
function reflog(worktree: string): Buffer {
	const path = git(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "logs/HEAD"])
	if (!existsSync(path)) return Buffer.alloc(0)
	if (statSync(path).size > MAX_FILE_BYTES) throw new Error("Work attribution reflog exceeds limit")
	return readFileSync(path)
}
function repositoryFile(path: string) {
	const parent = realpathSync(dirname(path))
	let worktree: string
	try {
		worktree = realpathSync(git(parent, ["rev-parse", "--show-toplevel"]))
	} catch {
		return
	}
	const relativePath = relative(worktree, join(parent, basename(path)))
	if (relativePath.startsWith("..") || isAbsolute(relativePath)) return
	const repository = realpathSync(git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
	let baseline: string | null = null
	try {
		baseline = git(worktree, ["rev-parse", "--verify", "HEAD"])
	} catch {
		/* unborn branch */
	}
	return {
		repository,
		worktree,
		path: relativePath,
		baseline,
		baselineFile: treeState(worktree, baseline, relativePath),
	}
}
/** Native tools invoke these operations inside their existing file mutation queue. */
function operations(ctx: WorkContext, toolCallId: string): EditOperations & WriteOperations {
	const sessionId = ctx.sessionManager.getSessionId()
	const pinned = { cwd: ctx.cwd, sessionManager: { getSessionId: () => sessionId } }
	const workId = tryWorkAttribution(() => getWorkId(pinned))
	let readDigest: string | undefined
	return {
		async readFile(path) {
			const data = await readFile(path)
			readDigest = digest(data)
			return data
		},
		access: (path) => access(path, constants.R_OK | constants.W_OK),
		mkdir: async (path) => {
			await mkdir(path, { recursive: true })
		},
		async writeFile(path, content) {
			const evidence = workId
				? tryWorkAttribution(() => {
						const repo = repositoryFile(path)
						if (!repo) return
						const before = diskState(path)
						if (before === undefined) return
						if (readDigest !== undefined && readDigest !== digest(readFileSync(path))) return
						return { ...repo, before }
					})
				: undefined
			await writeFile(path, content, "utf8")
			if (evidence && workId)
				tryWorkAttribution(() => {
					const after = diskState(path)
					if (!after || !readFileSync(path).equals(Buffer.from(content)) || same(evidence.before, after)) return
					const log = reflog(evidence.worktree)
					// A cursor after the successful mutation excludes pre-existing matching history.
					if (log.length && log[log.length - 1] !== 10) return
					appendWorkRecord(
						pinned,
						{
							type: "file_transition",
							transitionId: randomUUID(),
							toolCallId,
							...evidence,
							after,
							cursor: { bytes: log.length, digest: digest(log) },
						},
						workId,
						transitionJournal(evidence.repository, evidence.worktree),
					)
				})
		},
	}
}
export function createTrackedEditTool(ctx: WorkContext, toolCallId: string) {
	return createEditTool(ctx.cwd, { operations: operations(ctx, toolCallId) })
}
export function createTrackedWriteTool(ctx: WorkContext, toolCallId: string) {
	return createWriteTool(ctx.cwd, { operations: operations(ctx, toolCallId) })
}
function isState(value: unknown): value is FileState | null {
	return (
		value === null ||
		(typeof value === "object" &&
			value !== null &&
			"blob" in value &&
			typeof value.blob === "string" &&
			"mode" in value &&
			(value.mode === "100644" || value.mode === "100755"))
	)
}
function isTransition(value: Record<string, unknown>): value is Record<string, unknown> & Transition {
	return (
		value.type === "file_transition" &&
		isWorkId(value.workId) &&
		["transitionId", "toolCallId", "sessionId", "cwd", "repository", "worktree", "path"].every(
			(key) => typeof value[key] === "string",
		) &&
		(value.baseline === null || typeof value.baseline === "string") &&
		isState(value.before) &&
		isState(value.after) &&
		value.after !== null &&
		isState(value.baselineFile) &&
		typeof value.cursor === "object" &&
		value.cursor !== null &&
		"bytes" in value.cursor &&
		Number.isSafeInteger(value.cursor.bytes) &&
		Number(value.cursor.bytes) >= 0 &&
		"digest" in value.cursor &&
		typeof value.cursor.digest === "string"
	)
}
function transitionJournal(repository: string, worktree: string): string {
	return join(
		getAgentDir(),
		"work-attribution",
		"transitions",
		`${digest(Buffer.from(JSON.stringify([repository, worktree])))}.jsonl`,
	)
}
function records(path: string): Record<string, unknown>[] {
	if (!existsSync(path)) return []
	const result: Record<string, unknown>[] = []
	for (const line of readFileSync(path, "utf8").split("\n")) {
		try {
			const row = JSON.parse(line)
			if (row && typeof row === "object") result.push(row)
		} catch {
			/* interrupted append */
		}
	}
	return result
}
/** Only exact, uniquely owned file transitions are evidence of a contribution. */
export function reconcileFileTransitions(ctx: WorkContext): void {
	tryWorkAttribution(() => {
		let worktree: string
		try {
			worktree = realpathSync(git(ctx.cwd, ["rev-parse", "--show-toplevel"]))
		} catch {
			return
		}
		const repository = realpathSync(git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
		const deadline = Date.now() + RECONCILIATION_BUDGET_MS
		const journal = transitionJournal(repository, worktree)
		if (!existsSync(journal)) return
		if (statSync(journal).size > MAX_FILE_BYTES)
			throw new Error("Work attribution transition journal exceeds reconciliation limit")
		const transitions = records(journal)
			.filter(isTransition)
			.filter((row) => row.worktree === worktree && row.repository === repository)
		if (!transitions.length) return
		const sessionIds = new Set(transitions.map((row) => row.sessionId))
		const all: Record<string, unknown>[] = []
		for (const sessionId of sessionIds) {
			if (Date.now() > deadline) throw new Error("Work attribution reconciliation time limit exceeded")
			all.push(
				...records(workLedgerPath({ cwd: ctx.cwd, sessionManager: { getSessionId: () => sessionId } })).filter(
					(row) => row.type === "commit",
				),
			)
		}
		const log = reflog(worktree)
		const prefixDigests = new Map<number, string>()
		const valid = transitions.filter((row) => {
			if (Date.now() > deadline) throw new Error("Work attribution reconciliation time limit exceeded")
			if (row.cursor.bytes > log.length) return false
			if (!prefixDigests.has(row.cursor.bytes))
				prefixDigests.set(row.cursor.bytes, digest(log.subarray(0, row.cursor.bytes)))
			return prefixDigests.get(row.cursor.bytes) === row.cursor.digest
		})
		if (!valid.length) return
		const start = Math.min(...valid.map((row) => row.cursor.bytes))
		const lines = log.subarray(start).toString("utf8").split("\n")
		lines.pop() // Never accept an incomplete reflog transaction.
		const candidates: { sha: string; position: number; invalidatedBefore: number }[] = []
		let offset = start
		let invalidatedBefore = -1
		for (const line of lines) {
			const position = offset
			offset += Buffer.byteLength(line) + 1
			const action = line.slice(line.indexOf("\t") + 1)
			if (["commit:", "commit (initial):", "commit (amend):"].some((prefix) => action.startsWith(prefix))) {
				candidates.push({ sha: line.split(" ")[1], position, invalidatedBefore })
			} else invalidatedBefore = position
		}
		// Recent commits make progress even when older evidence exceeds the lookup budget.
		for (const { sha, position, invalidatedBefore } of candidates.slice(-MAX_COMMITS).reverse()) {
			if (Date.now() > deadline) throw new Error("Work attribution reconciliation time limit exceeded")
			const parents = git(worktree, ["rev-list", "--parents", "-n", "1", sha]).split(" ").slice(1)
			if (parents.length > 1) continue
			const parent = parents[0] ?? null
			const groups = new Map<string, Transition[]>()
			for (const row of valid) {
				if (row.cursor.bytes > position) continue
				const key = row.path
				const group = groups.get(key) ?? []
				group.push(row)
				groups.set(key, group)
			}
			const parentFiles = new Map<string, FileState | null>()
			const owners = new Map<string, Set<string>>()
			for (const [path, group] of groups) {
				if (Date.now() > deadline) throw new Error("Work attribution reconciliation time limit exceeded")
				const parentFile = treeState(worktree, parent, path)
				parentFiles.set(path, parentFile)
				owners.set(path, new Set(group.filter((row) => same(row.baselineFile, parentFile)).map((row) => row.workId)))
			}
			const matched = new Map<string, { owner: Transition; paths: string[]; transitionIds: string[] }>()
			for (const originalGroup of groups.values()) {
				if (Date.now() > deadline) throw new Error("Work attribution reconciliation time limit exceeded")
				if (owners.get(originalGroup[0].path)?.size !== 1) continue
				// Noncommit ref moves may have discarded these changes; keep them only as ambiguity evidence.
				const group = originalGroup.filter((row) => row.cursor.bytes > invalidatedBefore)
				if (!group.length) continue
				// Start at the commit parent's clean state, then require every later edit to connect.
				const parentFile = parentFiles.get(group[0].path) ?? null
				const starts = group.filter((row) => same(row.before, parentFile) && same(row.baselineFile, row.before))
				if (starts.length !== 1) continue
				const first = starts[0]
				const chain = group.slice(group.indexOf(first))
				if (
					!chain.every(
						(row, index) => row.workId === first.workId && (index === 0 || same(row.before, chain[index - 1].after)),
					)
				)
					continue
				const after = chain[chain.length - 1].after
				if (same(first.before, after) || !same(treeState(worktree, sha, first.path), after)) continue

				if (
					all.some(
						(row) =>
							row.type === "commit" &&
							row.sha === sha &&
							row.workId === first.workId &&
							row.repository === repository &&
							row.worktree === worktree &&
							(!Array.isArray(row.paths) || row.paths.includes(first.path)),
					)
				)
					continue
				const key = JSON.stringify([first.sessionId, first.workId])
				const match = matched.get(key) ?? { owner: first, paths: [], transitionIds: [] }
				match.paths.push(first.path)
				match.transitionIds.push(...chain.map((row) => row.transitionId))
				matched.set(key, match)
			}
			for (const match of matched.values()) {
				const fields = {
					type: "commit",
					source: "native-file-transition",
					sha,
					repository,
					worktree,
					paths: match.paths.sort(),
					transitionIds: match.transitionIds,
				}
				appendWorkRecord(
					{ cwd: match.owner.cwd, sessionManager: { getSessionId: () => match.owner.sessionId } },
					fields,
					match.owner.workId,
				)
				all.push({ ...fields, workId: match.owner.workId })
			}
		}
	})
}
