import { isUtf8 } from "node:buffer"
import { execFile } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { constants, existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs"
import { access, mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative } from "node:path"
import {
	createEditTool,
	createWriteTool,
	type EditOperations,
	getAgentDir,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent"
import { getNote, isWorkId, setNote } from "@getkimchi/kimchi-bridge/ledger"
import { reconcileRepositoryTransitions } from "@getkimchi/kimchi-bridge/reconcile"
import {
	appendWorkRecord,
	getToolRequest,
	getWorkId,
	pinWorkContext,
	tryWorkAttribution,
	tryWorkAttributionAsync,
	type WorkContext,
} from "../work-attribution.js"
import { MAX_HUNK_BYTES } from "./file-hunks.js"
import { readWorkRecordsOfType, SHA256_HEX, type WorkRecord } from "./summary.js"

const GIT_TIMEOUT_MS = 2000
const MAX_FILE_BYTES = 8 * 1024 * 1024
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
/** Git commits an ignored file only when forced, so its text is not worth keeping. A failed check keeps none either. */
async function ignored(worktree: string, path: string): Promise<boolean> {
	try {
		return Boolean(await git(worktree, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", path]))
	} catch {
		return true
	}
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
/** A5 bookkeeping namespace: ref-tip snapshots keyed by their content hash. */
const REF_TIPS_NOTES = "ref-tips"
function historyBoundaryPath(id: string): string {
	return join(getAgentDir(), "work-attribution", "ref-tips", `${id}.json`)
}
function parseHistoryBoundary(text: string, id: string): string[] {
	const value = JSON.parse(text)
	if (value?.version !== 1 || !validRefTips(value.refTips) || digest(Buffer.from(JSON.stringify(value.refTips))) !== id)
		throw new Error("Invalid work attribution history boundary")
	return value.refTips
}
async function readHistoryBoundary(id: string): Promise<string[]> {
	// A5: the note is the authority for new evidence; a legacy ref-tips file still answers for old installs.
	const note = getNote(getAgentDir(), REF_TIPS_NOTES, id)
	if (note !== undefined) return parseHistoryBoundary(note, id)
	const path = historyBoundaryPath(id)
	if ((await stat(path)).size > MAX_FILE_BYTES) throw new Error("Work attribution history boundary exceeds limit")
	return parseHistoryBoundary(await readFile(path, "utf8"), id)
}
/** Publish immutable, shared evidence before a transition references it. Repeated edits stay small. */
async function saveHistoryBoundary(refTips: string[]): Promise<string> {
	const id = digest(Buffer.from(JSON.stringify(refTips)))
	// A5: one atomic note publishes the snapshot; identical content is not rewritten, damaged content is repaired.
	setNote(getAgentDir(), REF_TIPS_NOTES, id, `${JSON.stringify({ version: 1, refTips })}\n`)
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
					// A file absent from HEAD keeps its text from the write that creates it, for when it is first committed.
					const retain =
						evidence.baselineFile === null
							? !(await ignored(evidence.worktree, evidence.path))
							: evidence.before !== null
					const after = await diskState(path, written, retain ? evidence.repository : undefined)
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
async function readJournals(repository: string, checkBudget: () => void): Promise<TransitionJournal[]> {
	const journals: TransitionJournal[] = []
	const boundaries = new Map<string, string[] | undefined>()
	// Native captures write transitions only into the ledger (C2): they are the journal now. The
	// store is authoritative, so never fall back to JSONL when it holds rows for this repository.
	let ledgerTransitions: Transition[] = []
	try {
		const rows = readWorkRecordsOfType(getAgentDir(), "file_transition")
		ledgerTransitions = rows.filter(
			(row): row is WorkRecord & Transition => isTransition(row) && row.repository === repository,
		)
	} catch {
		// No store (e.g. Node unit tests without a backend); the JSONL scan below still works.
	}
	if (ledgerTransitions.length) {
		const sortKey = (row: Transition) =>
			`${row.sessionId}\u0000${row.path}\u0000${row.cursor.bytes}\u0000${row.cursor.digest}`
		const byWorktree = new Map<string, Transition[]>()
		for (const row of ledgerTransitions) {
			checkBudget()
			const group = byWorktree.get(row.worktree) ?? []
			group.push(row)
			byWorktree.set(row.worktree, group)
		}
		for (const [worktree, rows] of byWorktree) {
			rows.sort((left, right) => (sortKey(left) < sortKey(right) ? -1 : sortKey(left) > sortKey(right) ? 1 : 0))
			for (const row of rows) {
				const id = row.historyBoundaryId
				if (!id) continue
				checkBudget()
				if (!boundaries.has(id)) boundaries.set(id, await tryWorkAttributionAsync(() => readHistoryBoundary(id)))
				if (!row.refTips?.length) row.refTips = boundaries.get(id)
			}
			// digest is stable while the rows don't change, so progress checkpoints resume exactly like a growing file.
			const digestData = Buffer.from(
				JSON.stringify(
					rows.map((row) => ({
						sessionId: row.sessionId,
						path: row.path,
						cursor: row.cursor,
						recordedAt: row.recordedAt,
						historyBoundaryId: row.historyBoundaryId ?? null,
					})),
				),
			)
			journals.push({ path: transitionJournal(repository, worktree), digest: digest(digestData), transitions: rows })
		}
		return journals
	}
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
