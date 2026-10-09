import { closeSync, openSync, readFileSync, readSync } from "node:fs"
import { type FileHandle, mkdir, open, readdir, readFile, rm, stat } from "node:fs/promises"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import { writeFileDurably } from "../../config/json.js"
import { mergePullRequestLinks } from "../pull-request-status/links.js"

/*
 * Work summary storage. Version 2 `work/<id>/work.json` is a small manifest. Each collection's rows live in
 * `rows/<collection>.<generation>.jsonl`, one version 1 row per line; a later line with the same key replaces an
 * earlier one, and the first line of a key fixes its position. A writer appends changed rows, syncs them, then
 * renames the manifest, which commits them. This module uses plain `fs` so tests and tools can read summaries.
 */

/** The manifest, and the commit point for every row log. */
export const WORK_FILE = "work.json"
const ROWS = "rows"
/** Version 1 summaries larger than this are not read just to list a work. */
export const MAX_SUMMARY_BYTES = 8 * 1024 * 1024
/** Appends and copies are written in chunks of at most this size. */
const CHUNK_BYTES = 4 * 1024 * 1024
/** A log is compacted once superseded lines exceed half its live rows and this many bytes. */
const COMPACT_GARBAGE_BYTES = 1024 * 1024
/** Row positions kept in memory per process across works; about 100 bytes each. */
const MAX_INDEXED_ROWS = 200_000
const YIELD_ROWS = 1000

/** One row of a summary collection, as version 1 `work.json` stores it. */
export interface Row {
	sessionId: string
	[key: string]: unknown
}

/** Summary collections, named as in version 1 `work.json`. Each one is a row log in version 2. */
export const COLLECTIONS = [
	"workLinks",
	"requests",
	"plans",
	"commits",
	"fileTransitions",
	"fileObservations",
	"continuations",
] as const
export type Collection = (typeof COLLECTIONS)[number]
const COLLECTION_NAMES = new Set<string>(COLLECTIONS)

function isCollection(name: string): name is Collection {
	return COLLECTION_NAMES.has(name)
}

/** Row identity per collection. */
export const ROW_KEYS: Record<Collection, (row: Row) => string> = {
	workLinks: (row) =>
		JSON.stringify([
			row.linkId,
			row.revision,
			row.sourceWorkId,
			row.targetWorkId,
			row.requestIds,
			row.scope,
			row.status,
			row.evidence,
		]),
	requests: (row) => JSON.stringify(row.requestId),
	plans: (row) => JSON.stringify([row.sessionId, row.path, row.snapshotPath]),
	commits: (row) => JSON.stringify([row.sessionId, row.sha, row.repository, row.worktree]),
	fileTransitions: (row) => JSON.stringify(row.transitionId),
	fileObservations: (row) => JSON.stringify(row.observationId),
	continuations: (row) => JSON.stringify([row.sessionId, row.source, row.evidence]),
}

/** `rows/<collection>.<generation>.jsonl`. Bytes past `bytes` belong to an interrupted append and are ignored. */
export interface RowLog {
	/** Positive for a log file. `readWorkHead` reports rows still inside a version 1 `work.json` as generation 0. */
	generation: number
	/** Committed length. */
	bytes: number
	/** Distinct keys: the length of the version 1 array. */
	rows: number
}

/** What `/work` lists. Each value is the newest by its timestamp; later writes win ties. */
export interface WorkLatest {
	/** Newest request start, native edit or retained plan. */
	activityAt?: string
	request?: { startedAt?: string; repository?: string; cwd?: string }
	edit?: { recordedAt?: string; repository: string }
	branch?: { recordedAt?: string; branch: string }
	commit?: { recordedAt?: string; repository: string }
	plan?: { recordedAt?: string; snapshotPath: string }
}

/** Version 2 `work.json`. */
export interface WorkHead {
	version: 2
	workId: string
	/** Time of the last committed change. */
	updatedAt: string
	/** Sessions in first-seen order. */
	sessions: string[]
	/** A missing log is an empty collection. */
	logs: Partial<Record<Collection, RowLog>>
	latest: WorkLatest
	/** PR links of every commit row, merged. */
	pullRequests: Record<string, unknown>[]
}

/** The version 1 `work.json` shape, which folding the row logs returns. */
export type WorkSummaryView = { version: 1; workId: string; sessions: string[] } & Record<Collection, Row[]>

/** Validates one committed row; a failure means the logs are damaged and the work is rebuilt from its journals. */
export type RowCheck = (collection: Collection, row: Row) => boolean

