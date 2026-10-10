import { isUtf8 } from "node:buffer"
import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants, existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { access, mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative } from "node:path"
import {
	createEditTool,
	createWriteTool,
	type EditOperations,
	getAgentDir,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent"
import { writeFileDurably } from "../../config/json.js"
import { isWorkId } from "../../shared/work-id.js"
import { SHA } from "../pull-request-status/provider-records.js"
import {
	appendWorkRecord,
	getToolRequest,
	getWorkId,
	pinWorkContext,
	tryWorkAttribution,
	tryWorkAttributionAsync,
	type WorkContext,
	workLedgerPath,
} from "../work-attribution.js"
import { MAX_HUNK_BYTES, matchesFileHunks } from "./file-hunks.js"
import { fileMatchStrength, SHA256_HEX } from "./summary.js"

const GIT_TIMEOUT_MS = 2000
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_COMMITS = 512
const RECONCILIATION_BUDGET_MS = 3000
export interface FileState {
	blob: string
	mode: string
}
interface Cursor {
	bytes: number
	digest: string
}
export interface FileTransition {
	type: "file_transition"
	transitionId: string
	toolCallId: string
	sessionId: string
	workId: string
	requestId?: string
	branch?: string
	recordedAt?: string
	cwd: string
	repository: string
	worktree: string
	path: string
	baseline: string | null
	baselineFile: FileState | null
	before: FileState | null
	after: FileState
	cursor: Cursor
	/** Commits already visible when this edit was recorded; never infer older contribution from equal content. */
	refTips?: string[]
	historyBoundaryId?: string
}
type Transition = FileTransition
/** Asynchronous so attribution never blocks the event loop that renders the TUI. */
function gitBytes(
	cwd: string,
	args: string[],
	options: { input?: Buffer; signal?: AbortSignal; env?: Record<string, string> } = {},
): Promise<Buffer> {
	const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_LITERAL_PATHSPECS: "1", ...options.env }
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) delete env[key]
	return new Promise((resolve, reject) => {
		const child = execFile(
			"git",
			["-C", cwd, ...args],
			{ encoding: "buffer", timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_FILE_BYTES, env, signal: options.signal },
			(error, stdout) => (error ? reject(error) : resolve(stdout)),
		)
		// Git may exit before reading stdin; the command's own result reports any failure.
		child.stdin?.on("error", () => {})
		child.stdin?.end(options.input)
	})
}
async function git(
	cwd: string,
	args: string[],
	options: { input?: Buffer; signal?: AbortSignal; env?: Record<string, string> } = {},
): Promise<string> {
	return (await gitBytes(cwd, args, options)).toString("utf8").trimEnd()
}
function digest(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex")
}
function same(a: FileState | null, b: FileState | null): boolean {
	return a?.blob === b?.blob && a?.mode === b?.mode
}
/** Paths whose filter or working-tree encoding would need Git conversions Kimchi does not run. */
async function unsupportedAttributes(cwd: string, paths: string[], signal?: AbortSignal): Promise<Set<string>> {
	const attrs = (
		await git(cwd, ["check-attr", "--stdin", "-z", "filter", "working-tree-encoding"], {
			input: Buffer.from(paths.map((path) => `${path}\0`).join("")),
			signal,
		})
	).split("\0")
	const unsupported = new Set<string>()
	for (let i = 2; i < attrs.length; i += 3)
		if (attrs[i] !== "unspecified" && attrs[i] !== "unset") unsupported.add(attrs[i - 2])
	return unsupported
}
async function supportsGitAttributes(path: string): Promise<boolean> {
	// Attribute files may themselves have changed during the native write.
	return !(await unsupportedAttributes(dirname(path), [path])).size
}
/**
 * Retained snapshots live in Kimchi's own object store for each repository, never as unreachable loose objects in
 * the user's repository, where Git's automatic gc would keep repacking them and warn.
 */
function snapshotObjects(repository: string): string {
	return join(getAgentDir(), "work-attribution", "objects", createHash("sha256").update(repository).digest("hex"))
}
/**
 * `data` is the file content already read by the caller, so the hash matches what it checked. With `retainIn`, the
 * repository's Git directory, a small text snapshot is kept for later hunk matching. With `committed`, the file's blob
 * in HEAD, it is hashed first and kept only when neither the repository nor the store has it yet.
 */
