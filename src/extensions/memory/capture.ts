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
import { basename, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ExtensionAPI, SessionEntry } from "@earendil-works/pi-coding-agent"
import { defaultMemoryDir } from "./backend.js"
import type { CaptureMessage } from "./capture-worker.js"
import { digestDbPath, MEMORY_CAPTURE_ASSISTANT_MAX_CHARS, MEMORY_CAPTURE_INCREMENTAL_MESSAGES } from "./config.js"
import { resolveProjectScope } from "./scope.js"

export function wireMemoryCapture(pi: ExtensionAPI): void {
	pi.on("session_before_compact", (event, ctx) => {
		captureMessages(extractMessages(event.branchEntries), ctx.cwd)
	})
	pi.on("session_shutdown", (_event, ctx) => {
		captureMessages(extractMessages(ctx.sessionManager.getEntries()), ctx.cwd)
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
	cwd: string,
	spawn: (messages: CaptureMessage[], cwd: string) => void = captureMessages,
): void {
	const messages = extractMessages(entries)
	if (messages.length - state.spawnedCount < MEMORY_CAPTURE_INCREMENTAL_MESSAGES) return
	const batch = messages.slice(state.spawnedCount)
	state.spawnedCount = messages.length
	spawn(batch, cwd)
}

export function extractMessages(entries: readonly SessionEntry[]): CaptureMessage[] {
	// User speech is the primary signal; assistant turns pass a structural
	// gate (conversation-established facts): pure text only — no tool-call
	// blocks (work product), no thinking blocks (internal reasoning),
	// bounded length. The extraction taxonomy makes the final durability
	// call with the exchange visible. Deliberately NO recording date: entry
	// timestamps are a proxy that diverges from conversation time on replayed
	// or imported history — recording time never reaches the LLM's input, so
	// no instruction can launder it into fact text.
	const messages: CaptureMessage[] = []
	for (const entry of entries) {
		if (entry.type !== "message") continue
		const message = entry.message
		if (message.role === "user") {
			const content = messageText(message.content)
			if (content.trim()) messages.push({ role: "user", content })
		} else if (message.role === "assistant") {
			const content = gatedAssistantText(message.content)
			if (content) messages.push({ role: "assistant", content })
		}
	}
	return messages
}

/**
 * Structural gate for assistant capture: the turn must be pure text — no
 * toolCall blocks (work product; such turns are excluded whole: their text
 * fragments are work commentary), no thinking (filtered by messageText's
 * text-block pass). Long turns TRUNCATE at the bound instead of being
 * excluded — an answer's key statement (the count, the recommendation)
 * sits at its start, so truncation retains the needle while bounding
 * volume. Returns the gated text, or null when the turn is excluded.
 */
function gatedAssistantText(content: unknown): string | null {
	if (typeof content === "string") {
		return content.trim() ? content.slice(0, MEMORY_CAPTURE_ASSISTANT_MAX_CHARS) : null
	}
	if (Array.isArray(content)) {
		if (content.some((part) => (part as { type?: string }).type === "toolCall")) return null
		const text = messageText(content)
		return text.trim() ? text.slice(0, MEMORY_CAPTURE_ASSISTANT_MAX_CHARS) : null
	}
	return null
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

function captureMessages(messages: CaptureMessage[], cwd: string): void {
	if (messages.length === 0) return
	try {
		const dbPath = digestDbPath()
		const pendingDir = join(defaultMemoryDir(), "pending")
		mkdirSync(pendingDir, { recursive: true })
		const project = resolveProjectScope(cwd)
		// Deterministic job id: identical content in the same scope overwrites
		// the same job file instead of queueing duplicates.
		const id = createHash("sha1")
			.update(JSON.stringify({ messages, project: project?.id ?? null }))
			.digest("hex")
			.slice(0, 16)
		const jobFile = join(pendingDir, `${id}.json`)
		const tmp = `${jobFile}.${process.pid}.tmp`
		writeFileSync(tmp, JSON.stringify({ messages, project }))
		renameSync(tmp, jobFile)
		spawnCaptureWorker(jobFile, dbPath)
	} catch (err) {
		console.error("[memory] capture scheduling failed:", err instanceof Error ? err.message : err)
	}
}

export function spawnCaptureWorker(jobFile: string, dbPath: string): void {
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
	// A failed async spawn (e.g. ENOENT) emits 'error' — without a listener
	// it throws (EventEmitter semantics) and crashes the harness. Log and
	// move on: memory must never break a session.
	child.on("error", (err) => {
		console.error("[memory] capture worker spawn failed:", err instanceof Error ? err.message : err)
	})
	child.unref()
}