/** A log that does not match its manifest. */
export class RowLogDamage extends Error {}

function object(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function code(error: unknown): unknown {
	return object(error) ? error.code : undefined
}

function count(value: unknown, minimum = 0): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
}

function isRow(value: unknown): value is Row {
	return object(value) && typeof value.sessionId === "string"
}

/** Version 1 readers were lenient: any object in a collection is a row. The writer validates them. */
function savedRow(value: unknown): value is Row {
	return object(value)
}

function text(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined
}

export function logPath(folder: string, collection: Collection, generation: number): string {
	return join(folder, ROWS, `${collection}.${generation}.jsonl`)
}

/** A version 2 manifest for `workId`, checked without opening its logs. */
export function isWorkHead(value: unknown, workId: string): value is WorkHead {
	return (
		object(value) &&
		value.version === 2 &&
		value.workId === workId &&
		typeof value.updatedAt === "string" &&
		Array.isArray(value.sessions) &&
		value.sessions.every((session) => typeof session === "string") &&
		object(value.logs) &&
		Object.entries(value.logs).every(
			([name, log]) =>
				isCollection(name) &&
				object(log) &&
				count(log.generation, 1) &&
				count(log.rows, 1) &&
				count(log.bytes, log.rows + 1),
		) &&
		object(value.latest) &&
		Array.isArray(value.pullRequests)
	)
}

function summaryView(workId: string, sessions: string[], rows: (collection: Collection) => Row[]): WorkSummaryView {
	return {
		version: 1,
		workId,
		sessions,
		workLinks: rows("workLinks"),
		requests: rows("requests"),
		plans: rows("plans"),
		commits: rows("commits"),
		fileTransitions: rows("fileTransitions"),
		fileObservations: rows("fileObservations"),
		continuations: rows("continuations"),
	}
}

/** A version 1 summary read as leniently as `/work` always read it; older ones lack later collections. */
function versionOneView(value: unknown, workId: string): WorkSummaryView | undefined {
	if (!object(value) || value.version !== 1 || value.workId !== workId) return undefined
	const sessions = Array.isArray(value.sessions) ? value.sessions.filter((session) => typeof session === "string") : []
	return summaryView(workId, sessions, (collection) => {
		const rows = value[collection]
		return Array.isArray(rows) ? rows.filter(savedRow) : []
	})
}

function parseRow(line: string, collection: Collection): Row {
	let row: unknown
	try {
		row = JSON.parse(line)
	} catch {
		throw new RowLogDamage(`A ${collection} row is not JSON`)
	}
	if (!isRow(row)) throw new RowLogDamage(`A ${collection} row has no session`)
	return row
}

/** Rows of one committed range, folded by key. */
function foldLog(collection: Collection, buffer: Buffer): Row[] {
	const rows = new Map<string, Row>()
	let start = 0
	for (let end = buffer.indexOf(10); end !== -1; end = buffer.indexOf(10, start)) {
		const row = parseRow(buffer.toString("utf8", start, end), collection)
		rows.set(ROW_KEYS[collection](row), row)
		start = end + 1
	}
	if (start !== buffer.length) throw new RowLogDamage(`The ${collection} log does not end at a line break`)
	return [...rows.values()]
}

/** The committed bytes of one log. A compaction may delete it after its manifest was read (ENOENT). */
function readLogSync(folder: string, collection: Collection, generation: number, bytes: number): Buffer {
	const fd = openSync(logPath(folder, collection, generation), "r")
	try {
		const buffer = Buffer.allocUnsafe(bytes)
		for (let read = 0; read < bytes; ) {
			const length = readSync(fd, buffer, read, bytes - read, read)
			if (!length) throw new RowLogDamage(`The ${collection} log is shorter than its committed length`)
			read += length
		}
		return buffer
	} finally {
		closeSync(fd)
	}
}

/** Reads the manifest and folds what `read` needs; retries once when a compaction replaced a log. */
function readCommitted<T>(
	agentDir: string,
	workId: string,
	fromVersionOne: (view: WorkSummaryView) => T,
	read: (folder: string, head: WorkHead) => T,
): T | undefined {
	const folder = join(agentDir, "work", workId)
	for (let attempt = 0; ; attempt++) {
		let value: unknown
		try {
			value = JSON.parse(readFileSync(join(folder, WORK_FILE), "utf8"))
		} catch {
			return undefined
		}

		const view = versionOneView(value, workId)
		if (view) return fromVersionOne(view)
		if (!isWorkHead(value, workId)) return undefined
		try {
			return read(folder, value)
		} catch (error) {
			if (attempt === 0 && code(error) === "ENOENT") continue
			if (error instanceof RowLogDamage || code(error) === "ENOENT") return undefined
			throw error
		}
	}
}

