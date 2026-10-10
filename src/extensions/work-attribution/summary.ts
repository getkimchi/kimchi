import { createReadStream, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { mkdir, readdir, stat } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { setImmediate } from "node:timers/promises"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { lock } from "proper-lockfile"
import { isWorkId } from "../../shared/work-id.js"
import { mergePullRequestLinks } from "../pull-request-status/links.js"
import { debugWorkAttribution } from "./diagnostics.js"
import {
	COLLECTIONS,
	type Collection,
	ROW_KEYS,
	updateWorkRows,
	validWorkFiles,
	type WorkSummaryView,
} from "./row-log.js"

const LOCK_STALE_MS = 5000
const MERGE_BATCH_SIZE = 1000
const LOCK_RETRIES = { retries: 60, factor: 1.5, minTimeout: 25, maxTimeout: 100 }
const RECOVERY_STAMP = ".recovered.json"
const RECOVERY_VERSION = 5
// Coarse filesystem timestamps and small clock differences must not hide an append.
const RECOVERY_MTIME_SLACK_MS = 2000
/** Background reads yield to the event loop after each chunk of this size. */
const READ_CHUNK_BYTES = 1_048_576
const BUDGET_CHECK_LINES = 1024
/** The manifest stays small unless something grows without a bound; say so in diagnostics. */
const MANIFEST_WARNING_BYTES = 256 * 1024
interface SummaryEntry {
	sessionId: string
	[key: string]: unknown
}
const WORK_RECORD_TYPES = [
	"work",
	"work_link",
	"request",
	"request_dispatch",
	"request_response",
	"request_cost",
	"plan",
	"commit",
	"file_transition",
	"file_observation",
] as const
const KNOWN_RECORD_TYPES: ReadonlySet<unknown> = new Set(WORK_RECORD_TYPES)
export interface WorkRecord extends SummaryEntry {
	version: 1
	type: (typeof WORK_RECORD_TYPES)[number]
	workId: string
}
/**
 * A journal line that readWorkRecords did not return. "invalid" is damage: an unparseable line or a record that fails
 * validation. "unknown-type" is a complete version-1 record of a type this version does not know, usually written by a
 * newer Kimchi sharing this history. Readers that need complete history, such as PR cost reporting, must treat both
 * kinds as incomplete history.
 */
export type WorkRecordProblem =
	| { kind: "invalid"; path: string; line: number }
	| { kind: "unknown-type"; path: string; line: number; record: Record<string, unknown> }
interface PendingUpdate {
	records: WorkRecord[]
	complete: boolean
	/** Resolves false when the update failed and its records still need recovery. */
	promise: Promise<boolean>
}
const pending = new Map<string, PendingUpdate>()
const backgroundTasks = new Set<Promise<unknown>>()
const recoveredDirectories = new Set<string>()
/** Work IDs generated in this process: they cannot have older history to scan. */
const newWork = new Set<string>()
function logDebug(error: unknown): void {
	debugWorkAttribution("Work summary unavailable:", error)
}
export function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}
/** Hex SHA-256 digests that Kimchi writes for hashes, fingerprints and boundaries. */
export const SHA256_HEX = /^[a-f\d]{64}$/
function entry(value: unknown, fields: string[]): value is SummaryEntry {
	return (
		object(value) && typeof value.sessionId === "string" && fields.every((field) => typeof value[field] === "string")
	)
}
function record(value: unknown): value is WorkRecord {
	if (!object(value) || value.version !== 1 || !isWorkId(value.workId) || typeof value.sessionId !== "string")
		return false
	switch (value.type) {
		case "work":
			return true
		case "work_link":
			return entry(value, ["linkId", "sourceWorkId", "targetWorkId"]) && Array.isArray(value.requestIds)
		case "request":
		case "request_dispatch":
		case "request_response":
		case "request_cost":
			return entry(value, ["requestId"])
		case "plan":
			return entry(value, ["path"])
		case "commit":
			return entry(value, ["sha", "repository", "worktree"])
		case "file_transition":
			return entry(value, ["transitionId", "toolCallId", "repository", "worktree", "path"])
		case "file_observation":
			return (
				entry(value, ["observationId", "toolCallId", "repository", "worktree", "source"]) &&
				Array.isArray(value.files) &&
				typeof value.complete === "boolean"
			)
		default:
			return false
	}
}
function unknownType(value: unknown): value is Record<string, unknown> {
	return (
		object(value) &&
		value.version === 1 &&
		isWorkId(value.workId) &&
		typeof value.sessionId === "string" &&
		typeof value.type === "string" &&
		!KNOWN_RECORD_TYPES.has(value.type)
	)
}
/** Field checks for one row of each collection, in version 1 `work.json` and in the row logs. */
const ROW_CHECKS: Record<Collection, (row: unknown) => boolean> = {
	workLinks: (row) => entry(row, ["linkId", "sourceWorkId", "targetWorkId"]),
	requests: (row) => entry(row, ["requestId"]),
	plans: (row) => entry(row, ["path"]),
	commits: (row) => entry(row, ["sha", "repository", "worktree"]),
	fileTransitions: (row) => entry(row, ["transitionId", "toolCallId", "repository", "worktree", "path"]),
	fileObservations: (row) =>
		entry(row, ["observationId", "toolCallId", "repository", "worktree", "source"]) && Array.isArray(row.files),
	continuations: (row) => entry(row, ["source"]) && object(row.evidence),
}
/** Collections that summaries written before them lack. */
const LATER_COLLECTIONS = new Set<Collection>(["workLinks", "fileTransitions", "fileObservations", "continuations"])
function validSummary(value: unknown, workId: string): value is WorkSummaryView {
	return (
		object(value) &&
		value.version === 1 &&
		value.workId === workId &&
		Array.isArray(value.sessions) &&
		value.sessions.every((session) => typeof session === "string") &&
		COLLECTIONS.every((collection) => {
			const rows = value[collection]
			return (
				(rows === undefined && LATER_COLLECTIONS.has(collection)) ||
				(Array.isArray(rows) && rows.every(ROW_CHECKS[collection]))
			)
		})
	)
}
/** A valid version 1 summary, with collections it predates as empty ones. */
function versionOneSummary(value: unknown, workId: string): WorkSummaryView | undefined {
	if (!validSummary(value, workId)) return undefined
	return {
		...value,
		workLinks: value.workLinks ?? [],
		fileTransitions: value.fileTransitions ?? [],
		fileObservations: value.fileObservations ?? [],
		continuations: value.continuations ?? [],
	}
}
/** An interrupted append leaves a record cut off mid-value; any other unparseable line is damage. */
function truncated(line: string): boolean {
	const closing: string[] = []
	let inString = false
	// Where an escape sequence such as \n or \u001b began, and how many \u hex digits it still needs.
	let escapeStart = -1
	let hexDigits = 0
	for (let index = 0; index < line.length; index++) {
		const char = line[index]
		if (escapeStart >= 0) {
			if (hexDigits) {
				if (--hexDigits === 0) escapeStart = -1
			} else if (char === "u") hexDigits = 4
			else escapeStart = -1
		} else if (inString) {
			if (char === "\\") escapeStart = index
			else if (char === '"') inString = false
		} else if (char === '"') inString = true
		else if (char === "{" || char === "[") closing.push(char === "{" ? "}" : "]")
		else if ((char === "}" || char === "]") && closing.pop() !== char) return false
	}
	if (!closing.length) return false
	// Close an open string before any partial escape, or drop a partial number or literal in a value position,
	// then complete the value.
	const start = inString
		? `${escapeStart >= 0 ? line.slice(0, escapeStart) : line}"`
		: line.replace(/(?<=[:[,])[\w.+-]+$/, "")
	const end = closing.reverse().join("")
	return ["", "null", ":null", '"":null'].some((value) => {
		try {
			JSON.parse(`${start}${value}${end}`)
			return true
		} catch {
			return false
		}
	})
}
/**
 * Parses one journal line by line; `final` marks the text after its last newline, which may still be in progress.
 * A cut-off record that later appends moved past was interrupted; any other unparseable line, including a cut-off
 * final record, is damage.
 */
function journalParser(path: string, records: WorkRecord[], onRecordProblem?: (problem: WorkRecordProblem) => void) {
	let line = 0
	let cut: number[] = []
	return (text: string, final: boolean): void => {
		line++
		if (!text.trim()) {
			if (final) for (const number of cut) onRecordProblem?.({ kind: "invalid", path, line: number })
			return
		}
		// A later line shows that the cut-off records before it were interrupted appends.
		cut = []
		let value: unknown
		try {
			value = JSON.parse(text)
		} catch {
			if (final) return
			if (truncated(text)) cut.push(line)
			else onRecordProblem?.({ kind: "invalid", path, line })
			return
		}
		if (record(value)) records.push(value)
		else
			onRecordProblem?.(
				unknownType(value) ? { kind: "unknown-type", path, line, record: value } : { kind: "invalid", path, line },
			)
	}
}
export function readWorkRecords(
	agentDir: string,
	modifiedSince?: number,
	checkBudget: () => void = () => {},
	onRecordProblem?: (problem: WorkRecordProblem) => void,
): WorkRecord[] {
	checkBudget()
	const directory = join(agentDir, "work-attribution")
	if (!existsSync(directory)) return []
	const records: WorkRecord[] = []
	// Both kinds of source journals feed work.json; there is no second copy of file evidence.
	for (const source of [directory, join(directory, "transitions")]) {
		checkBudget()
		if (!existsSync(source)) continue
		for (const file of readdirSync(source, { withFileTypes: true })) {
			checkBudget()
			if (!file.isFile() || !file.name.endsWith(".jsonl")) continue
			try {
				const path = join(source, file.name)
				if (modifiedSince !== undefined && statSync(path).mtimeMs < modifiedSince) continue
				const lines = readFileSync(path, "utf8").split("\n")
				const parse = journalParser(path, records, onRecordProblem)
				for (const [index, line] of lines.entries()) {
					// The first check follows each file read; later ones skip lines, as a clock read per line adds up.
					if (index % BUDGET_CHECK_LINES === 0) checkBudget()
					parse(line, index === lines.length - 1)
				}
			} catch (error) {
				// An incomplete scan must not advance recovery past a journal we could not read.
				throw new Error(`Could not read work ledger ${file.name}`, { cause: error })
			}
		}
	}
	checkBudget()
	return records
}
/** The journals both readers parse, in the same order. */
async function workJournals(agentDir: string): Promise<string[]> {
	const directory = join(agentDir, "work-attribution")
	const paths: string[] = []
	for (const source of [directory, join(directory, "transitions")]) {
		try {
			for (const file of await readdir(source, { withFileTypes: true }))
				if (file.isFile() && file.name.endsWith(".jsonl")) paths.push(join(source, file.name))
		} catch (error) {
			if (!object(error) || error.code !== "ENOENT") throw error
		}
	}
	return paths
}
/**
 * Like readWorkRecords, but yields to the event loop after each file chunk so a large history never blocks the UI,
 * and stops there once `signal` aborts so a closing session need not wait for the rest.
 */
export async function readWorkRecordsAsync(
	agentDir: string,
	signal: AbortSignal,
	onRecordProblem?: (problem: WorkRecordProblem) => void,
): Promise<WorkRecord[]> {
	const records: WorkRecord[] = []
	for (const path of await workJournals(agentDir)) {
		try {
			const parse = journalParser(path, records, onRecordProblem)
			let partial = ""
			for await (const chunk of createReadStream(path, { encoding: "utf8", highWaterMark: READ_CHUNK_BYTES })) {
				const lines = `${partial}${chunk}`.split("\n")
				partial = lines.pop() ?? ""
				for (const line of lines) parse(line, false)
				await setImmediate()
				signal.throwIfAborted()
			}
			parse(partial, true)
		} catch (error) {
			if (signal.aborted) throw error
			throw new Error(`Could not read work ledger ${basename(path)}`, { cause: error })
		}
	}
	return records
}
/** Names, sizes and modification times of the journals; any append or replacement changes it. */
export async function workJournalFingerprint(agentDir: string): Promise<string> {
	const entries: string[] = []
	for (const path of await workJournals(agentDir)) {
		try {
			const { size, mtimeMs } = await stat(path)
			entries.push(JSON.stringify([path, size, mtimeMs]))
		} catch (error) {
			if (!object(error) || error.code !== "ENOENT") throw error
		}
	}
	return entries.sort().join("\n")
}
function strings(...values: unknown[]): string[] {
	return [
		...new Set(
			values.flatMap((value) => (Array.isArray(value) ? value.filter((item) => typeof item === "string") : [])),
		),
	]
}
const continuationKey = ROW_KEYS.continuations
function latestObservation(previous: unknown, current: unknown): Record<string, unknown> | undefined {
	if (!object(current) || typeof current.checkedAt !== "string" || !Number.isFinite(Date.parse(current.checkedAt)))
		return object(previous) ? previous : undefined
	if (!object(previous) || typeof previous.checkedAt !== "string" || !Number.isFinite(Date.parse(previous.checkedAt)))
		return current
	return Date.parse(current.checkedAt) >= Date.parse(previous.checkedAt) ? current : previous
}
function billingRowKey(row: unknown): string {
	return object(row) && typeof row.id === "string" ? row.id : JSON.stringify(row)
}
/** Empty or failed lookups never remove an association already confirmed by GitHub. */
function pullRequestLinks(...values: unknown[]): Record<string, unknown>[] {
	return mergePullRequestLinks(...values.map((value) => (Array.isArray(value) ? value.filter(object) : [])))
}
/** Whole-file evidence takes precedence over a match of surviving native hunks. */
export function fileMatchStrength(method: unknown): number {
	if (method === "file-chain") return 3
	if (method === "path-blob") return 2
	return method === "file-hunks" ? 1 : 0
}
/** A repeated scan can add evidence or strengthen a match without discarding earlier links. */
function fileMatches(...values: unknown[]) {
	const matches = new Map<
		string,
		{ path: string; method: "file-chain" | "path-blob" | "file-hunks"; transitionIds: string[]; worktree: string }
	>()
	for (const value of values) {
		if (!Array.isArray(value)) continue
		for (const item of value) {
			if (
				!object(item) ||
				typeof item.path !== "string" ||
				typeof item.worktree !== "string" ||
				(item.method !== "file-chain" && item.method !== "path-blob" && item.method !== "file-hunks")
			)
				continue
			const key = JSON.stringify([item.path, item.worktree])
			const existing = matches.get(key)
			if (fileMatchStrength(existing?.method) > fileMatchStrength(item.method)) continue
			matches.set(key, {
				path: item.path,
				worktree: item.worktree,
				method: item.method,
				transitionIds: strings(existing?.method === item.method ? existing.transitionIds : [], item.transitionIds),
			})
		}
	}
	return [...matches.values()]
}
/** The summary collection each record type merges into. */
const RECORD_COLLECTIONS: Record<Exclude<WorkRecord["type"], "work">, Collection> = {
	work_link: "workLinks",
	request: "requests",
	request_dispatch: "requests",
	request_response: "requests",
	request_cost: "requests",
	plan: "plans",
	commit: "commits",
	file_transition: "fileTransitions",
	file_observation: "fileObservations",
}
function recordKey(type: Exclude<WorkRecord["type"], "work">, row: SummaryEntry): string {
	return ROW_KEYS[RECORD_COLLECTIONS[type]](row)
}
/** Rows by key. A store that reads saved rows on demand can stand in for a Map. */
interface RowMap {
	get(key: string): SummaryEntry | undefined
	has(key: string): boolean
	set(key: string, row: SummaryEntry): unknown
}
/** One work's rows while records merge: sessions in first-seen order, each collection by row key. */
export type SummaryRows = { sessions: { add(sessionId: string): unknown } } & Record<Collection, RowMap>
/** Merge rules for one batch of records, applied row by row. */
export async function mergeWorkRecords(summary: SummaryRows, records: WorkRecord[]): Promise<void> {
	const { sessions, continuations } = summary
	const entriesByType = {
		work_link: summary.workLinks,
		request: summary.requests,
		request_dispatch: summary.requests,
		request_response: summary.requests,
		request_cost: summary.requests,
		plan: summary.plans,
		commit: summary.commits,
		file_transition: summary.fileTransitions,
		file_observation: summary.fileObservations,
	}
	for (let index = 0; index < records.length; index++) {
		if (index % MERGE_BATCH_SIZE === 0) await setImmediate()
		const { type, version: _version, workId: _workId, ...item } = records[index]
		sessions.add(item.sessionId)
		if (type === "work") {
			if (
				object(item.continuation) &&
				typeof item.continuation.source === "string" &&
				object(item.continuation.evidence)
			) {
				const row = {
					sessionId: item.sessionId,
					cwd: item.cwd,
					recordedAt: item.recordedAt,
					source: item.continuation.source,
					evidence: item.continuation.evidence,
				}
				const key = continuationKey(row)
				if (!continuations.has(key)) continuations.set(key, row)
			}
			continue
		}
		const entries = entriesByType[type]
		const key = recordKey(type, item)
		const existing = entries.get(key)
		if (type === "request_cost" && existing?.billingRows !== undefined && Array.isArray(item.billingRows)) {
			// Each billing ID is listed once, as its latest observation describes it.
			const newer = latestObservation(existing.billingLookup, item.billingLookup) === item.billingLookup
			const rows = new Map<string, unknown>()
			for (const row of Array.isArray(existing.billingRows) ? existing.billingRows : [])
				rows.set(billingRowKey(row), row)
			for (const row of item.billingRows) if (newer || !rows.has(billingRowKey(row))) rows.set(billingRowKey(row), row)
			item.billingRows = [...rows.values()]
		}
		if (type === "request_cost" && (item.billingLookup !== undefined || existing?.billingLookup !== undefined))
			item.billingLookup = latestObservation(existing?.billingLookup, item.billingLookup)
		if (type === "commit" && (item.fileMatches !== undefined || existing?.fileMatches !== undefined))
			item.fileMatches = fileMatches(existing?.fileMatches, item.fileMatches)
		if (type === "commit") {
			if (item.pullRequests !== undefined || existing?.pullRequests !== undefined)
				item.pullRequests = pullRequestLinks(existing?.pullRequests, item.pullRequests)
			if (item.prLookup !== undefined || existing?.prLookup !== undefined)
				item.prLookup = latestObservation(existing?.prLookup, item.prLookup)
		}
		if (existing) {
			const paths = type === "commit" ? strings(existing.paths, item.paths) : []
			const transitionIds = type === "commit" ? strings(existing.transitionIds, item.transitionIds) : []
			Object.assign(existing, item)
			if (paths.length) existing.paths = paths
			if (transitionIds.length) existing.transitionIds = transitionIds
		} else entries.set(key, item)
	}
}
async function update(
	agentDir: string,
	workId: string,
	records: WorkRecord[],
	complete: boolean,
	assertLease: () => void,
): Promise<void> {
	assertLease()
	const head = await updateWorkRows(
		join(agentDir, "work", workId),
		workId,
		{
			summary: (value) => versionOneSummary(value, workId),
			check: (collection, row) => ROW_CHECKS[collection](row),
			assertLease,
		},
		async (rows, rebuild) => {
			const history = rebuild && !complete ? readWorkRecords(agentDir).filter((row) => row.workId === workId) : []
			await mergeWorkRecords(rows, history.concat(records))
		},
	)
	const bytes = head && Buffer.byteLength(JSON.stringify(head))
	if (bytes && bytes > MANIFEST_WARNING_BYTES)
		debugWorkAttribution(`Work summary manifest for ${workId} is ${bytes} bytes`)
}
function refresh(agentDir: string, workId: string, records: WorkRecord[], complete = false): Promise<boolean> {
	const directory = join(agentDir, "work", workId)
	// A work ID generated here has no earlier records, so its first write skips the history scan.
	if (newWork.delete(workId)) complete = true
	const queued = pending.get(directory)
	if (queued) {
		queued.records = queued.records.concat(records)
		queued.complete ||= complete
		return queued.promise
	}
	const queue: PendingUpdate = { records: [...records], complete, promise: Promise.resolve(true) }
	queue.promise = (async () => {
		try {
			await mkdir(directory, { recursive: true, mode: 0o700 })
			while (queue.records.length) {
				let compromised: Error | undefined
				const release = await lock(directory, {
					stale: LOCK_STALE_MS,
					retries: LOCK_RETRIES,
					onCompromised: (error) => {
						compromised = error
					},
				})
				const assertLease = () => {
					if (compromised) throw compromised
				}
				try {
					const batch = queue.records.splice(0)
					const completeBatch = queue.complete
					queue.complete = false
					await update(agentDir, workId, batch, completeBatch, assertLease)
				} finally {
					// A compromised lease has already been removed from proper-lockfile's ownership map.
					if (!compromised) await release()
				}
			}
		} finally {
			pending.delete(directory)
		}
	})().then(
		() => true,
		(error: unknown) => {
			logDebug(error)
			return false
		},
	)
	pending.set(directory, queue)
	return queue.promise
}
/** Call before the first record of a freshly generated work ID. */
export function markNewWork(workId: string): void {
	newWork.add(workId)
}
/** Called only after the source record has been durably appended. */
export function updateWorkSummary(value: unknown): void {
	if (record(value)) refresh(getAgentDir(), value.workId, [value])
}
function summaryFingerprint(path: string): string {
	const { size, mtimeMs } = statSync(path)
	return `${size}:${mtimeMs}`
}
async function readRecovery(agentDir: string, stamp: string) {
	let saved: unknown
	try {
		saved = JSON.parse(readFileSync(stamp, "utf8"))
	} catch {
		return undefined
	}
	if (
		!object(saved) ||
		saved.version !== RECOVERY_VERSION ||
		typeof saved.startedAt !== "number" ||
		!Number.isFinite(saved.startedAt) ||
		saved.startedAt > Date.now() ||
		!object(saved.summaries)
	)
		return undefined
	const summaries: Record<string, string> = {}
	for (const [workId, fingerprint] of Object.entries(saved.summaries)) {
		if (!isWorkId(workId) || typeof fingerprint !== "string") return undefined
		const directory = join(agentDir, "work", workId)
		const path = join(directory, "work.json")
		if (!existsSync(path)) return undefined
		const current = summaryFingerprint(path)
		// Missing or damaged output requires all source ledgers, even when none changed.
		if (current !== fingerprint && !(await validWorkFiles(directory, workId, (value) => validSummary(value, workId))))
			return undefined
		summaries[workId] = current
	}
	return { startedAt: saved.startedAt, summaries }
}
/**
 * One launch-time pass heals records left behind by an interrupted summary update.
 * Records written before the last fully successful pass started were already published by it,
 * so only ledgers modified since then are replayed. Delete the stamp to force a full replay.
 */
export function recoverWorkSummaries(): void {
	const agentDir = getAgentDir()
	if (recoveredDirectories.has(agentDir)) return
	recoveredDirectories.add(agentDir)
	trackAttributionTask(
		recover(agentDir).catch((error) => {
			recoveredDirectories.delete(agentDir)
			logDebug(error)
		}),
	)
}
async function recover(agentDir: string): Promise<void> {
	const stamp = join(agentDir, "work-attribution", RECOVERY_STAMP)
	const startedAt = Date.now()
	const previous = await readRecovery(agentDir, stamp)
	const groups = new Map<string, WorkRecord[]>()
	for (const row of readWorkRecords(agentDir, previous && previous.startedAt - RECOVERY_MTIME_SLACK_MS)) {
		const rows = groups.get(row.workId) ?? []
		rows.push(row)
		groups.set(row.workId, rows)
	}
	const updates = [...groups].map(([workId, rows]) => refresh(agentDir, workId, rows, !previous))
	if (!(await Promise.all(updates)).every(Boolean) || !existsSync(dirname(stamp))) return
	const summaries = previous?.summaries ?? {}
	for (const workId of groups.keys())
		summaries[workId] = summaryFingerprint(join(agentDir, "work", workId, "work.json"))
	writeFileSync(stamp, JSON.stringify({ version: RECOVERY_VERSION, startedAt, summaries }), { mode: 0o600 })
}
/** Shared summary recovery that shutdown and tests must drain. */
function trackAttributionTask(task: Promise<unknown>): void {
	const tracked = task.finally(() => backgroundTasks.delete(tracked))
	backgroundTasks.add(tracked)
}
/** Shutdown awaits queued contention retries and background tasks; each has a finite deadline. */
export async function flushWorkSummaries(): Promise<void> {
	while (pending.size || backgroundTasks.size)
		await Promise.all([...[...pending.values()].map((update) => update.promise), ...backgroundTasks])
}
