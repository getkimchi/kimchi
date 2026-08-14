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
 * Transcripts are redacted by the caller (`redactJsonlExport` /
 * `redactHtmlExport`) — this module only handles reading and attaching.
 * The transcript is left unredacted here so the caller can run a single
 * redaction pass over the enriched export payload.
 */

import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { getAgentConfig } from "../extensions/agents/personas/agent-types.js"
import { DEFAULT_AGENTS } from "../extensions/agents/personas/default-agents.js"

/**
 * Validate that a transcript file path is safe to read.
 *
 * Rejects paths containing `..` or, when a base directory is supplied,
 * paths that resolve outside that directory. This prevents a tampered
 * session entry from reading arbitrary files during export.
 */
function isSafeOutputFile(outputFile: string, baseDir?: string): boolean {
	if (outputFile.includes("..")) return false
	if (typeof baseDir !== "string" || baseDir.length === 0) return true

	const resolvedFile = resolve(outputFile)
	const resolvedBase = resolve(baseDir)
	const separator = resolvedBase.endsWith("/") || resolvedBase.endsWith("\\") ? "" : "/"
	return resolvedFile === resolvedBase || resolvedFile.startsWith(`${resolvedBase}${separator}`)
}

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
	/** The system prompt used for this agent run. */
	systemPrompt?: string
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

/** A sub-agent summary suitable for tab display. */
export interface SubAgentTab {
	/** Unique tab id (the sub-agent record id). */
	id: string
	/** Display label, e.g. "Reviewer". */
	label: string
	/** Tab subtitle, e.g. "completed (109s)". */
	subtitle: string
	/** Base64-encoded session-data JSON for the iframe. */
	sessionDataB64: string
}

/**
 * Read and parse a sub-agent `.output` transcript file.
 *
 * The file is JSONL with `{ isSidechain: true, agentId, type, message, timestamp, cwd }` entries.
 * Returns an empty array if the file doesn't exist or is unreadable.
 */
export function readTranscript(filePath: string, baseDir?: string): TranscriptEntry[] {
	if (!isSafeOutputFile(filePath, baseDir)) return []
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
 * Build a session-data object from a sub-agent transcript.
 *
 * Converts the flat transcript lines into proper `{ type: "message", id, parentId, timestamp, message }`
 * entries that the upstream HTML export template renders natively. The
 * transcript messages already contain `role`, `content`, `toolCallId`, etc.
 * in the correct format — we just wrap them as session entries.
 *
 * The resulting object has the same `{ header, entries }` shape as the main
 * session-data, so it can be rendered by the exact same template in an iframe.
 */
export function buildSubAgentSessionData(data: SubAgentRecordData): {
	header: Record<string, unknown>
	entries: Record<string, unknown>[]
	systemPrompt?: string
} {
	const entries: Record<string, unknown>[] = []
	const agentId = data.id || "unknown"
	let prevId: string | null = null

	// Resolve the system prompt from the persisted record or the persona config.
	// Pass it as a top-level field so the upstream HTML export template renders
	// it in the same violet "System Prompt" box used for the main session.
	const systemPrompt =
		data.systemPrompt ?? getAgentConfig(data.type)?.systemPrompt ?? DEFAULT_AGENTS.get(data.type)?.systemPrompt

	for (let i = 0; i < (data.transcript ?? []).length; i++) {
		const t = data.transcript?.[i]
		if (!t) continue
		const entryId = `sa:${agentId}:${i}`
		const ts = t.timestamp || new Date(data.startedAt || Date.now()).toISOString()

		entries.push({
			type: "message",
			id: entryId,
			parentId: prevId,
			timestamp: ts,
			message: t.message,
		})
		prevId = entryId
	}

	const result: {
		header: Record<string, unknown>
		entries: Record<string, unknown>[]
		systemPrompt?: string
	} = {
		header: {
			type: "session",
			version: 3,
			id: agentId,
			timestamp: data.startedAt ? new Date(data.startedAt).toISOString() : new Date().toISOString(),
			cwd: data.transcript?.[0]?.cwd ?? "",
		},
		entries,
	}
	if (systemPrompt) {
		result.systemPrompt = systemPrompt
	}
	return result
}

/**
 * Collect sub-agent tabs from enriched entries.
 *
 * Returns one `SubAgentTab` per `subagents:record` entry that has a
 * non-empty transcript. The `sessionDataB64` field contains the
 * base64-encoded session-data JSON ready for iframe embedding.
 */
export function collectSubAgentTabs(entries: Record<string, unknown>[]): SubAgentTab[] {
	const tabs: SubAgentTab[] = []

	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== "subagents:record") continue

		const data = entry.data as SubAgentRecordData | undefined
		if (!data?.transcript || data.transcript.length === 0) continue

		const duration =
			data.startedAt && data.completedAt ? `${Math.round((data.completedAt - data.startedAt) / 1000)}s` : ""

		const sessionData = buildSubAgentSessionData(data)
		const sessionDataB64 = Buffer.from(JSON.stringify(sessionData), "utf-8").toString("base64")

		tabs.push({
			id: data.id || "unknown",
			label: data.type || "Agent",
			subtitle: `${data.status || "unknown"}${duration ? ` · ${duration}` : ""}`,
			sessionDataB64,
		})
	}

	return tabs
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
export function enrichSubAgentEntries<T extends Record<string, unknown>>(entries: T[], baseDir?: string): T[] {
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== "subagents:record") {
			continue
		}

		const data = entry.data as SubAgentRecordData | undefined
		if (!data) continue

		// Read and attach transcript if outputFile exists and is a safe path.
		if (data.outputFile && isSafeOutputFile(data.outputFile, baseDir)) {
			const transcript = readTranscript(data.outputFile, baseDir)
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