function foldCommitted(folder: string, head: WorkHead, collection: Collection): Row[] {
	const log = head.logs[collection]
	return log ? foldLog(collection, readLogSync(folder, collection, log.generation, log.bytes)) : []
}

/** The whole summary in the version 1 shape, from either version; undefined when missing or damaged. */
export function readWorkSummary(agentDir: string, workId: string): WorkSummaryView | undefined {
	return readCommitted(
		agentDir,
		workId,
		(view) => view,
		(folder, head) => summaryView(workId, head.sessions, (collection) => foldCommitted(folder, head, collection)),
	)
}

/** One collection's rows from either version, without reading the other logs. */
export function readWorkRows(agentDir: string, workId: string, collection: Collection): Row[] | undefined {
	return readCommitted(
		agentDir,
		workId,
		(view) => view[collection],
		(folder, head) => foldCommitted(folder, head, collection),
	)
}

/**
 * The manifest, or the same values computed from a version 1 summary small enough to read. Opens no row log.
 * "too-large" is a version 1 summary over `maxBytes`; its next update migrates it.
 */

export async function readWorkHead(
	agentDir: string,
	workId: string,
	maxBytes = MAX_SUMMARY_BYTES,
): Promise<WorkHead | "too-large" | undefined> {
	const path = join(agentDir, "work", workId, WORK_FILE)
	let value: unknown
	let modifiedAt: number
	try {
		const info = await stat(path)
		if (!info.isFile()) return undefined
		if (info.size > maxBytes) return "too-large"
		modifiedAt = info.mtimeMs
		value = JSON.parse(await readFile(path, "utf8"))
	} catch {
		return undefined
	}
	return isWorkHead(value, workId) ? value : summaryHead(value, workId, new Date(modifiedAt).toISOString())
}

/** The head of a version 1 summary, computed from its rows; they stay inside `work.json` (generation 0). */
export function summaryHead(value: unknown, workId: string, updatedAt: string): WorkHead | undefined {
	const view = versionOneView(value, workId)
	if (!view) return undefined
	const logs: Partial<Record<Collection, RowLog>> = {}
	for (const collection of COLLECTIONS)
		if (view[collection].length) logs[collection] = { generation: 0, bytes: 0, rows: view[collection].length }
	return { version: 2, workId, updatedAt, sessions: view.sessions, logs, ...summaryLatest((name) => view[name]) }
}

/** Milliseconds of an ISO 8601 timestamp, as `/work` orders rows; impossible dates are not times. */
function timestamp(value: unknown): number | undefined {
	if (
		typeof value !== "string" ||
		!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
	)
		return undefined
	const parsed = Date.parse(value)
	if (!Number.isFinite(parsed)) return undefined
	const day = value.slice(0, 10)
	return new Date(`${day}T00:00:00Z`).toISOString().startsWith(day) ? parsed : undefined
}

/** Whether a row stamped `at` replaces a latest value stamped `current`. Rows without a valid time sort first. */
function replaces(at: unknown, current: { at?: string } | undefined): boolean {
	return !current || (timestamp(at) ?? 0) >= (timestamp(current.at) ?? 0)
}

/** Folds one changed or saved row into what `/work` lists. */
export function observeLatest(latest: WorkLatest, collection: Collection, row: Row): void {
	const at = collection === "requests" ? row.startedAt : row.recordedAt
	const time = timestamp(at)
	if (
		time !== undefined &&
		(collection === "requests" || collection === "fileTransitions" || collection === "plans") &&
		time > (timestamp(latest.activityAt) ?? Number.NEGATIVE_INFINITY)
	)
		latest.activityAt = text(at)
	const recordedAt = text(row.recordedAt)
	if (collection === "requests") {
		if (replaces(at, latest.request && { at: latest.request.startedAt })) {
			const scope = object(row.scope) ? row.scope : undefined
			latest.request = { startedAt: text(at), repository: text(scope?.repository), cwd: text(row.cwd) }
		}
	} else if (collection === "fileTransitions") {
		if (typeof row.repository === "string" && replaces(at, latest.edit && { at: latest.edit.recordedAt }))
			latest.edit = { recordedAt, repository: row.repository }
		if (typeof row.branch === "string" && replaces(at, latest.branch && { at: latest.branch.recordedAt }))
			latest.branch = { recordedAt, branch: row.branch }
	} else if (collection === "commits") {
		if (typeof row.repository === "string" && replaces(at, latest.commit && { at: latest.commit.recordedAt }))
			latest.commit = { recordedAt, repository: row.repository }
	} else if (collection === "plans") {
		if (typeof row.snapshotPath === "string" && replaces(at, latest.plan && { at: latest.plan.recordedAt }))
			latest.plan = { recordedAt, snapshotPath: row.snapshotPath }
	}
}

