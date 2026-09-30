import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants, existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
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
	pinWorkContext,
	tryWorkAttribution,
	tryWorkAttributionAsync,
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
/** Asynchronous so attribution never blocks the event loop that renders the TUI. */
function git(cwd: string, args: string[], options: { input?: Buffer; signal?: AbortSignal } = {}): Promise<string> {
	const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1" }
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[key]
	return new Promise((resolve, reject) => {
		const child = execFile(
			"git",
			["-C", cwd, ...args],
			{ encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_FILE_BYTES, env, signal: options.signal },
			(error, stdout) => (error ? reject(error) : resolve(stdout.trimEnd())),
		)
		// Git may exit before reading stdin; the command's own result reports any failure.
		child.stdin?.on("error", () => {})
		child.stdin?.end(options.input)
	})
}
function digest(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex")
}
function same(a: FileState | null, b: FileState | null): boolean {
	return a?.blob === b?.blob && a?.mode === b?.mode
}
async function supportsGitAttributes(path: string): Promise<boolean> {
	// Attribute files may themselves have changed during the native write.
	const attrs = (await git(dirname(path), ["check-attr", "-z", "filter", "working-tree-encoding", "--", path])).split(
		"\0",
	)
	for (let i = 2; i < attrs.length; i += 3) if (attrs[i] !== "unspecified" && attrs[i] !== "unset") return false
	return true
}
/** `data` is the file content already read by the caller, so the hash matches what it checked. */
async function diskState(path: string, data?: Buffer): Promise<FileState | null | undefined> {
	if (!existsSync(path)) return null
	const stat = lstatSync(path)
	if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("Unsupported file for work attribution")
	if (!(await supportsGitAttributes(path))) return undefined
	const parent = dirname(path)
	let mode = stat.mode & 0o111 ? "100755" : "100644"
	if ((await git(parent, ["config", "--type=bool", "--default=true", "--get", "core.filemode"])) === "false") {
		mode = (await git(parent, ["ls-files", "--stage", "--", path])).split(" ")[0] || "100644"
	}
	const input = data ?? readFileSync(path)
	return { blob: await git(parent, ["hash-object", "--stdin", `--path=${path}`], { input }), mode }
}
async function treeState(
	cwd: string,
	sha: string | null,
	path: string,
	signal?: AbortSignal,
): Promise<FileState | null> {
	if (!sha) return null
	const entry = await git(cwd, ["ls-tree", "-z", sha, "--", path], { signal })
	if (!entry) return null
	const [mode, kind, object] = entry.slice(0, entry.indexOf("\t")).split(" ")
	if (kind !== "blob" || (mode !== "100644" && mode !== "100755")) throw new Error("Unsupported Git file mode")
	return { blob: object, mode }
}
async function reflog(worktree: string, signal?: AbortSignal): Promise<Buffer> {
	const path = await git(worktree, ["rev-parse", "--path-format=absolute", "--git-path", "logs/HEAD"], { signal })
	if (!existsSync(path)) return Buffer.alloc(0)
	if (statSync(path).size > MAX_FILE_BYTES) throw new Error("Work attribution reflog exceeds limit")
	return readFileSync(path)
}
async function repositoryFile(path: string) {
	const parent = realpathSync(dirname(path))
	let worktree: string
	try {
		worktree = realpathSync(await git(parent, ["rev-parse", "--show-toplevel"]))
	} catch {
		return
	}
	const relativePath = relative(worktree, join(parent, basename(path)))
	if (relativePath.startsWith("..") || isAbsolute(relativePath)) return
	const repository = realpathSync(await git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
	let baseline: string | null = null
	try {
		baseline = await git(worktree, ["rev-parse", "--verify", "HEAD"])
	} catch {
		/* unborn branch */
	}
	return {
		repository,
		worktree,
		path: relativePath,
		baseline,
		baselineFile: await treeState(worktree, baseline, relativePath),
	}
}
/** Native tools invoke these operations inside their existing file mutation queue. */
function operations(ctx: WorkContext, toolCallId: string): EditOperations & WriteOperations {
	const pinned = pinWorkContext(ctx)
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
				? await tryWorkAttributionAsync(async () => {
						const repo = await repositoryFile(path)
						if (!repo) return
						const before = await diskState(path)
						if (before === undefined) return
						if (readDigest !== undefined && readDigest !== digest(readFileSync(path))) return
						return { ...repo, before }
					})
				: undefined
			await writeFile(path, content, "utf8")
			if (evidence && workId)
				await tryWorkAttributionAsync(async () => {
					const written = existsSync(path) ? readFileSync(path) : undefined
					if (!written?.equals(Buffer.from(content))) return
					const after = await diskState(path, written)
					if (!after || same(evidence.before, after)) return
					const log = await reflog(evidence.worktree)
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
interface CommitCandidate {
	sha: string
	position: number
	invalidatedBefore: number
}

function commitsFromReflog(log: Buffer, start: number): CommitCandidate[] {
	const lines = log.subarray(start).toString("utf8").split("\n")
	lines.pop() // Never accept an incomplete reflog transaction.
	const candidates: CommitCandidate[] = []
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
	return candidates.slice(-MAX_COMMITS).reverse()
}

/** Match a complete, single-work edit chain to each file's parent and committed states. */
async function matchCommitTransitions(
	worktree: string,
	commit: CommitCandidate,
	transitions: Transition[],
	checkBudget: () => void,
	signal?: AbortSignal,
): Promise<Transition[]> {
	const parents = (await git(worktree, ["rev-list", "--parents", "-n", "1", commit.sha], { signal }))
		.split(" ")
		.slice(1)
	if (parents.length > 1) return []
	const parent = parents[0] ?? null
	const transitionsByPath = new Map<string, Transition[]>()
	for (const transition of transitions) {
		if (transition.cursor.bytes > commit.position) continue
		const group = transitionsByPath.get(transition.path) ?? []
		group.push(transition)
		transitionsByPath.set(transition.path, group)
	}

	const matched: Transition[] = []
	for (const [path, fileTransitions] of transitionsByPath) {
		checkBudget()
		const parentFile = await treeState(worktree, parent, path, signal)
		checkBudget()
		// Discarded edits still count as competing ownership evidence.
		const owners = new Set(fileTransitions.filter((row) => same(row.baselineFile, parentFile)).map((row) => row.workId))
		if (owners.size !== 1) continue
		const surviving = fileTransitions.filter((row) => row.cursor.bytes > commit.invalidatedBefore)
		// Start at the commit parent's clean state, then require every later edit to connect.
		const starts = surviving.filter((row) => same(row.before, parentFile) && same(row.baselineFile, row.before))
		if (starts.length !== 1) continue
		const first = starts[0]
		const chain = surviving.slice(surviving.indexOf(first))
		if (
			!chain.every(
				(row, index) => row.workId === first.workId && (index === 0 || same(row.before, chain[index - 1].after)),
			)
		)
			continue
		const after = chain[chain.length - 1].after
		if (same(first.before, after) || !same(await treeState(worktree, commit.sha, path, signal), after)) continue
		matched.push(...chain)
	}
	return matched
}

/** Keep one contribution per work/session, including every matching file transition. */
function appendCommitContributions(
	sha: string,
	transitions: Transition[],
	recordedCommits: Record<string, unknown>[],
): void {
	const contributions = new Map<string, { owner: Transition; paths: string[]; transitionIds: string[] }>()
	for (const transition of transitions) {
		const recorded = recordedCommits.some(
			(row) =>
				row.sha === sha &&
				row.workId === transition.workId &&
				row.sessionId === transition.sessionId &&
				row.repository === transition.repository &&
				row.worktree === transition.worktree &&
				(!Array.isArray(row.paths) || row.paths.includes(transition.path)),
		)
		if (recorded) continue
		const key = JSON.stringify([transition.sessionId, transition.workId])
		const contribution = contributions.get(key) ?? { owner: transition, paths: [], transitionIds: [] }
		if (!contribution.paths.includes(transition.path)) contribution.paths.push(transition.path)
		contribution.transitionIds.push(transition.transitionId)
		contributions.set(key, contribution)
	}
	for (const { owner, paths, transitionIds } of contributions.values()) {
		const fields = {
			type: "commit",
			source: "native-file-transition",
			sha,
			repository: owner.repository,
			worktree: owner.worktree,
			paths: paths.sort(),
			transitionIds,
		}
		appendWorkRecord({ cwd: owner.cwd, sessionManager: { getSessionId: () => owner.sessionId } }, fields, owner.workId)
		recordedCommits.push({ ...fields, workId: owner.workId, sessionId: owner.sessionId })
	}
}

/**
 * Only exact, uniquely owned file transitions are evidence of a contribution.
 * Runs in the background; `signal` stops it at the next checkpoint without a warning.
 */
export async function reconcileFileTransitions(ctx: WorkContext, signal?: AbortSignal): Promise<void> {
	await tryWorkAttributionAsync(async () => {
		try {
			await reconcile(ctx, signal)
		} catch (error) {
			if (!signal?.aborted) throw error
		}
	})
}
async function reconcile(ctx: WorkContext, signal?: AbortSignal): Promise<void> {
	let worktree: string
	try {
		worktree = realpathSync(await git(ctx.cwd, ["rev-parse", "--show-toplevel"], { signal }))
	} catch {
		return
	}
	const repository = realpathSync(
		await git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { signal }),
	)
	const deadline = Date.now() + RECONCILIATION_BUDGET_MS
	const checkBudget = () => {
		signal?.throwIfAborted()
		if (Date.now() > deadline) throw new Error("Work attribution reconciliation time limit exceeded")
	}
	const journal = transitionJournal(repository, worktree)
	if (!existsSync(journal)) return
	if (statSync(journal).size > MAX_FILE_BYTES)
		throw new Error("Work attribution transition journal exceeds reconciliation limit")
	const journalDigest = digest(readFileSync(journal))
	const transitions = records(journal)
		.filter(isTransition)
		.filter((row) => row.worktree === worktree && row.repository === repository)
	if (!transitions.length) return
	const sessionIds = new Set(transitions.map((row) => row.sessionId))
	const recordedCommits: Record<string, unknown>[] = []
	for (const sessionId of sessionIds) {
		checkBudget()
		recordedCommits.push(
			...records(workLedgerPath({ cwd: ctx.cwd, sessionManager: { getSessionId: () => sessionId } })).filter(
				(row) => row.type === "commit",
			),
		)
	}
	const log = await reflog(worktree, signal)
	const prefixDigests = new Map<number, string>()
	const validTransitions = transitions.filter((row) => {
		checkBudget()
		if (row.cursor.bytes > log.length) return false
		if (!prefixDigests.has(row.cursor.bytes))
			prefixDigests.set(row.cursor.bytes, digest(log.subarray(0, row.cursor.bytes)))
		return prefixDigests.get(row.cursor.bytes) === row.cursor.digest
	})
	if (!validTransitions.length) return
	const start = Math.min(...validTransitions.map((row) => row.cursor.bytes))
	const candidates = commitsFromReflog(log, start)

	// Resume only completed candidates from the same evidence snapshot, including unresolved ones.
	const evidence = `sessions-v1:${journalDigest}:${digest(log)}`
	const progressPath = `${journal}.progress`
	const progress = records(progressPath).at(-1)
	const completed =
		progress?.evidence === evidence ? candidates.findIndex((row) => row.position === progress.position) : -1
	for (const candidate of candidates.slice(completed + 1)) {
		checkBudget()
		const matched = await matchCommitTransitions(worktree, candidate, validTransitions, checkBudget, signal)
		appendCommitContributions(candidate.sha, matched, recordedCommits)
		// Checkpoint only after the whole candidate was evaluated and its contributions were saved.
		writeFileSync(progressPath, JSON.stringify({ evidence, position: candidate.position }))
	}
}
