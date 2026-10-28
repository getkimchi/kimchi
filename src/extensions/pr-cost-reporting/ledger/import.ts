import { createHash, type Hash } from "node:crypto"
import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs"
import { join } from "node:path"
import {
	journalParser,
	object,
	type WorkRecord,
	type WorkRecordProblem,
	workJournals,
} from "../../work-attribution/summary.js"
import {
	backendFor,
	diagnostic,
	type ImportEntry,
	importBatchInTx,
	type JournalCursor,
	type RecordBackend,
} from "./records.js"

/** Immutable legacy import: authority, projection, coverage and cursor commit together. */
export type JournalMode = "fresh" | "clean-append" | "mutation"
export interface JournalDecision {
	mode: JournalMode
	generation: number
	offset: number
}
export interface JournalAnomaly {
	path: string
	code: "journal-mutation" | "journal-removed"
}
export interface ImportResult {
	files: { path: string; mode: JournalMode; generation: number; imported: number; skipped: number }[]
	anomalies: JournalAnomaly[]
	problems: WorkRecordProblem[]
	imported: number
	skipped: number
	/** More complete input remains after this bounded pass. */
	pending?: boolean
}

const EMPTY_HASH = createHash("sha256").digest("hex")
const COVERAGE_NOTES = "journal-coverage"
const TAIL_NOTES = "journal-tail"
const WINDOW_BYTES = 512 * 1024
const READ_BYTES = 64 * 1024

function savedProblem(value: unknown, path: string): value is WorkRecordProblem {
	return (
		object(value) &&
		value.path === path &&
		typeof value.line === "number" &&
		Number.isSafeInteger(value.line) &&
		value.line > 0 &&
		(value.kind === "invalid" || (value.kind === "unknown-type" && object(value.record)))
	)
}

function coverageProblems(backend: RecordBackend, path: string, category = COVERAGE_NOTES): WorkRecordProblem[] {
	const body = backend.getNote(category, path)
	if (body === undefined) return []
	try {
		const value: unknown = JSON.parse(body)
		if (Array.isArray(value) && value.every((problem) => savedProblem(problem, path))) return value
	} catch {}
	return [{ kind: "invalid", path, line: 1 }]
}

function putProblems(backend: RecordBackend, path: string, category: string, problems: WorkRecordProblem[]): void {
	const unique = new Map(problems.map((problem) => [JSON.stringify(problem), problem]))
	const body = JSON.stringify([...unique.values()])
	if (backend.getNote(category, path) !== body) backend.putNote(category, path, body)
}

function saveCoverage(backend: RecordBackend, path: string, problems: WorkRecordProblem[]): void {
	putProblems(backend, path, COVERAGE_NOTES, [...coverageProblems(backend, path), ...problems])
}

/** Consuming damaged input cannot make subsequent readers believe history is complete. */
export function reportJournalProblems(
	agentDir: string,
	onProblem: (problem: WorkRecordProblem) => void,
	checkBudget?: () => void,
): void {
	const backend = backendFor(agentDir)
	for (const cursor of backend.listJournalCursors()) {
		checkBudget?.()
		for (const category of [COVERAGE_NOTES, TAIL_NOTES]) {
			for (const problem of coverageProblems(backend, cursor.path, category)) {
				checkBudget?.()
				onProblem(problem)
			}
		}
	}
}

export function boundaryHashOf(file: Buffer, offset: number): string {
	return offset <= 0 ? EMPTY_HASH : createHash("sha256").update(file.subarray(0, offset)).digest("hex")
}

function cursorDecision(
	cursor: JournalCursor | undefined,
	dev: number,
	ino: number,
	size: number,
	prefix: string,
): JournalDecision {
	if (!cursor) return { mode: "fresh", generation: 1, offset: 0 }
	if (cursor.dev === dev && cursor.ino === ino && size >= cursor.offset && prefix === cursor.boundaryHash)
		return { mode: "clean-append", generation: cursor.generation, offset: cursor.offset }
	return { mode: "mutation", generation: cursor.generation + 1, offset: 0 }
}

