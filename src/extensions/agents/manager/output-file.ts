/**
 * output-file.ts — Streaming JSONL output file for agent transcripts.
 *
 * Creates a per-agent output file that streams conversation turns as JSONL,
 * matching Claude Code's task output file format.
 */

import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent"

/**
 * Encode a cwd path as a filesystem-safe directory name.
 */
export function encodeCwd(cwd: string): string {
	return cwd
		.replace(/[/\\]/g, "-")
		.replace(/^[A-Za-z]:-/, "")
		.replace(/^-+/, "")
}

/** Create the output file path, ensuring the directory exists. */
export function createOutputFilePath(cwd: string, agentId: string, sessionId: string, rootDir?: string): string {
	const encoded = encodeCwd(cwd)
	const hasPersistedRoot = rootDir !== undefined && rootDir.length > 0
	const root = hasPersistedRoot ? rootDir : join(tmpdir(), `kimchi-agents-${process.getuid?.() ?? 0}`)
	mkdirSync(root, { recursive: true, mode: 0o700 })
	if (!hasPersistedRoot) {
		try {
			chmodSync(root, 0o700)
		} catch (err) {
			if (process.platform !== "win32") throw err
		}
	}
	const dir = hasPersistedRoot
		? join(root, "agent-outputs", sessionId, "tasks")
		: join(root, encoded, sessionId, "tasks")
	mkdirSync(dir, { recursive: true })
	return join(dir, `${agentId}.output`)
}

/** Write the initial user prompt entry. */
export function writeInitialEntry(path: string, agentId: string, prompt: string, cwd: string): void {
	const entry = {
		isSidechain: true,
		agentId,
		type: "user",
		message: { role: "user", content: prompt },
		timestamp: new Date().toISOString(),
		cwd,
	}
	writeFileSync(path, `${JSON.stringify(entry)}\n`, "utf-8")
}

/**
 * Subscribe to session events and flush new messages to the output file on each turn_end.
 * Returns a cleanup function that does a final flush and unsubscribes.
 */
export function streamToOutputFile(session: AgentSession, path: string, agentId: string, cwd: string): () => void {
	let writtenCount = 1 // initial user prompt already written

	const flush = () => {
		const messages = session.messages
		while (writtenCount < messages.length) {
			const msg = messages[writtenCount]
			const entry = {
				isSidechain: true,
				agentId,
				type: msg.role === "assistant" ? "assistant" : msg.role === "user" ? "user" : "toolResult",
				message: msg,
				timestamp: new Date().toISOString(),
				cwd,
			}
			try {
				appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf-8")
			} catch {
				/* ignore write errors */
			}
			writtenCount++
		}
	}

	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		if (event.type === "turn_end") flush()
	})

	return () => {
		flush()
		unsubscribe()
	}
}
