import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { isWorkId } from "../../shared/work-id.js"
import {
	hydrateLegacy,
	hydrateLegacyOnce,
	importJournals,
	reportJournalProblems,
} from "../pr-cost-reporting/ledger/import.js"
import {
	readRecords as ledgerReadRecords,
	readRecordsAsync as ledgerReadRecordsAsync,
	fingerprint as recordsFingerprint,
	recoverDirty,
} from "../pr-cost-reporting/ledger/records.js"
import { debugWorkAttribution } from "./diagnostics.js"

export { fileMatchStrength } from "../pr-cost-reporting/ledger/merge.js"

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
	"tool_execution",
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
 * newer Kimchi sharing this history. The C3 importer reports both; DB reads are already validated at capture.
 */
export type WorkRecordProblem =
	| { kind: "invalid"; path: string; line: number }
	| { kind: "unknown-type"; path: string; line: number; record: Record<string, unknown> }
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
		case "tool_execution":
			return entry(value, ["requestId", "toolCallId", "toolName", "outcome"])
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
/** An interrupted append leaves a record cut off mid-value; any other unparseable line is damage. */
function truncated(line: string): boolean {
	const closing: string[] = []
	let inString = false
	// Where an escape sequence such as \n or  began, and how many  hex digits it still needs.
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
 * Used by the C3 legacy importer only: the record store replaces journal reads for everything else.
 */
export function journalParser(
	path: string,
	records: WorkRecord[],
	onRecordProblem?: (problem: WorkRecordProblem) => void,
	onTruncatedTail: ((problem: WorkRecordProblem) => void) | undefined = onRecordProblem,
) {
	let line = 0
	let cut: number[] = []
	return (text: string, final: boolean): void => {
		line++
		if (!text.trim()) {
			if (final) for (const number of cut) onTruncatedTail?.({ kind: "invalid", path, line: number })
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
/** The legacy journals the C3 importer scans, session ledgers and transitions, in a stable order. */
export async function workJournals(agentDir: string): Promise<string[]> {
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
 * The authority records, oldest first. Journals are hydrated into the store before history-dependent reads
 * (fire-hose A2); only the C3 importer still parses files.
 */
export function readWorkRecords(
	agentDir: string,
	modifiedSince?: number,
	checkBudget?: () => void,
	onRecordProblem?: (problem: WorkRecordProblem) => void,
): WorkRecord[] {
	if (onRecordProblem || checkBudget) {
		// Strict history readers must see current local coverage, including damage consumed by another reader.
		// A failed scan or exhausted budget cannot silently authorize work from incomplete history.
		hydrateLegacy(agentDir, { checkBudget })
		if (onRecordProblem) reportJournalProblems(agentDir, onRecordProblem, checkBudget)
	} else {
		try {
			hydrateLegacyOnce(agentDir)
		} catch (error) {
			debugWorkAttribution("Legacy hydration unavailable:", error)
		}
	}
	return ledgerReadRecords(agentDir, { modifiedSince }, checkBudget)
}
/** Like readWorkRecords, but yields between bounded imports and honors shutdown between each committed batch. */
export async function readWorkRecordsAsync(
	agentDir: string,
	signal: AbortSignal,
	onRecordProblem?: (problem: WorkRecordProblem) => void,
): Promise<WorkRecord[]> {
	const checkBudget = () => signal.throwIfAborted()
	await importWorkRecordsAsync(agentDir, checkBudget, onRecordProblem)
	return ledgerReadRecordsAsync(agentDir, checkBudget)
}

/** Import once before reading an authority prefix with its original hashes or parsed work records. */
export async function importWorkRecordsAsync(
	agentDir: string,
	checkBudget: () => void,
	onRecordProblem?: (problem: WorkRecordProblem) => void,
): Promise<void> {
	checkBudget()
	for (;;) {
		await setImmediate()
		checkBudget()
		const imported = await importJournals(agentDir, { checkBudget })
		if (!imported.pending) break
	}
	if (onRecordProblem) reportJournalProblems(agentDir, onRecordProblem, checkBudget)
}
/** Notice old-process appends and rewrites without reading journal bodies on idle passes. */
export async function workJournalFingerprint(agentDir: string, checkBudget?: () => void): Promise<string> {
	checkBudget?.()
	const paths = (await workJournals(agentDir)).sort()
	checkBudget?.()
	const files: string[][] = []
	for (const path of paths) {
		checkBudget?.()
		const value = await stat(path, { bigint: true })
		checkBudget?.()
		files.push([
			path,
			String(value.dev),
			String(value.ino),
			String(value.size),
			String(value.mtimeNs),
			String(value.ctimeNs),
		])
	}
	const fingerprint = JSON.stringify([recordsFingerprint(agentDir), files])
	checkBudget?.()
	return fingerprint
}
/** Projections commit with their records; recovery just folds stranded intents from an interrupted import. */
export function recoverWorkSummaries(): void {
	try {
		hydrateLegacyOnce(getAgentDir())
		recoverDirty(getAgentDir())
	} catch (error) {
		debugWorkAttribution("Work summary recovery unavailable:", error)
	}
}
/** Writes are synchronous now; this remains only so callers draining the old async queue still compile. */
export async function flushWorkSummaries(): Promise<void> {}
