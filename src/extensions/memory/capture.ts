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
import { digestDbPath, MEMORY_CAPTURE_ASSISTANT_MAX_CHARS, MEMORY_CAPTURE_INCREMENTAL_MESSAGES } from "./config.js"

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
	// User speech is the primary signal; assistant turns pass a structural
	// gate (conversation-established facts): pure text only — no tool-call
	// blocks (work product), no thinking blocks (internal reasoning),
	// bounded length. The extraction taxonomy makes the final durability
	// call with the exchange visible.
	const messages: CaptureMessage[] = []
	for (const entry of entries) {
		if (entry.type !== "message") continue
		const message = entry.message
		if (message.role === "user") {
			const content = messageText(message.content)
			if (content.trim()) messages.push({ role: "user", content })
		} else if (message.role === "assistant" && passesAssistantGate(message.content)) {
			const content = messageText(message.content)
			if (content.trim()) messages.push({ role: "assistant", content })
		}
	}
	return messages
}

/**
 * Structural gate for assistant capture: the turn must be pure text — no
 * toolCall blocks (work product; such turns are excluded whole: their text
 * fragments are work commentary), no thinking (filtered by messageText's
 * text-block pass), and within the length bound.
 */
function passesAssistantGate(content: unknown): boolean {
	if (typeof content === "string") {
		return content.trim().length > 0 && content.length <= MEMORY_CAPTURE_ASSISTANT_MAX_CHARS
	}
	if (Array.isArray(content)) {
		if (content.some((part) => (part as { type?: string }).type === "toolCall")) return false
		const text = messageText(content)
		return text.trim().length > 0 && text.length <= MEMORY_CAPTURE_ASSISTANT_MAX_CHARS
	}
	return false
}

export function messageText(content: unknown): string {
	if (typeof content === "string") return content
	if (Array.isArray(content)) {
		// Text blocks only: thinking blocks (type "thinking") are the model's
		// internal reasoning and never enter capture jobs or drift signals.
		return content
			.map((part) =>
				typeof part === "string"
					? part
					: (part as { type?: string }).type === "text"
						? ((part as { text?: string }).text ?? "")
						: "",
			)
			.join("")
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
