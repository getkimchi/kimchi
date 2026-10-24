import { createHash } from "node:crypto"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { journalParser, workJournals, type WorkRecord, type WorkRecordProblem } from "../../work-attribution/summary.js"
import { backendFor, diagnostic, importBatchInTx, type ImportEntry, type JournalCursor } from "./records.js"

/**
 * C3 — incremental, immutable legacy import.
 *
 * Each reconcile pass re-scans the legacy journals (`work-attribution/*.jsonl` + `transitions/*.jsonl`) and folds
 * their records into `work_records` with provenance (`source_path`, `generation`, `offset`). Rows are deduped by
 * `record_hash` = sha256 of the exact journal line and are NEVER deleted by a file anomaly — a changed or missing
 * file only records coverage (`journal-mutation` / `journal-removed`) and bumps the generation. Rows, the derived
 * projection, translation markers and the cursor advance all commit in one transaction per file-batch.
 */

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
	/** Files touched this pass, journal order. */
	files: { path: string; mode: JournalMode; generation: number; imported: number; skipped: number }[]
	anomalies: JournalAnomaly[]
	problems: WorkRecordProblem[]
	imported: number
	skipped: number
}

const EMPTY_HASH = createHash("sha256").digest("hex")

/** sha256 of the consumed prefix [0, offset); the identity proof for clean-append detection. */
export function boundaryHashOf(file: Buffer, offset: number): string {
	if (offset <= 0) return EMPTY_HASH
	return createHash("sha256").update(file.subarray(0, offset)).digest("hex")
}

/**
 * Pure cursor decision — exercised directly in vitest.
 * - no cursor → fresh import from offset 0, generation 1
 * - same inode, size > cursor.offset, consumed prefix unchanged → clean append from cursor.offset
 * - anything else (replaced, shrunk, ino change, same-size content change, prefix rewritten) → mutation:
 *   generation++, offset 0, re-import the whole file; identical lines are no-ops via record_hash
 */
export function journalDecision(
	cursor: JournalCursor | undefined,
	dev: number,
	ino: number,
	size: number,
	file: Buffer,
): JournalDecision {
	if (!cursor) return { mode: "fresh", generation: 1, offset: 0 }
	// Same inode, consumed prefix unchanged, and no bytes were lost (size >= cursor.offset): keep
	// appending from the cursor. A fully-consumed unchanged file (size == cursor.offset) is a
	// clean no-op. Anything else (replaced, shrunk, ino change, same-size content change, prefix
	// rewritten) is a mutation: generation++, offset 0, re-import the whole file; identical lines
	// are no-ops via record_hash.
	if (cursor.dev === dev && cursor.ino === ino && size >= cursor.offset && boundaryHashOf(file, cursor.offset) === cursor.boundaryHash)
		return { mode: "clean-append", generation: cursor.generation, offset: cursor.offset }
	return { mode: "mutation", generation: cursor.generation + 1, offset: 0 }
}

/** One complete journal line's byte range (start inclusive, end exclusive after the LF). */
interface Line {
	start: number
	end: number
	text: string
}

/**
 * Splits the byte range [from, to) into complete lines; a trailing segment without a final LF is left out —
 * that unterminated tail is not consumed and is retried on the next pass.
 */
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

/**
 * One import pass: scans `work-attribution/*.jsonl` + `transitions/*.jsonl`, importing at most `maxBytes` of NEW
 * content per file (bounded batch) so a first import of a long history stays within the pass budget. Re-imports
 * over unchanged journals insert nothing; each file-batch commits rows + projection + translation markers +
 * cursor advance in one transaction, so a kill mid-pass resumes exactly at the cursor.
 */
/** Sync mirror of `workJournals` for the read-path hydration. */
function syncWorkJournals(agentDir: string): string[] {
	const paths: string[] = []
	for (const source of [join(agentDir, "work-attribution"), join(agentDir, "work-attribution", "transitions")]) {
		try {
			for (const file of readdirSync(source, { withFileTypes: true }))
				if (file.isFile() && file.name.endsWith(".jsonl")) paths.push(join(source, file.name))
		} catch (error) {
			const code = (error as { code?: string } | undefined)?.code
			if (code !== "ENOENT") throw error
		}
	}
	return paths
}

