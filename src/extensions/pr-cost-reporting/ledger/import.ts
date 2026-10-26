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

/** Prefix verification and body reads both yield to the synchronous deadline between fixed-size reads. */
function prepareJournal(
	path: string,
	cursor: JournalCursor | undefined,
	replay: boolean,
	maxBytes: number,
	checkBudget?: () => void,
) {
	checkBudget?.()
	const fd = openSync(path, "r")
	try {
		const { dev, ino, size } = fstatSync(fd)
		const buffer = Buffer.allocUnsafe(READ_BYTES)
		let prefix: Hash = createHash("sha256")
		let lineOffset = 0
		if (cursor && cursor.dev === dev && cursor.ino === ino && size >= cursor.offset) {
			let position = 0
			while (position < cursor.offset) {
				checkBudget?.()
				const count = readSync(fd, buffer, 0, Math.min(buffer.length, cursor.offset - position), position)
				checkBudget?.()
				if (!count) throw new Error("Legacy journal changed during prefix verification")
				const chunk = buffer.subarray(0, count)
				prefix.update(chunk)
				for (const byte of chunk) if (byte === 0x0a) lineOffset++
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
		return { dev, ino, size, decision, prefix, lineOffset, data: Buffer.concat(chunks, bytes) }
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
	maxBytes: number,
	onProblem?: (problem: WorkRecordProblem) => void,
	checkBudget?: () => void,
): ImportResult {
	checkBudget?.()
	const result: ImportResult = { files: [], anomalies: [], problems: [], imported: 0, skipped: 0 }
	const backend = backendFor(agentDir)
	for (const path of journals) {
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
			if (cursor) {
				result.anomalies.push({ path, code: "journal-removed" })
				backend.tx(() => saveCoverage(backend, path, [{ kind: "invalid", path, line: 1 }]))
				diagnostic(agentDir, "journal-removed")
			}
			continue
		}
		const { dev, ino, size, decision, prefix, lineOffset, data } = prepared
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
				boundaryHash: prefix.update(data.subarray(0, consumed)).digest("hex"),
				updatedAt: Date.now(),
			})
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
	}
	for (const cursor of backend.listJournalCursors()) {
		checkBudget?.()
		if (journals.includes(cursor.path)) continue
		try {
			statSync(cursor.path)
		} catch (error) {
			if (!object(error) || error.code !== "ENOENT") throw error
			result.anomalies.push({ path: cursor.path, code: "journal-removed" })
			backend.tx(() => saveCoverage(backend, cursor.path, [{ kind: "invalid", path: cursor.path, line: 1 }]))
			diagnostic(agentDir, "journal-removed")
		}
	}
	return result
}

interface ImportOptions {
	maxBytes?: number
	onRecordProblem?: (problem: WorkRecordProblem) => void
	checkBudget?: () => void
}

export async function importJournals(agentDir: string, options: ImportOptions = {}): Promise<ImportResult> {
	return importJournalFiles(
		agentDir,
		await workJournals(agentDir),
		options.maxBytes ?? WINDOW_BYTES,
		options.onRecordProblem,
		options.checkBudget,
	)
}

/** Synchronous history hydration drains bounded batches without holding a transaction between them. */
export function hydrateLegacy(agentDir: string, options: ImportOptions = {}): ImportResult {
	const journals = syncWorkJournals(agentDir)
	const result = importJournalFiles(
		agentDir,
		journals,
		options.maxBytes ?? WINDOW_BYTES,
		options.onRecordProblem,
		options.checkBudget,
	)
	while (result.pending && options.maxBytes === undefined) {
		const next = importJournalFiles(agentDir, journals, WINDOW_BYTES, options.onRecordProblem, options.checkBudget)
		result.files.push(...next.files)
		result.anomalies.push(...next.anomalies)
		result.problems.push(...next.problems)
		result.imported += next.imported
		result.skipped += next.skipped
		result.pending = next.pending
	}
	if (!result.pending) delete result.pending
	return result
}

const hydratedDirs = new Set<string>()
export function hydrateLegacyOnce(agentDir: string): void {
	if (hydratedDirs.has(agentDir)) return
	hydrateLegacy(agentDir)
	hydratedDirs.add(agentDir)
}
