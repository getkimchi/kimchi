/**
 * Sub-agent transcript enrichment for session exports.
 *
 * During a session, sub-agent full transcripts are streamed to separate
 * `.output` JSONL files (by the agents extension). Only a summary record
 * (`subagents:record` custom entry) is persisted in the parent session.
 *
 * This module enriches those summary records during export post-processing
 * by reading the `.output` file and attaching the full transcript as
 * `data.transcript`. Local file paths (`outputFile`, `sessionFile`) are
 * stripped from the export for safety.
 *
 * Transcripts are redacted by the caller (via `redactDeep`) — this module
 * only handles reading and attaching. The transcript is left unredacted
 * here so that the caller can run a single redaction pass over the entire
 * enriched entries array.
 */

import { existsSync, readFileSync } from "node:fs"

/** A single line from a sub-agent `.output` transcript file. */
export interface TranscriptEntry {
	isSidechain: true
	agentId: string
	type: "user" | "assistant" | "toolResult"
	message: unknown
	timestamp: string
	cwd: string
}

/** Shape of the `data` field on a `subagents:record` custom entry. */
export interface SubAgentRecordData {
	id: string
	type: string
	description?: string
	visibility?: string
	status: string
	abortReason?: string
	result?: string
	error?: string
	startedAt?: number
	completedAt?: number
	/** Path to the streaming output transcript file. Added by export enrichment. */
	outputFile?: string
	/** Persisted session file for this agent run. Added by export enrichment. */
	sessionFile?: string
	/** Full transcript — attached during export enrichment. */
	transcript?: TranscriptEntry[]
}

/** Shape of a `subagents:record` custom entry in the session. */
export interface SubAgentRecordEntry {
	type: "custom"
	customType: "subagents:record"
	data: SubAgentRecordData
	[key: string]: unknown
}

/**
 * Read and parse a sub-agent `.output` transcript file.
 *
 * The file is JSONL with `{ isSidechain: true, agentId, type, message, timestamp, cwd }` entries.
 * Returns an empty array if the file doesn't exist or is unreadable.
 */
export function readTranscript(filePath: string): TranscriptEntry[] {
	if (!existsSync(filePath)) return []

	try {
		const raw = readFileSync(filePath, "utf-8")
		const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0)
		const entries: TranscriptEntry[] = []

		for (const line of lines) {
			try {
				const parsed = JSON.parse(line) as TranscriptEntry
				if (parsed && typeof parsed === "object" && parsed.isSidechain === true) {
					entries.push(parsed)
				}
			} catch {
				// Skip malformed lines
			}
		}

		return entries
	} catch {
		return []
	}
}

/**
 * Enrich `subagents:record` custom entries with full transcripts.
 *
 * For each sub-agent record that has an `outputFile` path:
 * 1. Reads the `.output` JSONL transcript file
 * 2. Attaches the parsed transcript as `data.transcript`
 * 3. Strips local file paths (`outputFile`, `sessionFile`) from the export
 *
 * Entries without `outputFile` or with missing files are left unchanged
 * (minus the stripped paths if present).
 *
 * This function mutates entries in-place.
 */
export function enrichSubAgentEntries<T extends Record<string, unknown>>(entries: T[]): T[] {
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== "subagents:record") {
			continue
		}

		const data = entry.data as SubAgentRecordData | undefined
		if (!data) continue

		// Read and attach transcript if outputFile exists
		if (data.outputFile) {
			const transcript = readTranscript(data.outputFile)
			if (transcript.length > 0) {
				data.transcript = transcript
			}
		}

		// Strip local file paths from the export — they contain absolute
		// paths to the user's session directory and should not leak.
		data.outputFile = undefined
		data.sessionFile = undefined
	}

	return entries
}
