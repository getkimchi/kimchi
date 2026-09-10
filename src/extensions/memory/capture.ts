/**
 * Capture wiring: turns session content into capture jobs and spawns the
 * detached capture worker. Capture never blocks or breaks the session —
 * job files are written atomically (small JSON) and the worker is
 * fire-and-forget (detached, unref'd).
 *
 * Two capture points: session_before_compact (the compacted-away span —
 * the leak point where session knowledge gets summarized) and
 * session_shutdown (the full session). The worker dedupes by message
 * hash, so overlapping captures are cheap no-ops.
 */
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdirSync, renameSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent"
import type { CaptureMessage } from "./capture-worker.js"
import { digestDbPath } from "./config.js"

export function wireMemoryCapture(pi: ExtensionAPI): void {
	pi.on("session_before_compact", (event) => {
		captureMessages(extractMessages(event.branchEntries))
	})
	pi.on("session_shutdown", (_event, ctx) => {
		captureMessages(extractMessages(ctx.sessionManager.getEntries()))
	})
}

export function extractMessages(entries: readonly SessionEntry[]): CaptureMessage[] {
	const messages: CaptureMessage[] = []
	for (const entry of entries) {
		if (entry.type !== "message") continue
		const message = entry.message
		if (message.role !== "user" && message.role !== "assistant") continue
		const content = messageText(message.content)
		if (content.trim()) messages.push({ role: message.role, content })
	}
	return messages
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content
	if (Array.isArray(content)) {
		return content.map((part) => (typeof part === "string" ? part : ((part as { text?: string }).text ?? ""))).join("")
	}
	return ""
}

function captureMessages(messages: CaptureMessage[]): void {
	if (messages.length === 0) return
	try {
		const dbPath = digestDbPath()
		const pendingDir = join(dirname(dbPath), "pending")
		mkdirSync(pendingDir, { recursive: true })
		// Deterministic job id: re-spawning for identical content overwrites
		// the same job file instead of queueing duplicates.
		const id = createHash("sha1").update(JSON.stringify({ messages })).digest("hex").slice(0, 16)
		const jobFile = join(pendingDir, `${id}.json`)
		const tmp = `${jobFile}.${process.pid}.tmp`
		writeFileSync(tmp, JSON.stringify({ messages }))
		renameSync(tmp, jobFile)
		spawnCaptureWorker(jobFile, dbPath)
	} catch (err) {
		console.error("[memory] capture scheduling failed:", err instanceof Error ? err.message : err)
	}
}

function spawnCaptureWorker(jobFile: string, dbPath: string): void {
	const args = ["--job", jobFile, "--db", dbPath]
	let cmd: string[]
	if (basename(process.execPath) === "bun") {
		// Dev (`bun run`): execute the worker script directly.
		cmd = [process.execPath, fileURLToPath(new URL("./capture-worker.ts", import.meta.url)), ...args]
	} else {
		// Compiled binary: process.execPath is the kimchi binary itself; the
		// worker is routed as the memory-capture subcommand (cli.ts).
		cmd = [process.execPath, "memory-capture", ...args]
	}
	const child = spawn(cmd[0], cmd.slice(1), { detached: true, stdio: "ignore" })
	child.unref()
}
