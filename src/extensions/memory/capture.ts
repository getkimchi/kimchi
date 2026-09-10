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
import { digestDbPath, MEMORY_CAPTURE_INCREMENTAL_MESSAGES } from "./config.js"

export function wireMemoryCapture(pi: ExtensionAPI): void {
	pi.on("session_before_compact", (event) => {
		captureMessages(extractMessages(event.branchEntries))
	})
	pi.on("session_shutdown", (_event, ctx) => {
		captureMessages(extractMessages(ctx.sessionManager.getEntries()))
	})
}

/**
 * Extension-side mark for incremental capture: how many user messages the
 * current runtime has already spawned capture jobs for. Batches are
 * non-overlapping by construction (slices past the mark); the worker's hash
 * ledger dedupes across restarts and prior sessions.
 */
export interface IncrementalCaptureState {
	spawnedCount: number
}

export function createIncrementalCaptureState(): IncrementalCaptureState {
	return { spawnedCount: 0 }
}

/**
 * Lever 3: drain new user messages as they accumulate mid-session instead
 * of saving everything for shutdown — shrinks the shutdown tail and the
 * next-session staleness race to the last few turns. Fires when at least
 * MEMORY_CAPTURE_INCREMENTAL_MESSAGES uncaptured user messages exist since
 * the last spawn. The mark is runtime-local (not the ledger): reading the
 * ledger per turn would race the detached workers, and a fresh runtime
 * re-deriving from zero is safe — the worker's ledger filters already
 * captured messages.
 */
export function incrementalCapture(
	entries: readonly SessionEntry[],
	state: IncrementalCaptureState,
	spawn: (messages: CaptureMessage[]) => void = captureMessages,
): void {
	const messages = extractMessages(entries)
	if (messages.length - state.spawnedCount < MEMORY_CAPTURE_INCREMENTAL_MESSAGES) return
	const batch = messages.slice(state.spawnedCount)
	state.spawnedCount = messages.length
	spawn(batch)
}

export function extractMessages(entries: readonly SessionEntry[]): CaptureMessage[] {
	// User-only: assistant content is excluded by the extraction prompt
	// anyway ("anything only the assistant said"), and carrying it costs
	// ~half the extraction tokens while diluting needles — the proven
	// failure mode. The benchmark's validated framing is user speech.
	const messages: CaptureMessage[] = []
	for (const entry of entries) {
		if (entry.type !== "message") continue
		const message = entry.message
		if (message.role !== "user") continue
		const content = messageText(message.content)
		if (content.trim()) messages.push({ role: "user", content })
	}
	return messages
}

export function messageText(content: unknown): string {
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
