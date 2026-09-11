/**
 * Session recovery — transcript gap marker for remote agent runs.
 *
 * The remote agent's RESULT is recovered at the protocol level by the runner
 * (session/load replay → the final assistant message; see recoverTextViaReplay
 * in remote-agent-runner). This module retains only the local-transcript gap
 * marker: an honest note appended to the output file when a disconnect window
 * interrupted local streaming, so a reader of the transcript knows why entries
 * are missing and where the result came from.
 *
 * The former rsync-based fetch of the remote session.jsonl is gone: the remote
 * kimchi writes that file where the worker expects only when its --session arg
 * is honored, which deployed remotes don't — the download could never succeed
 * and only added a doomed ssh round-trip and confusing error markers.
 */

import { appendFile, readFile } from "node:fs/promises"

/**
 * Appends a transcript-gap marker entry to the local output file.
 *
 * Written in the local output-file schema (an assistant-type entry), with the
 * agent id and cwd derived from the file's existing entries when available so
 * consumers parsing the transcript can attribute it to the agent.
 */
export async function appendTranscriptGapMarker(outputFile: string, note: string): Promise<void> {
	let agentId = ""
	let cwd = ""
	try {
		const raw = await readFile(outputFile, "utf-8")
		for (const line of raw.split("\n").reverse()) {
			const trimmed = line.trim()
			if (!trimmed.startsWith("{")) continue
			try {
				const entry = JSON.parse(trimmed) as { agentId?: string; cwd?: string }
				if (typeof entry.agentId === "string") agentId = entry.agentId
				if (typeof entry.cwd === "string") cwd = entry.cwd
				if (agentId) break
			} catch {
				// Skip unparseable lines.
			}
		}
	} catch {
		// No readable local entries — fall back to empty identity fields.
	}
	const marker = {
		isSidechain: true,
		agentId,
		type: "assistant",
		message: {
			role: "assistant",
			content: [{ type: "text", text: `[Transcript gap: ${note}]` }],
		},
		timestamp: new Date().toISOString(),
		cwd,
	}
	await appendFile(outputFile, `\n${JSON.stringify(marker)}\n`, { mode: 0o600 })
}
