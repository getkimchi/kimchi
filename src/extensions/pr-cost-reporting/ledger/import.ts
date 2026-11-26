import { createHash, type Hash } from "node:crypto"
import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
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
const REVERIFY_NOTES = "journal-reverify"
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

/** The re-verification of a flagged journal, saved so later windows continue the from-start read. */
function reverifyProgress(backend: RecordBackend, path: string): { offset: number; boundaryHash: string } | undefined {
	const body = backend.getNote(REVERIFY_NOTES, path)
	if (body === undefined) return undefined
	try {
		const value: unknown = JSON.parse(body)
		if (
			object(value) &&
			typeof value.offset === "number" &&
			Number.isSafeInteger(value.offset) &&
			value.offset >= 0 &&
			typeof value.boundaryHash === "string" &&
			/^[0-9a-f]{64}$/.test(value.boundaryHash)
		)
			return { offset: value.offset, boundaryHash: value.boundaryHash }
	} catch {}
	return undefined
}

/** A journal verified clean to the end no longer needs its from-start re-verification. */
function clearReverify(backend: RecordBackend, path: string): void {
	backend.deleteNote(REVERIFY_NOTES, path)
}

function saveReverify(backend: RecordBackend, path: string, offset: number, boundaryHash: string): void {
	backend.putNote(REVERIFY_NOTES, path, JSON.stringify({ offset, boundaryHash }))
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
/** The cooperative preflight uses the same bounded read size as the synchronous body importer. */
const PREFIX_CHUNK_BYTES = READ_BYTES
/** Committed cursor state kept across both window boundaries and completed appends: what this
 * process verified about a journal prefix — file identity, stat, boundary hash, running hash
 * and line count. A fresh process starts empty and verifies from the store's cursor alone. */
const continued = new Map<
	string,
	{
		dev: number
		ino: number
		size: number
		offset: number
		mtimeMs: number
		ctimeMs: number
		boundaryHash: string
		hash: Hash
		lines: number
	}
>()
/** The journal each agent directory's last timed slice stopped at; the next slice starts there instead of rewalking. */
const stopped = new Map<string, string>()
/** The memo is bounded: a long-lived process that visits many agent directories cannot accumulate
 * one hash entry per journal forever; the oldest verified prefix ages out first. */
const MAX_MEMO_JOURNALS = 4096
function rememberContinued(
	path: string,
	entry: {
		dev: number
		ino: number
		size: number
		offset: number
		mtimeMs: number
		ctimeMs: number
		boundaryHash: string
		hash: Hash
		lines: number
	},
): void {
	continued.delete(path)
	continued.set(path, entry)
	while (continued.size > MAX_MEMO_JOURNALS) continued.delete(continued.keys().next().value as string)
}
/** The replay decision shared by the capture preflight and the importer: a journal whose saved
 * damage this process has not re-verified, or whose coverage note is missing, reads from the start. */
function replayDecision(backend: RecordBackend, path: string, cursor: JournalCursor | undefined): boolean {
	const savedDamage =
		coverageProblems(backend, path).length > 0 || coverageProblems(backend, path, TAIL_NOTES).length > 0
	const recheck = savedDamage && !rechecked.has(path)
	return recheck || (!!cursor && backend.getNote(COVERAGE_NOTES, path) === undefined)
}

/** Journals whose saved problems this process already re-verified from the start. */
const rechecked = new Set<string>()

/** Capture-only preflight: verify every old byte before the synchronous importer can reuse its running hash.
 * The whole-prefix re-read this function performs is the one an append always owes — but cooperatively,
 * yielding between pages, so it never holds the event loop. Memoized with the post-read stat, so an
 * unchanged file skips even this. Growth during the read is safe: it cannot change the consumed prefix,
 * whose hash the importer still checks; any other change invalidates the memo and re-runs. */
async function verifyCapturePrefix(
	path: string,
	cursor: JournalCursor,
	replay: boolean,
	checkBudget?: () => void,
): Promise<void> {
	if (!cursor.offset) return
	checkBudget?.()
	const fd = openSync(path, "r")
	try {
		const before = fstatSync(fd)
		if (before.dev !== cursor.dev || before.ino !== cursor.ino || before.size < cursor.offset) return
		const known = continued.get(path)
		const samePrefix =
			known !== undefined &&
			known.dev === cursor.dev &&
			known.ino === cursor.ino &&
			known.offset === cursor.offset &&
			known.boundaryHash === cursor.boundaryHash
		const sameStat =
			samePrefix && known.size === before.size && known.mtimeMs === before.mtimeMs && known.ctimeMs === before.ctimeMs
		if (
			sameStat ||
			(!replay &&
				before.size === cursor.offset &&
				before.mtimeMs < cursor.updatedAt - MTIME_SLACK_MS &&
				before.ctimeMs < cursor.updatedAt - MTIME_SLACK_MS)
		)
			return
		const prefix = createHash("sha256")
		let lines = samePrefix ? known.lines : 0
		const buffer = Buffer.allocUnsafe(Math.min(PREFIX_CHUNK_BYTES, cursor.offset))
		for (let position = 0; position < cursor.offset; ) {
			checkBudget?.()
			const length = Math.min(buffer.length, cursor.offset - position)
			let read = 0
			while (read < length) {
				checkBudget?.()
				const count = readSync(fd, buffer, read, length - read, position + read)
				if (!count) throw new Error("Legacy journal changed during prefix verification")
				read += count
			}
			const chunk = buffer.subarray(0, length)
			prefix.update(chunk)
			if (!samePrefix) for (let lf = chunk.indexOf(0x0a); lf !== -1; lf = chunk.indexOf(0x0a, lf + 1)) lines++
			position += length
			checkBudget?.()
			await setImmediate()
		}
		const after = fstatSync(fd)
		const unchanged =
			after.dev === before.dev &&
			after.ino === before.ino &&
			after.size === before.size &&
			after.mtimeMs === before.mtimeMs &&
			after.ctimeMs === before.ctimeMs
		const grew = after.dev === before.dev && after.ino === before.ino && after.size > before.size
		if (!unchanged && !grew) {
			continued.delete(path)
			return
		}
		rememberContinued(path, {
			dev: after.dev,
			ino: after.ino,
			size: after.size,
			offset: cursor.offset,
			mtimeMs: after.mtimeMs,
			ctimeMs: after.ctimeMs,
			boundaryHash: cursor.boundaryHash,
			hash: prefix,
			lines,
		})
	} finally {
		closeSync(fd)
	}
}

/** Prefix verification and body reads both yield to the synchronous deadline between fixed-size reads. */
function prepareJournal(
	path: string,
	cursor: JournalCursor | undefined,
	replay: boolean,
	maxBytes: number,
	verifiedPrefix: boolean,
	checkBudget?: () => void,
) {
	checkBudget?.()
	// A journal last modified well before its cursor was written still holds the prefix that cursor hashed.
	const untouched = (stat: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }) =>
		!replay &&
		cursor?.dev === stat.dev &&
		cursor.ino === stat.ino &&
		stat.size >= cursor.offset &&
		stat.mtimeMs < cursor.updatedAt - MTIME_SLACK_MS &&
		stat.ctimeMs < cursor.updatedAt - MTIME_SLACK_MS
	const seen = statSync(path)
	if (untouched(seen) && seen.size === cursor?.offset) return undefined
	const fd = openSync(path, "r")
	try {
		const stat = fstatSync(fd)
		const { dev, ino, size } = stat
		const buffer = Buffer.allocUnsafe(READ_BYTES)
		let prefix: Hash = createHash("sha256")
		const known = cursor ? continued.get(path) : undefined
		const samePrefix =
			!!cursor &&
			known !== undefined &&
			known.boundaryHash === cursor.boundaryHash &&
			known.dev === dev &&
			known.ino === ino &&
			known.offset === cursor.offset
		let lineOffset = samePrefix ? known.lines : 0
		// A settled file's memo is trustworthy for every caller (its times predate the cursor that
		// committed it); a fresh file's exact-stat memo only for capture, whose preflight read the
		// bytes behind it. Strict readers keep their inline verification on fresh files — the
		// budget-checked cancellation their preparation contract requires.
		if (
			samePrefix &&
			(untouched(stat) ||
				(verifiedPrefix && known.size === size && stat.mtimeMs === known.mtimeMs && stat.ctimeMs === known.ctimeMs))
		) {
			prefix = known.hash.copy()
		} else if (cursor && cursor.dev === dev && cursor.ino === ino && size >= cursor.offset) {
			// Only the capture path defers: it runs the cooperative preflight first, and its slice never
			// pays the synchronous prefix re-read. Strict readers verify here, as they always did.
			if (verifiedPrefix && cursor.offset > 0) return "pending" as const
			let position = 0
			while (position < cursor.offset) {
				checkBudget?.()
				const count = readSync(fd, buffer, 0, Math.min(buffer.length, cursor.offset - position), position)
				checkBudget?.()
				if (!count) throw new Error("Legacy journal changed during prefix verification")
				const chunk = buffer.subarray(0, count)
				prefix.update(chunk)
				// Recheck the full prefix hash on append, but its verified line count cannot change without a hash mismatch.
				if (!samePrefix) for (let lf = chunk.indexOf(0x0a); lf !== -1; lf = chunk.indexOf(0x0a, lf + 1)) lineOffset++
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
		return {
			dev,
			ino,
			size,
			mtimeMs: stat.mtimeMs,
			ctimeMs: stat.ctimeMs,
			decision,
			prefix,
			lineOffset,
			data: Buffer.concat(chunks, bytes),
		}
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
	{
		maxBytes = WINDOW_BYTES,
		onRecordProblem: onProblem,
		checkBudget,
		until,
		verifyCapturePrefix = false,
	}: ImportOptions,
	/** Report cursors of journals missing from this listing; only a full listing can tell. */
	sweep: boolean,
): ImportResult {
	checkBudget?.()
	const result: ImportResult = { files: [], anomalies: [], problems: [], imported: 0, skipped: 0 }
	const backend = backendFor(agentDir)
	const start = until === undefined ? 0 : Math.max(0, journals.indexOf(stopped.get(agentDir) ?? ""))
	const ordered = [...journals.slice(start), ...journals.slice(0, start)]
	for (let journalIndex = 0; journalIndex < ordered.length; journalIndex += 1) {
		const path = ordered[journalIndex]
		checkBudget?.()
		const cursor = backend.getJournalCursor(path)
		// A journal with saved problems is re-read from the start once per process: the note describes an
		// older state of the file, and only a clean re-import can prove it stale. Problems the note
		// already holds are not reported again while it re-verifies, so a still-damaged journal stays
		// as quiet as before; an empty note marks a clean read and lets later passes skip.
		const savedProblems = coverageProblems(backend, path)
		const savedDamage = savedProblems.length > 0 || coverageProblems(backend, path, TAIL_NOTES).length > 0
		const recheck = savedDamage && !rechecked.has(path)
		const known = new Set(savedProblems.map((problem) => JSON.stringify(problem)))
		const replay = replayDecision(backend, path, cursor)
		if (recheck) rechecked.add(path)
		let prepared: ReturnType<typeof prepareJournal>
		try {
			prepared = prepareJournal(path, cursor, replay, maxBytes, verifyCapturePrefix, checkBudget)
		} catch (error) {
			if (!object(error) || error.code !== "ENOENT") throw error
			if (cursor) forgetJournal(agentDir, backend, path, result)
			continue
		}
		// The capture path never pays the synchronous prefix re-read: an unverified prefix defers this
		// slice, and the next one runs after the cooperative preflight has verified (or the file settled).
		if (prepared === "pending") {
			result.pending = true
			stopped.set(agentDir, path)
			break
		}
		if (!prepared) continue
		const { dev, ino, size, mtimeMs, ctimeMs, decision, prefix, lineOffset, data } = prepared
		if (decision.mode === "mutation") result.anomalies.push({ path, code: "journal-mutation" })
		const lines = completeLines(data, 0, data.length)
		if (!lines.length) {
			// A clean append whose new bytes hold no complete line: memoize the verified prefix for
			// the cursor, so a later append reuses it once the preflight has re-verified the growth.
			if (cursor && decision.mode === "clean-append")
				rememberContinued(path, {
					dev,
					ino,
					size,
					offset: cursor.offset,
					mtimeMs,
					ctimeMs,
					boundaryHash: cursor.boundaryHash,
					hash: prefix.copy(),
					lines: lineOffset,
				})
			if (decision.offset === 0 && decision.offset + data.length >= size) {
				// An emptied or truncated-to-nothing journal retires its stale notes instead of
				// wedging capture forever: its records stay in the store from earlier imports. Both
				// note kinds are reported, so the tail note of an interrupted append goes as well.
				checkBudget?.()
				backend.tx(() => {
					putProblems(backend, path, COVERAGE_NOTES, [])
					putProblems(backend, path, TAIL_NOTES, [])
					clearReverify(backend, path)
					backend.putJournalCursor({
						path,
						dev,
						ino,
						generation: decision.generation,
						offset: size,
						boundaryHash: boundaryHashOf(data, size),
						updatedAt: Date.now(),
					})
				})
			} else if (decision.mode === "mutation") {
				checkBudget?.()
				backend.tx(() => saveCoverage(backend, path, [{ kind: "invalid", path, line: 1 }]))
				diagnostic(agentDir, "journal-mutation")
			}
			if (decision.offset < size)
				result.files.push({ path, mode: decision.mode, generation: decision.generation, imported: 0, skipped: 0 })
			// A verified journal that settled since its cursor skips verification from now on.
			else if (cursor && decision.mode === "clean-append" && Date.now() - Math.max(mtimeMs, ctimeMs) > MTIME_SLACK_MS)
				backend.putJournalCursor({ ...cursor, updatedAt: Date.now() })
			continue
		}
		// A from-start re-verification continues across passes: the saved progress matches the cursor's
		// consumed prefix, so later windows extend the replay and only an end-reaching clean read
		// retires the note. Journals larger than one window settle between slices, not within it.
		const reverify = reverifyProgress(backend, path)
		const reverifying =
			reverify !== undefined &&
			savedProblems.length > 0 &&
			!recheck &&
			decision.mode === "clean-append" &&
			decision.offset === reverify.offset &&
			cursor?.boundaryHash === reverify.boundaryHash
		const parsed: WorkRecord[] = []
		const entries: ImportEntry[] = []
		// A mutated prefix does not itself mark a healthy journal incomplete: every line is
		// re-imported from the start and earlier generations' records stay in the store. A journal
		// that already carried problems keeps them through a rewrite, because a rewrite can hide the
		// correction or producer evidence behind them.
		const tampered = decision.mode === "mutation" && savedDamage
		const problems: WorkRecordProblem[] = tampered ? [{ kind: "invalid", path, line: 1 }] : []
		let tail = decision.mode === "clean-append" ? coverageProblems(backend, path, TAIL_NOTES) : []
		// Problems already saved are re-read, not re-reported; the note still records them.
		const report = (problem: WorkRecordProblem, bucket: WorkRecordProblem[]) => {
			const positioned = { ...problem, line: problem.line + lineOffset }
			bucket.push(positioned)
			if (!known.has(JSON.stringify(positioned))) {
				result.problems.push(positioned)
				onProblem?.(positioned)
			}
		}
		const parser = journalParser(
			path,
			parsed,
			(problem) => report(problem, problems),
			(problem) => report(problem, tail),
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
		const endReached = consumedEnd >= size
		checkBudget?.()
		prefix.update(data.subarray(0, consumed))
		const hash = prefix.copy()
		const boundaryHash = prefix.digest("hex")
		let imported = 0
		backend.tx(() => {
			// A read from the start, or a continuing re-verification, that reached the end without a
			// problem retires problems saved against older content; every other window keeps the
			// clean marker fresh as before.
			if (!problems.length && savedProblems.length > 0 && endReached && (decision.offset === 0 || reverifying))
				putProblems(backend, path, COVERAGE_NOTES, [])
			else saveCoverage(backend, path, problems)
			putProblems(backend, path, TAIL_NOTES, tail)
			// Progress of the from-start re-verification persists across windows and passes. Damage
			// found along the way ends it: the note then describes the current file again.
			if (savedProblems.length > 0 && (recheck || reverifying)) {
				if (!endReached && !problems.length) saveReverify(backend, path, consumedEnd, boundaryHash)
				else clearReverify(backend, path)
			} else if (reverify !== undefined && !recheck && !reverifying) clearReverify(backend, path)
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
		// The memo survives a completed append now: the running hash, line count and stat identity
		// let the next append's preflight (and any later stat-identical window) skip the re-read.
		rememberContinued(path, {
			dev,
			ino,
			size,
			offset: consumedEnd,
			mtimeMs,
			ctimeMs,
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
		// A finished pass is not pending: the clock can expire with journals left in the
		// list that are already consumed (an untouched journal costs a stat and skips before
		// this point), so ask whether any unvisited journal still has unread bytes instead of
		// assuming it does. A loaded machine reaches this with small journals routinely.
		if (until !== undefined && Date.now() >= until) {
			if (ordered.slice(journalIndex + 1).some((remaining) => hasUnreadJournalBytes(backend, remaining))) {
				result.pending = true
				stopped.set(agentDir, path)
			}
			break
		}
	}
	if (sweep) sweepRemovedJournals(agentDir, journals, backend, result, checkBudget)
	return result
}

function sweepRemovedJournals(
	agentDir: string,
	listedJournals: readonly string[],
	backend: RecordBackend,
	result: ImportResult,
	checkBudget?: () => void,
): void {
	const listed = new Set(listedJournals)
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
}

/**
 * Whether a journal this pass has not reached yet still holds unread bytes. Used at the slice
 * deadline to tell "more work is left" from "the clock ran out after the work was done": an
 * untouched journal costs one stat, which only happens on the budget-exhausted path.
 */
function hasUnreadJournalBytes(backend: RecordBackend, path: string): boolean {
	const cursor = backend.getJournalCursor(path)
	if (!cursor) return true
	try {
		return statSync(path).size > cursor.offset
	} catch {
		// A vanished journal needs a sweep pass to forget it, so treat it as outstanding work.
		return true
	}
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
		backend.deleteNote(REVERIFY_NOTES, path)
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
	/** Only background capture verifies the old prefix cooperatively before its synchronous slice
	 * may reuse a process-local running hash; strict readers keep verifying inline. */
	verifyCapturePrefix?: boolean
}

/** How long one import slice may hold the event loop before yielding. */
export const IMPORT_SLICE_MS = 50

export async function importJournals(agentDir: string, options: ImportOptions = {}): Promise<ImportResult> {
	const journals = await workJournals(agentDir)
	if (!options.verifyCapturePrefix) return importJournalFiles(agentDir, journals, options, true)
	const backend = backendFor(agentDir)
	const result: ImportResult = { files: [], anomalies: [], problems: [], imported: 0, skipped: 0 }
	const start = options.until === undefined ? 0 : Math.max(0, journals.indexOf(stopped.get(agentDir) ?? ""))
	const ordered = [...journals.slice(start), ...journals.slice(0, start)]
	for (const path of ordered) {
		options.checkBudget?.()
		const cursor = backend.getJournalCursor(path)
		if (cursor)
			try {
				await verifyCapturePrefix(path, cursor, replayDecision(backend, path, cursor), options.checkBudget)
			} catch (error) {
				if (!object(error) || error.code !== "ENOENT") throw error
			}
		// Verify only what this import consumes. Checking every retained prefix up front can evict
		// an unprocessed memo even when all of those files need verification before the next slice.
		const slice = importJournalFiles(agentDir, [path], options, false)
		result.files.push(...slice.files)
		result.anomalies.push(...slice.anomalies)
		result.problems.push(...slice.problems)
		result.imported += slice.imported
		result.skipped += slice.skipped
		const expired = options.until !== undefined && Date.now() >= options.until
		if (slice.pending || (expired && slice.files.length > 0)) {
			result.pending = true
			stopped.set(agentDir, path)
			break
		}
	}
	for (const file of result.files) {
		options.checkBudget?.()
		const cursor = backend.getJournalCursor(file.path)
		if (cursor && file.mode !== "mutation")
			try {
				await verifyCapturePrefix(file.path, cursor, false, options.checkBudget)
			} catch (error) {
				if (!object(error) || error.code !== "ENOENT") throw error
			}
	}
	sweepRemovedJournals(agentDir, journals, backend, result, options.checkBudget)
	return result
}

/** One synchronous slice over every journal; true while more input remains for a later slice. */
export function importJournalSlice(agentDir: string, checkBudget?: () => void): boolean {
	const options = { checkBudget, until: Date.now() + IMPORT_SLICE_MS }
	return importJournalFiles(agentDir, syncWorkJournals(agentDir), options, true).pending === true
}

/**
 * Cheap change probe for pass gates: one line per journal carrying the identity
 * prepareJournal uses to decide a file needs work (path list + dev/ino + size + mtime), without
 * opening or hashing anything. A tick matching the last pass's probe line-for-line has no new
 * legacy input to import; any append, rewrite, deletion, or creation differs.
 */
export function legacyInputSignature(agentDir: string): string {
	const parts: string[] = []
	for (const path of syncWorkJournals(agentDir)) {
		try {
			const info = statSync(path)
			// ctime rides along with mtime: a same-size rewrite that restores its old mtime still
			// moves ctime, and the gate must re-open for it instead of sleeping through the rewrite.
			parts.push(`${path}:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`)
		} catch (error) {
			if (!object(error) || error.code !== "ENOENT") throw error
			parts.push(`${path}:gone`)
		}
	}
	return parts.join("\n")
}

/** One session's journal in full, so a resumed legacy session keeps its work before the background import arrives. */
export function importSessionJournal(agentDir: string, path: string): void {
	for (;;) if (!importJournalFiles(agentDir, [path], {}, false).pending) return
}