/** PR links of every commit row, merged; empty or failed lookups never remove a link. */
export function commitPullRequests(commits: Iterable<Row>): Record<string, unknown>[] {
	return mergePullRequestLinks(
		...[...commits].map((row) => (Array.isArray(row.pullRequests) ? row.pullRequests.filter(object) : [])),
	)
}

/** `latest` and `pullRequests` recomputed from every row, in log order. */
export function summaryLatest(
	rows: (collection: Collection) => Iterable<Row>,
): Pick<WorkHead, "latest" | "pullRequests"> {
	const latest: WorkLatest = {}
	for (const collection of COLLECTIONS) for (const row of rows(collection)) observeLatest(latest, collection, row)
	return { latest, pullRequests: commitPullRequests(rows("commits")) }
}

interface Line {
	offset: number
	length: number
}

interface LogIndex {
	generation: number
	/** File identity: a replaced file is scanned again. */
	ino: number
	/** Modification time when this process last read or wrote the log; an unexplained change means a full scan. */
	mtimeMs: number
	/** Committed bytes already indexed. */
	bytes: number
	/** Bytes of each key's newest line, line breaks included. */
	live: number
	/** Newest line per key, in first-seen order. */
	lines: Map<string, Line>
}

/** Row positions of logs this process has read, most recently used last. */
const indexes = new Map<string, { index: LogIndex; rows: number }>()
let indexedRows = 0

function cached(folder: string, collection: Collection): LogIndex | undefined {
	return indexes.get(`${folder}\0${collection}`)?.index
}

function remember(folder: string, collection: Collection, index: LogIndex): void {
	const key = `${folder}\0${collection}`
	const previous = indexes.get(key)
	if (previous) {
		indexes.delete(key)
		indexedRows -= previous.rows
	}
	indexes.set(key, { index, rows: index.lines.size })
	indexedRows += index.lines.size
	for (const [oldest, entry] of indexes) {
		if (indexedRows <= MAX_INDEXED_ROWS || oldest === key) break
		indexes.delete(oldest)
		indexedRows -= entry.rows
	}
}

/** Drops this work's positions; its next update scans the logs again. */
function forget(folder: string): void {
	for (const collection of COLLECTIONS) {
		const key = `${folder}\0${collection}`
		const entry = indexes.get(key)
		if (!entry) continue
		indexes.delete(key)
		indexedRows -= entry.rows
	}
}

async function readExactly(handle: FileHandle, buffer: Buffer, position: number): Promise<void> {
	for (let read = 0; read < buffer.length; ) {
		const { bytesRead } = await handle.read(buffer, read, buffer.length - read, position + read)
		if (!bytesRead) throw new RowLogDamage("A row log is shorter than its committed length")
		read += bytesRead
	}
}

/** Indexes committed lines from `index.bytes` to `end`; each must be a valid row, and the range must end a line. */
async function scanLog(
	handle: FileHandle,
	collection: Collection,
	index: LogIndex,
	end: number,
	check: RowCheck,
): Promise<void> {
	let carry = Buffer.alloc(0)
	let rows = 0
	for (let position = index.bytes; position < end; ) {
		const chunk = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, end - position))
		await readExactly(handle, chunk, position)
		const buffer = carry.length ? Buffer.concat([carry, chunk]) : chunk
		const base = position - carry.length
		let start = 0
		for (let stop = buffer.indexOf(10); stop !== -1; stop = buffer.indexOf(10, start)) {
			const row = parseRow(buffer.toString("utf8", start, stop), collection)
			if (!check(collection, row)) throw new RowLogDamage(`A ${collection} row is invalid`)
			const key = ROW_KEYS[collection](row)
			const previous = index.lines.get(key)
			if (previous) index.live -= previous.length + 1
			index.lines.set(key, { offset: base + start, length: stop - start })
			index.live += stop - start + 1
			start = stop + 1
			if (++rows % YIELD_ROWS === 0) await setImmediate()
		}
		carry = buffer.subarray(start)
		position += chunk.length
	}
	if (carry.length) throw new RowLogDamage(`The ${collection} log does not end at a line break`)
	index.bytes = end
}