export function journalDecision(
	cursor: JournalCursor | undefined,
	dev: number,
	ino: number,
	size: number,
	file: Buffer,
): JournalDecision {
	return cursorDecision(cursor, dev, ino, size, boundaryHashOf(file, cursor?.offset ?? 0))
}

interface Line {
	start: number
	end: number
	text: string
}

/** Only LF-terminated records are consumed; unfinished bytes remain for the next pass. */
export function completeLines(file: Buffer, from: number, to: number): Line[] {
	const lines: Line[] = []
	let start = from
	for (let index = from; index < to; index++) {
		if (file[index] !== 0x0a) continue
		lines.push({ start, end: index + 1, text: file.toString("utf8", start, index) })
		start = index + 1
	}
	return lines
}

/** Coarse filesystem clocks can stamp a write a little before the cursor written after it. */
const MTIME_SLACK_MS = 2000
/** Committed cursor state kept across both window boundaries and completed appends. */
const continued = new Map<
	string,
	{
		dev: number
		ino: number
		size: number
		offset: number
		mtimeMs: number
		boundaryHash: string
		hash: Hash
		lines: number
	}
>()
/** The journal each agent directory's last timed slice stopped at; the next slice starts there instead of rewalking. */
const stopped = new Map<string, string>()

/** Prefix verification and body reads both yield to the synchronous deadline between fixed-size reads. */
function prepareJournal(
	path: string,
	cursor: JournalCursor | undefined,
	replay: boolean,
	maxBytes: number,
	checkBudget?: () => void,
) {
	checkBudget?.()
	// A journal last modified well before its cursor was written still holds the prefix that cursor hashed.
	const untouched = (stat: { dev: number; ino: number; size: number; mtimeMs: number }) =>
		!replay &&
		cursor?.dev === stat.dev &&
		cursor.ino === stat.ino &&
		stat.size >= cursor.offset &&
		stat.mtimeMs < cursor.updatedAt - MTIME_SLACK_MS
	const seen = statSync(path)
	if (untouched(seen) && seen.size === cursor?.offset) return undefined
	const fd = openSync(path, "r")
	try {
		const stat = fstatSync(fd)
		const { dev, ino, size } = stat
		const buffer = Buffer.allocUnsafe(READ_BYTES)
		let prefix: Hash = createHash("sha256")
		let lineOffset = 0
		const known = cursor && continued.get(path)
		if (
			cursor &&
			known?.boundaryHash === cursor.boundaryHash &&
			known.dev === dev &&
			known.ino === ino &&
			known.offset === cursor.offset &&
			known.size === size &&
			stat.mtimeMs === known.mtimeMs
		) {
			prefix = known.hash.copy()
			lineOffset = known.lines
		} else if (cursor && cursor.dev === dev && cursor.ino === ino && size >= cursor.offset) {
			let position = 0
			while (position < cursor.offset) {
				checkBudget?.()
				const count = readSync(fd, buffer, 0, Math.min(buffer.length, cursor.offset - position), position)
				checkBudget?.()
				if (!count) throw new Error("Legacy journal changed during prefix verification")
				const chunk = buffer.subarray(0, count)
				prefix.update(chunk)
				for (let lf = chunk.indexOf(0x0a); lf !== -1; lf = chunk.indexOf(0x0a, lf + 1)) lineOffset++
				position += count
			}
		}
		const decision = cursorDecision(cursor, dev, ino, size, prefix.copy().digest("hex"))
		if (decision.mode !== "clean-append" || replay) {
			decision.offset = 0
			prefix = createHash("sha256")
			lineOffset = 0
		}
		const target = Math.min(size - decision.offset, maxBytes)
		const chunks: Buffer[] = []
		let bytes = 0
		let hasLf = false
		while (decision.offset + bytes < size && (bytes < target || !hasLf)) {
			checkBudget?.()
			const length = bytes < target ? Math.min(buffer.length, target - bytes) : buffer.length
			let count = readSync(fd, buffer, 0, Math.min(length, size - decision.offset - bytes), decision.offset + bytes)
			checkBudget?.()
			if (!count) throw new Error("Legacy journal changed during body read")
			// A first oversized record may cross the window, but never silently stalls behind it.
			if (bytes >= target) {
				const lf = buffer.subarray(0, count).indexOf(0x0a)
				if (lf !== -1) count = lf + 1
			}
			const chunk = Buffer.from(buffer.subarray(0, count))
			if (chunk.includes(0x0a)) hasLf = true
			chunks.push(chunk)
			bytes += count
		}
		checkBudget?.()
		return { dev, ino, size, mtimeMs: stat.mtimeMs, decision, prefix, lineOffset, data: Buffer.concat(chunks, bytes) }
	} finally {
		closeSync(fd)
	}
}