/** Shared pass body: imports exactly the given journals, then reports files removed since the last pass. */
function importJournalFiles(
	agentDir: string,
	journals: string[],
	maxBytes: number,
	onProblem: ((problem: WorkRecordProblem) => void) | undefined,
): ImportResult {
	const result: ImportResult = { files: [], anomalies: [], problems: [], imported: 0, skipped: 0 }
	for (const path of journals) {
		const backend = backendFor(agentDir)
		const cursor = backend.getJournalCursor(path)
		let size: number
		let dev: number
		let ino: number
		try {
			const stat = statSync(path)
			dev = stat.dev
			ino = stat.ino
			size = stat.size
		} catch (error) {
			if ((error as { code?: string }).code === "ENOENT") {
				// File removed: imported rows stay; nothing is withdrawn.
				if (cursor) {
					result.anomalies.push({ path, code: "journal-removed" })
					diagnostic(agentDir, "journal-removed")
				}
				continue
			}
			throw error
		}
		const file = readFileSync(path)
		const decision = journalDecision(cursor, dev, ino, size, file)
		if (decision.mode === "mutation") result.anomalies.push({ path, code: "journal-mutation" })

		// Bounded batch: only the next `maxBytes` of new content is parsed this pass. A single record may be
		// larger than the window; extend the window to its terminating LF so a valid journal never stalls.
		let to = Math.min(size, decision.offset + maxBytes)
		let lines = completeLines(file, decision.offset, to)
		if (!lines.length && to < size) {
			const nextLf = file.indexOf(0x0a, to)
			if (nextLf !== -1) {
				to = nextLf + 1
				lines = completeLines(file, decision.offset, to)
			}
		}
		if (!lines.length) {
			if (decision.mode === "mutation") diagnostic(agentDir, "journal-mutation")
			// Nothing consumed yet (empty file, or the whole range is an unterminated tail): keep the cursor.
			if (decision.offset < size)
				result.files.push({ path, mode: decision.mode, generation: decision.generation, imported: 0, skipped: 0 })
			continue
		}

		// Parse through the same taxonomy as the old journal reader: invalid lines and unknown types surface as
		// coverage problems; only validated records are imported.
		const parsed: WorkRecord[] = []
		const entries: ImportEntry[] = []
		const parser = journalParser(path, parsed, (problem) => {
			result.problems.push(problem)
			onProblem?.(problem)
		})
		for (const line of lines) {
			const before = parsed.length
			// completeLines yields only LF-terminated complete lines; an unfinished tail is never consumed.
			// Distinguish the two: an LF-terminated malformed final line is damage and must be reported.
			parser(line.text, false)
			if (parsed.length > before)
				entries.push({
					line: line.text,
					record: parsed[before],
					sourcePath: path,
					sourceGeneration: decision.generation,
					sourceOffset: line.start,
				})
		}

		// One transaction per file-batch: rows + translation intent + projection + cursor advance. The cursor
		// advances past consumed complete lines even when none validated, so damage is reported once, not per pass.
		let imported = 0
		let skipped = 0
		const consumedEnd = lines[lines.length - 1].end
		backend.tx(() => {
			if (entries.length) {
				imported = importBatchInTx(backend, entries)
				skipped = entries.length - imported
			}
			backend.putJournalCursor({
				path,
				dev,
				ino,
				generation: decision.generation,
				offset: consumedEnd,
				boundaryHash: boundaryHashOf(file, consumedEnd),
				updatedAt: Date.now(),
			})
		})
		if (decision.mode === "mutation") diagnostic(agentDir, "journal-mutation")
		result.imported += imported
		result.skipped += skipped
		result.files.push({ path, mode: decision.mode, generation: decision.generation, imported, skipped })
	}

	// A journal imported in an earlier pass may have vanished entirely (gone from the listing), so
	// the ENOENT branch above never sees it: report it from the cursor table. Rows stay, nothing is withdrawn.
	for (const cursor of backendFor(agentDir).listJournalCursors()) {
		if (journals.includes(cursor.path)) continue
		try {
			statSync(cursor.path)
		} catch (error) {
			if ((error as { code?: string }).code !== "ENOENT") throw error
			result.anomalies.push({ path: cursor.path, code: "journal-removed" })
			diagnostic(agentDir, "journal-removed")
		}
	}
	return result
}

export async function importJournals(
	agentDir: string,
	options: { maxBytes?: number; onRecordProblem?: (problem: WorkRecordProblem) => void } = {},
): Promise<ImportResult> {
	return importJournalFiles(agentDir, await workJournals(agentDir), options.maxBytes ?? 512 * 1024, options.onRecordProblem)
}

/**
 * A2 — fire-hose hydration for the history-dependent read path. Drains every legacy journal into the store
 * BEFORE the read, synchronously (same enumeration as `workJournals`), consent/network-independent. Rows are
 * immutable and the cursor is authoritative, so later worker passes and repeated calls are no-ops.
 */
export function hydrateLegacy(
	agentDir: string,
	options: { maxBytes?: number; onRecordProblem?: (problem: WorkRecordProblem) => void } = {},
): ImportResult {
	return importJournalFiles(agentDir, syncWorkJournals(agentDir), options.maxBytes ?? Number.POSITIVE_INFINITY, options.onRecordProblem)
}

const hydratedDirs = new Set<string>()

/**
 * A2 — read-path hydration: folds every legacy journal into the store once per agent dir per process, so the
 * first history-dependent read sees an old install's history. The bounded C3 worker pass keeps importing
 * incrementally after this; a failed pass is retried on the next read (the dir is only marked done on success).
 */
export function hydrateLegacyOnce(agentDir: string): void {
	if (hydratedDirs.has(agentDir)) return
	hydrateLegacy(agentDir)
	hydratedDirs.add(agentDir)
}

/** `.jsonl` path relative to the agent dir, for import addressing in status/tests. */
export function journalPath(agentDir: string, name: string): string {
	return join(agentDir, "work-attribution", name)
}