/** Next unused generation of a collection, past any file a crash or another version left behind. */
async function nextGeneration(folder: string, collection: Collection, current = 0): Promise<number> {
	let highest = current
	for (const name of await readdir(join(folder, ROWS)).catch(() => [])) {
		const match = /^(\w+)\.(\d+)\.jsonl$/.exec(name)
		if (match?.[1] === collection) highest = Math.max(highest, Number(match[2]))
	}
	return highest + 1
}

/** Deletes row files the manifest does not name: leftovers of crashes, compactions and other versions. */
async function removeStrays(folder: string, head: WorkHead): Promise<void> {
	for (const name of await readdir(join(folder, ROWS)).catch(() => [])) {
		const match = /^(\w+)\.(\d+)\.jsonl$/.exec(name)
		const stray =
			match && isCollection(match[1]) ? head.logs[match[1]]?.generation !== Number(match[2]) : /^\..*\.tmp$/.test(name)
		// A reader may still hold an old generation open. Windows then refuses, and a later update retries.
		if (stray) await rm(join(folder, ROWS, name), { force: true }).catch(() => {})
	}
}

/** Writes a new log from `[key, line]` pairs; returns its index. */
async function writeLog(
	folder: string,
	collection: Collection,
	generation: number,
	lines: Iterable<[string, string]>,
	assertLease: () => void,
): Promise<LogIndex> {
	const index: LogIndex = { generation, ino: 0, mtimeMs: 0, bytes: 0, live: 0, lines: new Map() }
	const handle = await open(logPath(folder, collection, generation), "wx", 0o600)
	try {
		let chunk: string[] = []
		let chunkBytes = 0
		const flush = async () => {
			assertLease()
			await handle.write(chunk.join(""))
			chunk = []
			chunkBytes = 0
		}

		let rows = 0
		for (const [key, line] of lines) {
			const length = Buffer.byteLength(line)
			index.lines.set(key, { offset: index.bytes, length })
			index.bytes += length + 1
			chunk.push(line, "\n")
			chunkBytes += length + 1
			if (chunkBytes >= CHUNK_BYTES) await flush()
			if (++rows % YIELD_ROWS === 0) await setImmediate()
		}
		if (chunk.length) await flush()
		await handle.sync()
		const { size, ino, mtimeMs } = await handle.stat()
		if (size !== index.bytes) throw new RowLogDamage(`The new ${collection} log changed while it was written`)
		index.ino = ino
		index.mtimeMs = mtimeMs
		index.live = index.bytes
		return index
	} finally {
		await handle.close()
	}
}

/** Appends lines at the committed end and syncs them; another writer's bytes in between fail the update. */
async function appendLog(
	path: string,
	from: number,
	lines: string[],
	assertLease: () => void,
): Promise<{ ino: number; mtimeMs: number }> {
	const data = Buffer.from(lines.join(""))
	const handle = await open(path, from ? "a" : "ax", 0o600)
	try {
		for (let start = 0; start < data.length; start += CHUNK_BYTES) {
			assertLease()
			await handle.write(data, start, Math.min(CHUNK_BYTES, data.length - start))
		}
		await handle.sync()
		const { size, ino, mtimeMs } = await handle.stat()
		if (size !== from + data.length) throw new RowLogDamage("A row log changed during an append")
		return { ino, mtimeMs }
	} finally {
		await handle.close()
	}
}

/** One collection's rows during a locked update. Saved rows load on first use; changed and new rows are written. */
export class RowStore {
	/** Rows read or set in this update, in first-touch order, with the saved line each was read from. */
	readonly touched = new Map<string, { row: Row; line?: string }>()
	constructor(
		private readonly collection: Collection,
		private readonly index?: LogIndex,
		private readonly readLine?: (line: Line) => string,
	) {}
	get(key: string): Row | undefined {
		const touched = this.touched.get(key)
		if (touched) return touched.row
		const at = this.index?.lines.get(key)
		if (!at || !this.readLine) return undefined
		const line = this.readLine(at)
		const row = parseRow(line, this.collection)
		if (ROW_KEYS[this.collection](row) !== key) throw new RowLogDamage(`A ${this.collection} row moved`)
		this.touched.set(key, { row, line })
		return row
	}
	has(key: string): boolean {
		return this.touched.has(key) || this.index?.lines.has(key) === true
	}
	set(key: string, row: Row): void {
		const touched = this.touched.get(key)
		if (touched) touched.row = row
		else this.touched.set(key, { row })
	}
}