function syncWorkJournals(agentDir: string): string[] {
	const paths: string[] = []
	for (const source of [join(agentDir, "work-attribution"), join(agentDir, "work-attribution", "transitions")]) {
		try {
			for (const file of readdirSync(source, { withFileTypes: true }))
				if (file.isFile() && file.name.endsWith(".jsonl")) paths.push(join(source, file.name))
		} catch (error) {
			if (!object(error) || error.code !== "ENOENT") throw error
		}
	}
	return paths
}

function importJournalFiles(
	agentDir: string,
	journals: string[],
	{ maxBytes = WINDOW_BYTES, onRecordProblem: onProblem, checkBudget, until }: ImportOptions,
	/** Report cursors of journals missing from this listing; only a full listing can tell. */
	sweep: boolean,
): ImportResult {
	checkBudget?.()
	const result: ImportResult = { files: [], anomalies: [], problems: [], imported: 0, skipped: 0 }
	const backend = backendFor(agentDir)
	const start = until === undefined ? 0 : Math.max(0, journals.indexOf(stopped.get(agentDir) ?? ""))
	for (const path of [...journals.slice(start), ...journals.slice(0, start)]) {
		checkBudget?.()
		const cursor = backend.getJournalCursor(path)
		let prepared: ReturnType<typeof prepareJournal>
		try {
			prepared = prepareJournal(
				path,
				cursor,
				!!cursor && backend.getNote(COVERAGE_NOTES, path) === undefined,
				maxBytes,
				checkBudget,
			)
		} catch (error) {
			if (!object(error) || error.code !== "ENOENT") throw error
			if (cursor) forgetJournal(agentDir, backend, path, result)
			continue
		}
		if (!prepared) continue
		const { dev, ino, size, mtimeMs, decision, prefix, lineOffset, data } = prepared
		if (decision.mode === "mutation") result.anomalies.push({ path, code: "journal-mutation" })
		const lines = completeLines(data, 0, data.length)
		if (!lines.length) {
			if (decision.mode === "mutation") {
				checkBudget?.()
				backend.tx(() => saveCoverage(backend, path, [{ kind: "invalid", path, line: 1 }]))
				diagnostic(agentDir, "journal-mutation")
			}
			if (decision.offset < size)
				result.files.push({ path, mode: decision.mode, generation: decision.generation, imported: 0, skipped: 0 })
			// A verified journal that settled since its cursor skips verification from now on.
			else if (cursor && decision.mode === "clean-append" && Date.now() - mtimeMs > MTIME_SLACK_MS)
				backend.putJournalCursor({ ...cursor, updatedAt: Date.now() })
			continue
		}
		const parsed: WorkRecord[] = []
		const entries: ImportEntry[] = []
		const problems: WorkRecordProblem[] = decision.mode === "mutation" ? [{ kind: "invalid", path, line: 1 }] : []
		let tail = decision.mode === "clean-append" ? coverageProblems(backend, path, TAIL_NOTES) : []
		const parser = journalParser(
			path,
			parsed,
			(problem) => {
				const positioned = { ...problem, line: problem.line + lineOffset }
				problems.push(positioned)
				result.problems.push(positioned)
				onProblem?.(positioned)
			},
			(problem) => {
				const positioned = { ...problem, line: problem.line + lineOffset }
				tail.push(positioned)
				result.problems.push(positioned)
				onProblem?.(positioned)
			},
		)
		for (const line of lines) {
			checkBudget?.()
			if (line.text.trim()) tail = []
			const before = parsed.length
			parser(line.text, false)
			if (parsed.length > before)
				entries.push({
					line: line.text,
					record: parsed[before],
					sourcePath: path,
					sourceGeneration: decision.generation,
					sourceOffset: decision.offset + line.start,
				})
		}
		// Preserve a pending cut across batches; only a later nonblank line resolves it.
		parser("", true)
		const consumed = lines[lines.length - 1].end
		const consumedEnd = decision.offset + consumed
		checkBudget?.()
		prefix.update(data.subarray(0, consumed))
		const hash = prefix.copy()
		const boundaryHash = prefix.digest("hex")
		let imported = 0
		backend.tx(() => {
			saveCoverage(backend, path, problems)
			putProblems(backend, path, TAIL_NOTES, tail)
			if (entries.length) {
				imported = importBatchInTx(backend, entries)
			}
			backend.putJournalCursor({
				path,
				dev,
				ino,
				generation: decision.generation,
				offset: consumedEnd,
				boundaryHash,
				updatedAt: Date.now(),
			})
		})
		continued.set(path, {
			dev,
			ino,
			size,
			offset: consumedEnd,
			mtimeMs,
			boundaryHash,
			hash,
			lines: lineOffset + lines.length,
		})
		if (decision.mode === "mutation") diagnostic(agentDir, "journal-mutation")
		if (decision.offset + data.length < size) result.pending = true
		result.imported += imported
		result.skipped += entries.length - imported
		result.files.push({
			path,
			mode: decision.mode,
			generation: decision.generation,
			imported,
			skipped: entries.length - imported,
		})
		// Unchanged journals cost a stat each; only journals that imported spend the slice.
		if (until !== undefined && Date.now() >= until) {
			result.pending = true
			stopped.set(agentDir, path)
			break
		}
	}
	const listed = new Set(journals)
	if (sweep)
		for (const cursor of backend.listJournalCursors()) {
			checkBudget?.()
			if (listed.has(cursor.path)) continue
			try {
				statSync(cursor.path)
			} catch (error) {
				if (!object(error) || error.code !== "ENOENT") throw error
				forgetJournal(agentDir, backend, cursor.path, result)
			}
		}
	return result
}