async function diskState(
	path: string,
	data?: Buffer,
	retainIn?: string,
	committed?: string,
): Promise<FileState | null | undefined> {
	if (!existsSync(path)) return null
	const stat = lstatSync(path)
	if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return undefined
	// Git resolves a symlinked directory to the repository it points into, as repositoryFile does.
	const parent = realpathSync(dirname(path))
	const file = join(parent, basename(path))
	if (!(await supportsGitAttributes(file))) return undefined
	let mode = stat.mode & 0o111 ? "100755" : "100644"
	if ((await git(parent, ["config", "--type=bool", "--default=true", "--get", "core.filemode"])) === "false") {
		mode = (await git(parent, ["ls-files", "--stage", "--", file])).split(" ")[0] || "100644"
	}
	const input = data ?? readFileSync(path)
	const retain = retainIn !== undefined && input.length <= MAX_HUNK_BYTES && isUtf8(input) && !input.includes(0)
	if (retain) {
		try {
			const objects = snapshotObjects(retainIn)
			if (committed !== undefined) {
				const blob = await git(parent, ["hash-object", "--stdin", `--path=${file}`], { input })
				if (blob === committed || existsSync(join(objects, blob.slice(0, 2), blob.slice(2)))) return { blob, mode }
			}
			await mkdir(objects, { recursive: true, mode: 0o700 })
			return {
				blob: await git(parent, ["hash-object", "-w", "--stdin", `--path=${file}`], {
					input,
					env: { GIT_OBJECT_DIRECTORY: objects },
				}),
				mode,
			}
		} catch {
			// Snapshot storage is optional; a dry hash still supports whole-file attribution.
			if (!(await supportsGitAttributes(file))) return undefined
		}
	}
	return { blob: await git(parent, ["hash-object", "--stdin", `--path=${file}`], { input }), mode }
}
/** diskState without retained blobs for many paths below one worktree, in a fixed number of Git processes. */
async function diskStates(
	worktree: string,
	paths: string[],
	signal?: AbortSignal,
): Promise<Map<string, FileState | null | undefined>> {
	const states = new Map<string, FileState | null | undefined>()
	const files: { path: string; file: string; mode: string }[] = []
	for (const path of paths) {
		const file = join(worktree, path)
		const stat = existsSync(file) ? lstatSync(file) : undefined
		if (!stat) states.set(path, null)
		else if (!stat.isFile() || stat.size > MAX_FILE_BYTES) states.set(path, undefined)
		else files.push({ path, file, mode: stat.mode & 0o111 ? "100755" : "100644" })
	}
	if (!files.length) return states
	const unsupported = await unsupportedAttributes(
		worktree,
		files.map(({ file }) => file),
		signal,
	)
	for (const { path, file } of files) if (unsupported.has(file)) states.set(path, undefined)
	const hashed = files.filter(({ file }) => !unsupported.has(file))
	if (!hashed.length) return states
	if (
		(await git(worktree, ["config", "--type=bool", "--default=true", "--get", "core.filemode"], { signal })) === "false"
	) {
		const index = (
			await git(worktree, ["ls-files", "--stage", "-z", "--", ...hashed.map(({ file }) => file)], { signal })
		).split("\0")
		for (const entry of hashed) {
			// Like `ls-files -- <path>` for each path: the first entry at or below it.
			const row = index.find((line) => {
				const path = line.slice(line.indexOf("\t") + 1)
				return path === entry.path || path.startsWith(`${entry.path}/`)
			})
			entry.mode = row?.split(" ")[0] || "100644"
		}
	}
	// One path per line; C-style quotes keep quotes, backslashes and newlines in names intact.
	const input = Buffer.from(
		hashed.map(({ file }) => `"${file.replace(/["\\]/g, "\\$&").replaceAll("\n", "\\n")}"\n`).join(""),
	)
	const blobs = (await git(worktree, ["hash-object", "--stdin-paths"], { input, signal })).split("\n")
	if (blobs.length !== hashed.length) throw new Error("Invalid Git hash response")
	for (const [index, { path, mode }] of hashed.entries()) states.set(path, { blob: blobs[index], mode })
	return states
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
	let branch: string | undefined
	try {
		branch = await git(worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"])
	} catch {
		/* detached HEAD */
	}
	return {
		repository,
		worktree,
		path: relativePath,
		baseline,
		baselineFile: await treeState(worktree, baseline, relativePath),
		branch,
	}
}
async function referenceTips(repository: string, baseline: string | null): Promise<string[]> {
	// rev-list peels annotated tags and ignores refs to trees or blobs.
	const refs = await git(repository, ["rev-list", "--all", "--no-walk"])
	const worktrees = await git(repository, ["worktree", "list", "--porcelain", "-z"])
	const heads = worktrees
		.split("\0")
		.filter((field) => field.startsWith("HEAD "))
		.map((field) => field.slice(5))
	const tips = [
		...new Set(
			[...refs.split("\n"), ...heads, baseline].filter((sha): sha is string => Boolean(sha) && !/^0+$/.test(sha ?? "")),
		),
	]
	return tips.sort()
}
function validRefTips(value: unknown): value is string[] {
	return (
		Array.isArray(value) && value.every((sha) => typeof sha === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha))
	)
}
function historyBoundaryPath(id: string): string {
	return join(getAgentDir(), "work-attribution", "ref-tips", `${id}.json`)
}
async function readHistoryBoundary(id: string): Promise<string[]> {
	const path = historyBoundaryPath(id)
	if ((await stat(path)).size > MAX_FILE_BYTES) throw new Error("Work attribution history boundary exceeds limit")
	const value = JSON.parse(await readFile(path, "utf8"))
	if (value?.version !== 1 || !validRefTips(value.refTips) || digest(Buffer.from(JSON.stringify(value.refTips))) !== id)
		throw new Error("Invalid work attribution history boundary")
	return value.refTips
}
/** Publish immutable, shared evidence before a transition references it. Repeated edits stay small. */
async function saveHistoryBoundary(refTips: string[]): Promise<string> {
	const id = digest(Buffer.from(JSON.stringify(refTips)))
	try {
		await readHistoryBoundary(id)
		return id
	} catch {
		// A missing or interrupted snapshot can be repaired from the current Git observation.
	}
	const path = historyBoundaryPath(id)
	await mkdir(dirname(path), { recursive: true, mode: 0o700 })
	await writeFileDurably(path, `${JSON.stringify({ version: 1, refTips })}\n`)
	return id
}
/** Native tools invoke these operations inside their existing file mutation queue. */
function operations(ctx: WorkContext, toolCallId: string): EditOperations & WriteOperations {
	const pinned = pinWorkContext(ctx)
	const request = getToolRequest(pinned, toolCallId)
	const workId = tryWorkAttribution(() => request?.workId ?? getWorkId(pinned))
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
						const before = await diskState(
							path,
							undefined,
							repo.baselineFile !== null ? repo.repository : undefined,
							repo.baselineFile?.blob,
						)
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
					const after = await diskState(
						path,
						written,
						evidence.before !== null && evidence.baselineFile !== null ? evidence.repository : undefined,
					)
					if (!after || same(evidence.before, after)) return
					const log = await reflog(evidence.worktree)
					// A cursor after the successful mutation excludes pre-existing matching history.
					if (log.length && log[log.length - 1] !== 10) return
					const historyBoundaryId = await tryWorkAttributionAsync(async () =>
						saveHistoryBoundary(await referenceTips(evidence.repository, evidence.baseline)),
					)
					appendWorkRecord(
						pinned,
						{
							type: "file_transition",
							transitionId: randomUUID(),
							toolCallId,
							...(request && { requestId: request.requestId }),
							...evidence,
							after,
							cursor: { bytes: log.length, digest: digest(log) },
							...(historyBoundaryId && { historyBoundaryId }),
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
		(value.requestId === undefined || typeof value.requestId === "string") &&
		(value.branch === undefined || typeof value.branch === "string") &&
		(value.recordedAt === undefined || typeof value.recordedAt === "string") &&
		(value.refTips === undefined || validRefTips(value.refTips)) &&
		(value.historyBoundaryId === undefined ||
			(typeof value.historyBoundaryId === "string" && SHA256_HEX.test(value.historyBoundaryId))) &&
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
	return parseRecords(readFileSync(path, "utf8"))
}
function parseRecords(text: string): Record<string, unknown>[] {
	const result: Record<string, unknown>[] = []
	for (const line of text.split("\n")) {
		try {
			const row = JSON.parse(line)
			if (row && typeof row === "object") result.push(row)
		} catch {
			/* interrupted append */
		}
	}
	return result
}
interface TransitionJournal {
	path: string
	digest: string
	transitions: FileTransition[]
}
// Journal filenames identify one immutable repository/worktree pair. Retain discovery progress across bounded scans.
const journalOwners = new Map<string, FileTransition>()
function reconciliationBudget(signal?: AbortSignal): () => void {
	const deadline = Date.now() + RECONCILIATION_BUDGET_MS
	return () => {
		signal?.throwIfAborted()
		if (Date.now() > deadline) throw new Error("Work attribution reconciliation time limit exceeded")
	}
}
async function journalPaths(): Promise<string[]> {
	const directory = join(getAgentDir(), "work-attribution", "transitions")
	try {
		return (await readdir(directory, { withFileTypes: true }))
			.filter((file) => file.isFile() && file.name.endsWith(".jsonl"))
			.map((file) => join(directory, file.name))
			.sort()
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return []
		throw error
	}
}
/** Read only enough to identify a journal, including one left by a deleted linked worktree. */
async function journalOwner(path: string): Promise<FileTransition | undefined> {
	const cached = journalOwners.get(path)
	if (cached) return cached
	const file = await open(path, "r")
	try {
		const data = Buffer.alloc(64 * 1024)
		const { bytesRead } = await file.read(data, 0, data.length, 0)
		const owner = parseRecords(data.subarray(0, bytesRead).toString("utf8")).find(isTransition)
		if (owner) journalOwners.set(path, owner)
		return owner
	} finally {
		await file.close()
	}
}
export async function knownTransitionRepositories(checkBudget: () => void = () => {}): Promise<string[]> {
	const repositories = new Set<string>()
	for (const path of await journalPaths()) {
		checkBudget()
		const owner = await journalOwner(path)
		if (owner) repositories.add(owner.repository)
	}
	return [...repositories].sort()
}
async function readJournals(repository: string, checkBudget: () => void): Promise<TransitionJournal[]> {
	const journals: TransitionJournal[] = []
	const boundaries = new Map<string, string[] | undefined>()
	for (const path of await journalPaths()) {
		checkBudget()
		const owner = await journalOwner(path)
		if (owner?.repository !== repository) continue
		if ((await stat(path)).size > MAX_FILE_BYTES)
			throw new Error("Work attribution transition journal exceeds reconciliation limit")
		const data = await readFile(path)
		const transitions = parseRecords(data.toString("utf8")).filter(isTransition)
		if (transitions.some((row) => row.repository !== repository || row.worktree !== owner.worktree))
			throw new Error("Work attribution transition journal has conflicting repository identity")
		for (const row of transitions) {
			const id = row.historyBoundaryId
			if (!id) continue
			checkBudget()
			if (!boundaries.has(id)) boundaries.set(id, await tryWorkAttributionAsync(() => readHistoryBoundary(id)))
			row.refTips = boundaries.get(id)
		}
		journals.push({ path, digest: digest(data), transitions })
	}
	return journals
}
/** Read all ownership evidence for one repository; never return a truncated set. Null outside any Git worktree. */
export async function readRepositoryTransitions(cwd: string): Promise<
	| {
			repository: string
			worktree: string
			branch?: string
			transitions: FileTransition[]
	  }
	| null
	| undefined
> {
	return tryWorkAttributionAsync(async () => {
		const checkBudget = reconciliationBudget()
		let worktree: string
		try {
			worktree = realpathSync(await git(cwd, ["rev-parse", "--show-toplevel"]))
		} catch (error) {
			// Git exits with 128 outside a worktree. Any other failure leaves ownership unknown.
			if (error instanceof Error && "code" in error && error.code === 128) return null
			throw error
		}
		const repository = realpathSync(await git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"]))
		let branch: string | undefined
		try {
			branch = await git(worktree, ["symbolic-ref", "--quiet", "--short", "HEAD"])
		} catch {
			/* detached HEAD */
		}
		const journals = await readJournals(repository, checkBudget)
		return { repository, worktree, branch, transitions: journals.flatMap((journal) => journal.transitions) }
	})
}
/** The same normalization used when native tools captured the edit. Unsupported attributes stay unknown. */
export async function readAttributedFileState(path: string): Promise<FileState | null | undefined> {
	return tryWorkAttributionAsync(() => diskState(path))
}
/** readAttributedFileState for many worktree-relative paths, using a fixed number of Git processes. */
export async function readAttributedFileStates(
	worktree: string,
	paths: string[],
	signal?: AbortSignal,
): Promise<Map<string, FileState | null | undefined> | undefined> {
	return tryWorkAttributionAsync(async () => {
		try {
			return await diskStates(worktree, paths, signal)
		} catch (error) {
			if (!signal?.aborted) throw error
		}
	})
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
	method: "file-chain" | "path-blob" | "file-hunks" = "file-chain",
	assertLease: () => void = () => {},
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
				Array.isArray(row.fileMatches) &&
				row.fileMatches.some(
					(match) =>
						match.path === transition.path &&
						match.worktree === transition.worktree &&
						(fileMatchStrength(match.method) > fileMatchStrength(method) ||
							(match.method === method &&
								Array.isArray(match.transitionIds) &&
								match.transitionIds.includes(transition.transitionId))),
				),
		)
		if (recorded) continue
		const key = JSON.stringify([transition.sessionId, transition.workId, transition.worktree])
		const contribution = contributions.get(key) ?? { owner: transition, paths: [], transitionIds: [] }
		if (!contribution.paths.includes(transition.path)) contribution.paths.push(transition.path)
		contribution.transitionIds.push(transition.transitionId)
		contributions.set(key, contribution)
	}
	for (const { owner, paths, transitionIds } of contributions.values()) {
		const fileMatches = paths.sort().map((path) => ({
			path,
			method,
			worktree: owner.worktree,
			transitionIds: transitions
				.filter(
					(row) =>
						row.sessionId === owner.sessionId &&
						row.workId === owner.workId &&
						row.worktree === owner.worktree &&
						row.path === path,
				)
				.map((row) => row.transitionId),
		}))
		const fields = {
			type: "commit",
			source: "native-file-transition",
			sha,
			repository: owner.repository,
			worktree: owner.worktree,
			paths: paths.sort(),
			transitionIds,
			fileMatches,
		}
		assertLease()
		appendWorkRecord({ cwd: owner.cwd, sessionManager: { getSessionId: () => owner.sessionId } }, fields, owner.workId)
		recordedCommits.push({ ...fields, workId: owner.workId, sessionId: owner.sessionId })
	}
}

/** Reconcile this repository, including contribution journals from its other or deleted worktrees. */
export async function reconcileFileTransitions(ctx: WorkContext, signal?: AbortSignal): Promise<void> {
	await tryWorkAttributionAsync(async () => {
		try {
			let repository: string
			try {
				repository = realpathSync(
					await git(ctx.cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { signal }),
				)
			} catch {
				return
			}
			await reconcileRepositoryTransitions(repository, signal)
		} catch (error) {
			if (!signal?.aborted) throw error
		}
	})
}
interface JournalHistory {
	journal: TransitionJournal
	log?: Buffer
	transitions: FileTransition[]
}
async function readJournalHistory(journal: TransitionJournal, signal?: AbortSignal): Promise<JournalHistory> {
	const worktree = journal.transitions[0]?.worktree
	if (!worktree || !existsSync(worktree)) return { journal, transitions: journal.transitions }
	let repository: string
	try {
		repository = realpathSync(
			await git(worktree, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { signal }),
		)
	} catch {
		signal?.throwIfAborted()
		return { journal, transitions: journal.transitions }
	}
	// The path can outlive its old checkout. Its saved ref boundary still belongs to the original repository.
	if (repository !== journal.transitions[0].repository) return { journal, transitions: journal.transitions }
	const log = await reflog(worktree, signal)
	const prefixDigests = new Map<number, string>()
	const transitions = journal.transitions.filter((row) => {
		if (row.cursor.bytes > log.length) return false
		if (!prefixDigests.has(row.cursor.bytes))
			prefixDigests.set(row.cursor.bytes, digest(log.subarray(0, row.cursor.bytes)))
		return prefixDigests.get(row.cursor.bytes) === row.cursor.digest
	})
	return { journal, log, transitions }
}
async function reconcileExactHistory(
	history: JournalHistory,
	recordedCommits: Record<string, unknown>[],
	checkBudget: () => void,
	assertLease: () => void,
	signal?: AbortSignal,
): Promise<void> {
	const { journal, log, transitions } = history
	if (!log || !transitions.length) return
	const start = Math.min(...transitions.map((row) => row.cursor.bytes))
	const candidates = commitsFromReflog(log, start)
	// Resume only completed candidates from the same evidence snapshot, including unresolved ones.
	const evidence = `${journal.digest}:${digest(log)}`
	const progressPath = `${journal.path}.progress`
	const progress = records(progressPath).at(-1)
	const completed =
		progress?.evidence === evidence ? candidates.findIndex((row) => row.position === progress.position) : -1
	for (const candidate of candidates.slice(completed + 1)) {
		checkBudget()
		const matched = await matchCommitTransitions(transitions[0].worktree, candidate, transitions, checkBudget, signal)
		appendCommitContributions(candidate.sha, matched, recordedCommits, "file-chain", assertLease)
		// Checkpoint only after the whole candidate was evaluated and its contributions were saved.
		assertLease()
		writeFileSync(progressPath, JSON.stringify({ evidence, position: candidate.position }))
	}
}

/** HEAD actions that actually create a commit, unlike checkout/reset/pull of existing history. */
function createdAfter(log: Buffer, cursor: number): Map<string, string> {
	const commits = new Map<string, string>()
	for (const line of log.subarray(cursor).toString("utf8").split("\n")) {
		const action = line.slice(line.indexOf("\t") + 1)
		if (
			/^(?:commit(?: \(initial\)| \(amend\))?|rebase(?: -i)? \((?:pick|reword|edit|squash|fixup|continue)\)|cherry-pick):/.test(
				action,
			)
		)
			commits.set(line.split(" ")[1], action)
	}
	return commits
}
interface ContentEvidence {
	transition: FileTransition
	requireAncestry: boolean
	canMatch: boolean
}
async function contentCandidates(
	repository: string,
	histories: JournalHistory[],
	checkBudget: () => void,
	signal?: AbortSignal,
): Promise<Map<string, ContentEvidence[]>> {
	const candidates = new Map<string, ContentEvidence[]>()
	const boundaries = new Map<string, Set<string>>()
	const uncertain: ContentEvidence[] = []
	for (const history of histories) {
		const validCursors = new Set(history.transitions)
		for (const row of history.journal.transitions) {
			checkBudget()
			const cursorValid = validCursors.has(row)
			const canMatch = cursorValid || Boolean(row.refTips)
			const local = cursorValid && history.log ? createdAfter(history.log, row.cursor.bytes) : undefined
			if (!row.refTips && !local?.size) {
				uncertain.push({ transition: row, requireAncestry: false, canMatch: false })
				continue
			}
			let fresh = local ? new Set(local.keys()) : new Set<string>()
			if (row.refTips) {
				const key = JSON.stringify([row.refTips, [...fresh]])
				let boundary = boundaries.get(key)
				if (!boundary) {
					const revisions = await git(
						repository,
						["rev-list", `--max-count=${MAX_COMMITS}`, "--all", ...fresh, "--not", ...row.refTips],
						{ signal },
					)
					boundary = new Set(revisions.split("\n").filter(Boolean))
					boundaries.set(key, boundary)
				}
				fresh = boundary
			}
			for (const sha of fresh) {
				checkBudget()
				const rows = candidates.get(sha) ?? []
				rows.push({
					transition: row,
					requireAncestry: Boolean(
						cursorValid && history.log && row.baseline && !local?.get(sha)?.startsWith("rebase"),
					),
					canMatch,
				})
				candidates.set(sha, rows)
			}
		}
	}
	// Old rows without a usable time boundary can veto conflicting ownership, never create a match.
	for (const rows of candidates.values()) rows.push(...uncertain)
	return candidates
}
async function matchesCommittedHunks(
	repository: string,
	chain: FileTransition[],
	parent: FileState | null,
	committed: FileState | null,
	checkBudget: () => void,
	signal?: AbortSignal,
): Promise<boolean> {
	const before = chain[0].before
	const after = chain[chain.length - 1].after
	if (!before || !parent || !committed || [after, parent, committed].some((state) => state.mode !== before.mode))
		return false
	const blobs = [before, after, parent, committed].map((state) => state.blob)
	if (!blobs.every((blob) => SHA.test(blob))) return false
	// Snapshots come from Kimchi's store; the parent and committed blobs, and snapshots of older builds, from the repository.
	const options = {
		input: Buffer.from(blobs.map((blob) => `${blob}\n`).join("")),
		signal,
		env: { GIT_ALTERNATE_OBJECT_DIRECTORIES: snapshotObjects(repository) },
	}
	checkBudget()
	const info = (await git(repository, ["cat-file", "--batch-check=%(objecttype) %(objectsize)"], options)).split("\n")
	checkBudget()
	for (const [index, blob] of blobs.entries()) {
		// Git reports optional snapshots removed by GC separately from interrupted or failed reads.
		if (info[index] === `${blob} missing`) return false
		const size = /^blob (\d+)$/.exec(info[index] ?? "")
		if (!size) throw new Error("Invalid Git snapshot response")
		// Check the declared size before reading a commit that may contain a large human addition.
		if (Number(size[1]) > MAX_HUNK_BYTES) return false
	}
	const data = await gitBytes(repository, ["cat-file", "--batch"], options)
	checkBudget()
	const texts: string[] = []
	let offset = 0
	for (const blob of blobs) {
		// Each object is `<id> blob <size>\n<content>\n`.
		const header = data.indexOf(10, offset)
		const [id, type, size] = data.subarray(offset, header).toString("utf8").split(" ")
		if (header < 0 || id !== blob || type !== "blob" || !/^\d+$/.test(size))
			throw new Error("Invalid Git snapshot response")
		const text = data.subarray(header + 1, header + 1 + Number(size))
		offset = header + 2 + Number(size)
		if (!isUtf8(text) || text.includes(0)) return false
		texts.push(text.toString("utf8"))
	}
	return matchesFileHunks(texts[0], texts[1], texts[2], texts[3], checkBudget)
}
/** Content identity is weaker than a complete reflog chain; retain that distinction per file. */
async function matchContentTransitions(
	repository: string,
	sha: string,
	evidence: ContentEvidence[],
	checkBudget: () => void,
	signal?: AbortSignal,
): Promise<{ blobs: FileTransition[]; hunks: FileTransition[] }> {
	const matched: { blobs: FileTransition[]; hunks: FileTransition[] } = { blobs: [], hunks: [] }
	const parents = (await git(repository, ["rev-list", "--parents", "-n", "1", sha], { signal })).split(" ").slice(1)
	if (parents.length > 1) return matched
	const parent = parents[0] ?? null
	const changedPaths = new Set(
		(
			await git(repository, ["diff-tree", "--root", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", sha], {
				signal,
			})
		)
			.split("\0")
			.filter(Boolean),
	)
	const ancestry = new Map<string, boolean>()
	const byPath = new Map<string, FileTransition[]>()
	const uncertain = new Set<FileTransition>()
	for (const { transition: row, requireAncestry, canMatch } of evidence) {
		if (!changedPaths.has(row.path)) continue
		checkBudget()
		if (!canMatch) uncertain.add(row)
		// A reset to an older baseline does not prove that this work survived it.
		if (requireAncestry && row.baseline) {
			if (!ancestry.has(row.baseline)) {
				try {
					await git(repository, ["merge-base", "--is-ancestor", row.baseline, sha], { signal })
					ancestry.set(row.baseline, true)
				} catch (error) {
					// Only exit 1 means "not an ancestor"; interrupted/failed reads must remain retryable.
					if (!(error instanceof Error && "code" in error && error.code === 1)) throw error
					ancestry.set(row.baseline, false)
				}
			}
			if (!ancestry.get(row.baseline)) continue
		}
		const rows = byPath.get(row.path) ?? []
		rows.push(row)
		byPath.set(row.path, rows)
	}
	for (const [path, rows] of byPath) {
		checkBudget()
		if (new Set(rows.map((row) => row.workId)).size !== 1) continue
		const before = await treeState(repository, parent, path, signal)
		checkBudget()
		const after = await treeState(repository, sha, path, signal)
		if (same(before, after)) continue
		for (const worktree of new Set(rows.map((row) => row.worktree))) {
			let chain = rows.filter((row) => row.worktree === worktree)
			// Earlier edits already present in the parent did not contribute to this commit.
			const starts = chain.filter((row) => same(row.before, before) && same(row.before, row.baselineFile))
			if (starts.length > 1) continue
			if (starts.length === 1) chain = chain.slice(chain.indexOf(starts[0]))
			if (chain.some((row) => uncertain.has(row))) continue
			const last = chain[chain.length - 1]
			if (same(chain[0].before, last.after)) continue
			if (!chain.every((row, index) => index === 0 || same(row.before, chain[index - 1].after))) continue
			if (same(chain[0].before, chain[0].baselineFile) && same(last.after, after)) matched.blobs.push(...chain)
			else if (await matchesCommittedHunks(repository, chain, before, after, checkBudget, signal))
				matched.hunks.push(...chain)
		}
	}
	return matched
}
async function reconcileContentHistory(
	repository: string,
	histories: JournalHistory[],
	recordedCommits: Record<string, unknown>[],
	checkBudget: () => void,
	assertLease: () => void,
	signal?: AbortSignal,
): Promise<void> {
	// Missing ownership evidence must neither produce a partial match nor advance the weak-match checkpoint.
	if (histories.some(({ journal }) => journal.transitions.some((row) => row.historyBoundaryId && !row.refTips))) return
	const candidates = await contentCandidates(repository, histories, checkBudget, signal)
	const evidence = `content-v3:${histories.map(({ journal, log }) => `${journal.digest}:${log ? digest(log) : "deleted"}`).join(":")}:${[...candidates.keys()].join(":")}`
	const progressPath = `${histories[0].journal.path}.content-checkpoint`
	const progress = records(progressPath).at(-1)
	const entries = [...candidates]
	const completed = progress?.evidence === evidence ? entries.findIndex(([sha]) => sha === progress.sha) : -1
	for (const [sha, transitions] of entries.slice(completed + 1)) {
		checkBudget()
		const matched = await matchContentTransitions(repository, sha, transitions, checkBudget, signal)
		appendCommitContributions(sha, matched.blobs, recordedCommits, "path-blob", assertLease)
		appendCommitContributions(sha, matched.hunks, recordedCommits, "file-hunks", assertLease)
		assertLease()
		writeFileSync(progressPath, JSON.stringify({ evidence, sha }))
	}
}
/** The supervisor supplies its shared deadline and lease; direct callers get one bounded pass. */
export async function reconcileRepositoryTransitions(
	repository: string,
	signal?: AbortSignal,
	checkBudget = reconciliationBudget(signal),
	assertLease: () => void = () => {},
): Promise<void> {
	if (!existsSync(repository)) return
	const journals = await readJournals(repository, checkBudget)
	if (!journals.length) return
	const histories: JournalHistory[] = []
	const recordedCommits: Record<string, unknown>[] = []
	const sessions = new Set<string>()
	for (const journal of journals) {
		checkBudget()
		histories.push(await readJournalHistory(journal, signal))
		for (const row of journal.transitions) {
			if (sessions.has(row.sessionId)) continue
			sessions.add(row.sessionId)
			recordedCommits.push(
				...records(workLedgerPath({ cwd: row.cwd, sessionManager: { getSessionId: () => row.sessionId } })).filter(
					(record) => record.type === "commit",
				),
			)
		}
	}
	for (const history of histories)
		await reconcileExactHistory(history, recordedCommits, checkBudget, assertLease, signal)
	await reconcileContentHistory(repository, histories, recordedCommits, checkBudget, assertLease, signal)
}