/** Sessions and rows of one work while records merge into it. */
export type WorkRows = { sessions: Set<string> } & Record<Collection, RowStore>

function workRows(sessions: Iterable<string>, store: (collection: Collection) => RowStore): WorkRows {
	return {
		sessions: new Set(sessions),
		workLinks: store("workLinks"),
		requests: store("requests"),
		plans: store("plans"),
		commits: store("commits"),
		fileTransitions: store("fileTransitions"),
		fileObservations: store("fileObservations"),
		continuations: store("continuations"),
	}
}

interface OpenWork {
	/** The committed manifest when rows are appended; absent when a version 1 summary migrates or the work is rebuilt. */
	head?: WorkHead
	/** Nothing usable was saved: the whole history must be merged again. */
	rebuild: boolean
	/** A damaged manifest being rebuilt; new generations go past the ones it named. */
	damaged?: WorkHead
	indexes: Partial<Record<Collection, LogIndex>>
	rows: WorkRows
	close(): void
}

/** Opens and checks the committed logs, dropping an interrupted append; damage throws. */
async function openLogs(folder: string, head: WorkHead, check: RowCheck): Promise<OpenWork> {
	const indexes: Partial<Record<Collection, LogIndex>> = {}
	for (const collection of COLLECTIONS) {
		const log = head.logs[collection]
		if (!log) continue
		const handle = await open(logPath(folder, collection, log.generation), "r+")
		try {
			const { size, ino, mtimeMs } = await handle.stat()
			if (size < log.bytes) throw new RowLogDamage(`The ${collection} log is shorter than its committed length`)
			let index = cached(folder, collection)
			// Another process may have committed more lines since this one indexed the log; only that tail is read.
			// The same length with a different modification time means the committed bytes themselves changed.
			const grew = index !== undefined && index.bytes < log.bytes
			if (
				!index ||
				index.generation !== log.generation ||
				index.ino !== ino ||
				index.bytes > log.bytes ||
				(!grew && index.mtimeMs !== mtimeMs)
			)
				index = { generation: log.generation, ino, mtimeMs, bytes: 0, live: 0, lines: new Map() }
			// Bytes past the committed length are an interrupted append; this writer holds the lock.
			if (size > log.bytes) await handle.truncate(log.bytes)
			if (index.bytes < log.bytes) await scanLog(handle, collection, index, log.bytes, check)
			index.mtimeMs = (await handle.stat()).mtimeMs
			if (index.lines.size !== log.rows) throw new RowLogDamage(`The ${collection} log has the wrong row count`)
			indexes[collection] = index
		} finally {
			await handle.close()
		}
	}

	const files = new Map<Collection, number>()
	const reader = (collection: Collection, index: LogIndex) => (line: Line) => {
		let fd = files.get(collection)
		if (fd === undefined) {
			fd = openSync(logPath(folder, collection, index.generation), "r")
			files.set(collection, fd)
		}

		const buffer = Buffer.allocUnsafe(line.length)
		if (readSync(fd, buffer, 0, line.length, line.offset) !== line.length)
			throw new RowLogDamage(`A ${collection} row is missing`)
		return buffer.toString("utf8")
	}
	return {
		head,
		rebuild: false,
		indexes,
		rows: workRows(head.sessions, (collection) => {
			const index = indexes[collection]
			return new RowStore(collection, index, index && reader(collection, index))
		}),
		close() {
			for (const fd of files.values()) closeSync(fd)
			files.clear()
		},
	}
}

async function openWork(
	folder: string,
	workId: string,
	summary: (value: unknown) => WorkSummaryView | undefined,
	check: RowCheck,
): Promise<OpenWork> {
	let value: unknown
	try {
		value = JSON.parse(await readFile(join(folder, WORK_FILE), "utf8"))
	} catch (error) {
		if (!(error instanceof SyntaxError) && code(error) !== "ENOENT") throw error
	}

	let damaged: WorkHead | undefined
	if (isWorkHead(value, workId)) {
		try {
			return await openLogs(folder, value, check)
		} catch (error) {
			if (!(error instanceof RowLogDamage) && code(error) !== "ENOENT") throw error
			forget(folder)
			damaged = value
		}
	}

	// A version 1 summary migrates with every row; anything else is rebuilt from the journals.
	const saved = damaged ? undefined : summary(value)
	return {
		rebuild: !saved,
		damaged,
		indexes: {},
		rows: workRows(saved?.sessions ?? [], (collection) => {
			const store = new RowStore(collection)
			for (const row of saved?.[collection] ?? []) store.set(ROW_KEYS[collection](row), row)
			return store
		}),
		close() {},
	}
}