/**
 * A removed journal's imported records stay; its cursor and coverage go, so it is reported once instead of marking
 * history incomplete on every later pass, as the journal-era reader also stopped counting a file that was gone.
 */
function forgetJournal(agentDir: string, backend: RecordBackend, path: string, result: ImportResult): void {
	result.anomalies.push({ path, code: "journal-removed" })
	backend.tx(() => {
		backend.deleteJournalCursor(path)
		backend.deleteNote(COVERAGE_NOTES, path)
		backend.deleteNote(TAIL_NOTES, path)
	})
	continued.delete(path)
	diagnostic(agentDir, "journal-removed")
}

interface ImportOptions {
	maxBytes?: number
	onRecordProblem?: (problem: WorkRecordProblem) => void
	checkBudget?: () => void
	/** After a journal that imported something, stop once this time has passed; the result is then pending. */
	until?: number
}

/** How long one import slice may hold the event loop before yielding. */
export const IMPORT_SLICE_MS = 50

export async function importJournals(agentDir: string, options: ImportOptions = {}): Promise<ImportResult> {
	return importJournalFiles(agentDir, await workJournals(agentDir), options, true)
}

/** One synchronous slice over every journal; true while more input remains for a later slice. */
export function importJournalSlice(agentDir: string, checkBudget?: () => void): boolean {
	const options = { checkBudget, until: Date.now() + IMPORT_SLICE_MS }
	return importJournalFiles(agentDir, syncWorkJournals(agentDir), options, true).pending === true
}

/** One session's journal in full, so a resumed legacy session keeps its work before the background import arrives. */
export function importSessionJournal(agentDir: string, path: string): void {
	for (;;) if (!importJournalFiles(agentDir, [path], {}, false).pending) return
}