function* serialized(touched: RowStore["touched"]): Generator<[string, string]> {
	for (const [key, { row }] of touched) yield [key, JSON.stringify(row)]
}

/** Each touched row's new line, when it differs from the saved one. */
async function changedLines(store: RowStore): Promise<[string, string, Row][]> {
	const changed: [string, string, Row][] = []
	let rows = 0
	for (const [key, { row, line }] of store.touched) {
		const next = JSON.stringify(row)
		if (next !== line) changed.push([key, next, row])
		if (++rows % YIELD_ROWS === 0) await setImmediate()
	}
	return changed
}

/** Commits changed rows: appended to the current logs, or as new generations on migration and rebuild. */
async function commitWork(
	folder: string,
	workId: string,
	work: OpenWork,
	assertLease: () => void,
): Promise<WorkHead | undefined> {
	const { head: previous } = work
	const changes = new Map<Collection, [string, string, Row][]>()
	if (previous)
		for (const collection of COLLECTIONS) {
			const changed = await changedLines(work.rows[collection])
			if (changed.length) changes.set(collection, changed)
		}
	const sessions = [...work.rows.sessions]
	if (previous && !changes.size && sessions.length === previous.sessions.length) return undefined
	assertLease()
	await mkdir(join(folder, ROWS), { recursive: true, mode: 0o700 })
	const logs: Partial<Record<Collection, RowLog>> = {}
	const written: Partial<Record<Collection, LogIndex>> = {}
	let values: Pick<WorkHead, "latest" | "pullRequests">
	let generations = !previous
	if (previous) {
		Object.assign(logs, previous.logs)
		const latest = structuredClone(previous.latest)
		for (const [collection, rows] of changes) {
			const log = previous.logs[collection]
			const generation = log?.generation ?? (await nextGeneration(folder, collection))
			generations ||= !log
			const index = work.indexes[collection] ?? { generation, ino: 0, mtimeMs: 0, bytes: 0, live: 0, lines: new Map() }
			const from = log?.bytes ?? 0
			const lines = rows.map(([, line]) => `${line}\n`)
			Object.assign(index, await appendLog(logPath(folder, collection, generation), from, lines, assertLease))
			let offset = from
			for (const [key, line, row] of rows) {
				const saved = index.lines.get(key)
				if (saved) index.live -= saved.length + 1
				const length = Buffer.byteLength(line)
				index.lines.set(key, { offset, length })
				index.live += length + 1
				offset += length + 1
				observeLatest(latest, collection, row)
			}
			index.bytes = offset
			written[collection] = index
			logs[collection] = { generation, bytes: offset, rows: index.lines.size }
		}
		values = {
			latest,
			pullRequests: written.commits
				? commitPullRequests(liveRows(folder, "commits", written.commits))
				: previous.pullRequests,
		}
	} else {
		for (const collection of COLLECTIONS) {
			const { touched } = work.rows[collection]
			if (!touched.size) continue
			const generation = await nextGeneration(folder, collection, work.damaged?.logs[collection]?.generation)
			written[collection] = await writeLog(folder, collection, generation, serialized(touched), assertLease)
			logs[collection] = { generation, bytes: written[collection].bytes, rows: written[collection].lines.size }
		}
		values = summaryLatest((collection) => [...work.rows[collection].touched.values()].map(({ row }) => row))
	}

	const head: WorkHead = { version: 2, workId, updatedAt: new Date().toISOString(), sessions, logs, ...values }
	await writeFileDurably(join(folder, WORK_FILE), `${JSON.stringify(head, null, 2)}\n`, assertLease)
	for (const collection of COLLECTIONS) {
		const index = written[collection]
		if (index) remember(folder, collection, index)
	}

	const compacted = await compactLogs(folder, head, { ...work.indexes, ...written }, assertLease)
	if (generations || compacted || !cleaned.has(folder)) {
		await removeStrays(folder, compacted ?? head)
		cleaned.add(folder)
	}
	return compacted ?? head
}

/** Folders whose stray row files this process already removed. */
const cleaned = new Set<string>()

/** Each key's newest row in a log this process indexed, in first-seen order. */
function liveRows(folder: string, collection: Collection, index: LogIndex): Row[] {
	const buffer = readLogSync(folder, collection, index.generation, index.bytes)
	return [...index.lines.values()].map(({ offset, length }) =>
		parseRow(buffer.toString("utf8", offset, offset + length), collection),
	)
}

/**
 * Rewrites logs whose superseded lines outweigh half their live rows: each key's newest line is copied in
 * first-seen order to the next generation, committed with `latest` recomputed from every row, then the old
 * generation is deleted. A reader holding the old manifest sees it missing once and rereads the manifest.
 */

async function compactLogs(
	folder: string,
	head: WorkHead,
	indexes: Partial<Record<Collection, LogIndex>>,
	assertLease: () => void,
): Promise<WorkHead | undefined> {
	const due = new Set(
		COLLECTIONS.filter((collection) => {
			const log = head.logs[collection]
			const index = indexes[collection]
			return log && index && log.bytes > 1.5 * index.live && log.bytes - index.live > COMPACT_GARBAGE_BYTES
		}),
	)
	if (!due.size) return undefined
	const logs = { ...head.logs }
	const latest: WorkLatest = {}
	let pullRequests: Record<string, unknown>[] = []
	const replaced: [Collection, LogIndex, number][] = []
	for (const collection of COLLECTIONS) {
		const index = indexes[collection]
		if (!index) continue
		const buffer = readLogSync(folder, collection, index.generation, index.bytes)
		const commits: Row[] = []
		const live = function* (): Generator<[string, string]> {
			for (const [key, { offset, length }] of index.lines) {
				const line = buffer.toString("utf8", offset, offset + length)
				const row = parseRow(line, collection)
				observeLatest(latest, collection, row)
				if (collection === "commits") commits.push(row)
				yield [key, line]
			}
		}
		if (due.has(collection)) {
			const generation = await nextGeneration(folder, collection, index.generation)
			const next = await writeLog(folder, collection, generation, live(), assertLease)
			replaced.push([collection, next, index.generation])
			logs[collection] = { generation, bytes: next.bytes, rows: next.lines.size }
		} else {
			let rows = 0
			for (const _ of live()) if (++rows % YIELD_ROWS === 0) await setImmediate()
		}
		if (collection === "commits") pullRequests = commitPullRequests(commits)
	}

	const compacted: WorkHead = { ...head, logs, latest, pullRequests }
	await writeFileDurably(join(folder, WORK_FILE), `${JSON.stringify(compacted, null, 2)}\n`, assertLease)
	for (const [collection, index, old] of replaced) {
		remember(folder, collection, index)
		await rm(logPath(folder, collection, old), { force: true }).catch(() => {})
	}
	return compacted
}

/**
 * One locked update: opens the work's summary in either version, lets `apply` merge records into its rows, then
 * commits what changed. A version 1 summary migrates here; a missing, invalid or damaged one is rebuilt, and
 * `apply` learns that it must merge the work's whole history. Returns the committed manifest, or undefined
 * when nothing changed.
 */

export async function updateWorkRows(
	folder: string,
	workId: string,
	options: {
		/** A valid version 1 summary with every collection, or undefined. */
		summary: (value: unknown) => WorkSummaryView | undefined
		check: RowCheck
		assertLease: () => void
	},
	apply: (rows: WorkRows, rebuild: boolean) => Promise<void>,
): Promise<WorkHead | undefined> {
	const work = await openWork(folder, workId, options.summary, options.check)
	try {
		await apply(work.rows, work.rebuild)
		// Saved rows are loaded; a compaction may delete the file they came from.
		work.close()
		return await commitWork(folder, workId, work, options.assertLease)
	} catch (error) {
		// Cached positions may include rows that were never committed, and a new generation may be left behind.
		forget(folder)
		cleaned.delete(folder)
		throw error
	} finally {
		work.close()
	}
}

/** Cheap validity for launch recovery: a version 1 summary, or a manifest whose logs hold their committed bytes. */
export async function validWorkFiles(
	folder: string,
	workId: string,
	summary: (value: unknown) => boolean,
): Promise<boolean> {
	let value: unknown
	try {
		value = JSON.parse(await readFile(join(folder, WORK_FILE), "utf8"))
	} catch {
		return false
	}
	if (!isWorkHead(value, workId)) return summary(value)
	for (const collection of COLLECTIONS) {
		const log = value.logs[collection]
		if (!log) continue
		const info = await stat(logPath(folder, collection, log.generation)).catch(() => undefined)
		if (!info || info.size < log.bytes) return false
	}
	return true
}
