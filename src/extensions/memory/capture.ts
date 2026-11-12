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
import { createHash, randomUUID } from "node:crypto"
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import { getEnvironmentApiKey } from "../../config.js"
import { defaultMemoryDir } from "./backend.js"
import type { CaptureMessage } from "./capture-worker.js"
import {
	digestDbPath,
	MEMORY_CAPTURE_ASSISTANT_MAX_CHARS,
	MEMORY_CAPTURE_INCREMENTAL_MESSAGES,
	MEMORY_CAPTURE_JOB_MAX_MESSAGES,
	MEMORY_CAPTURE_TOOL_CALL_CHARS,
	MEMORY_CAPTURE_TOOL_RESULT_HEAD_CHARS,
	MEMORY_CAPTURE_TOOL_RESULT_TAIL_CHARS,
} from "./config.js"
import { parseBooleanFlag } from "./flags.js"
import { resolveProjectScope } from "./scope.js"

/**
 * The accessors the session-turn handler needs from the capture wiring:
 * evaluate the non-overlapping increment at agent starts, and reset the
 * mark after compaction. Ownership rule: the extension registers ONE
 * handler per event, and `before_agent_start`/`session_compact` belong to
 * the session-turn handler (index.ts) — the capture wiring owns only
 * `turn_end`/`tool_result`/shutdown so it never shadows them.
 */
export interface MemoryCaptureWiring {
	fireIncrement(ctx: ExtensionContext): void
	resetIncrement(): void
}

export function wireMemoryCapture(pi: ExtensionAPI, isActive: () => boolean): MemoryCaptureWiring {
	if (captureDisabled()) {
		const noop = (): void => {}
		return { fireIncrement: noop, resetIncrement: noop }
	}
	// The incremental mark is wiring-owned: the producer hooks below and the
	// tail-capture at shutdown must agree on what the queue already has, so
	// nothing lands twice in pending/.
	const incremented: IncrementalCaptureState = createIncrementalCaptureState()
	pi.on("session_before_compact", (event, ctx) => {
		if (!isActive()) return
		captureMessages(extractMessages(event.branchEntries), ctx.cwd, session)
	})
	// Mid-loop producers: evaluate the same non-overlapping increment at turn
	// end (human-paced sessions) and after every tool step (agentic loops) —
	// before_agent_start alone never fires inside a 70-step tool loop, which
	// is how long episodes were accumulating until shutdown.
	const fireIncrement = (ctx: ExtensionContext): void => {
		if (!isActive()) return
		incrementalCapture(ctx.sessionManager.getEntries(), incremented, ctx.cwd)
	}
	pi.on("turn_end", (_event, ctx) => {
		fireIncrement(ctx)
	})
	pi.on("tool_result", (_event, ctx) => {
		fireIncrement(ctx)
	})
	const resetIncrement = (): void => {
		// Post-compaction entries restructure — re-derive the mark from zero;
		// the worker's ledger dedupes anything the queue already passed.
		incremented.spawnedCount = 0
	}
	pi.on("session_shutdown", (_event, ctx) => {
		if (!isActive()) return
		// Only the tail past the incremental mark — never a second copy of
		// what the queue already holds — and bounded jobs: a poisoned window
		// costs its own span, not the session backlog.
		const tail = extractMessages(ctx.sessionManager.getEntries()).slice(incremented.spawnedCount)
		captureMessagesTail(tail, ctx.cwd)
	})
	return { fireIncrement, resetIncrement }
}

/** Write the shutdown tail as bounded jobs: chunks of at most
 * MEMORY_CAPTURE_JOB_MAX_MESSAGES, each its own hash-named file. */
export function captureMessagesTail(
	tail: CaptureMessage[],
	cwd: string,
	perJobMax = MEMORY_CAPTURE_JOB_MAX_MESSAGES,
): void {
	for (let i = 0; i < tail.length; i += perJobMax) {
		captureMessages(tail.slice(i, i + perJobMax), cwd)
	}
}

/**
 * Capture kill-switch: with KIMCHI_MEMORY_CAPTURE=off, the session skips
 * capture entirely — no handlers registered, no job files written, no
 * workers spawned. The benchmark's shared-store mode uses this to freeze
 * the memory store across question launches (each question session runs
 * with the store as-is instead of adding its own content). Unset or any
 * other value keeps normal capture.
 */
export function captureDisabled(): boolean {
	return process.env.KIMCHI_MEMORY_CAPTURE === "off"
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
	spawn: (messages: CaptureMessage[], cwd: string) => boolean | undefined = captureMessages,
): void {
	const messages = extractMessages(entries)
	if (messages.length - state.spawnedCount < MEMORY_CAPTURE_INCREMENTAL_MESSAGES) return
	const batch = messages.slice(state.spawnedCount)
	// Advance the mark only when the job actually landed: a swallowed write
	// failure must leave the span inside the shutdown tail (no silent loss),
	// not skip the batch forever on this runtime.
	if (spawn(batch, cwd) === false) return
	state.spawnedCount = messages.length
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
	const toolWork = toolTurnsEnabled() ? extractToolWork(entries) : new Map<number, CaptureMessage[]>()
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]
		if (entry.type !== "message") continue
		const message = entry.message
		if (message.role === "user") {
			const content = messageText(message.content)
			if (content.trim()) messages.push({ role: "user", content })
		} else if (message.role === "assistant") {
			const content = gatedAssistantText(message.content)
			const thinking = thinkingText(message.content)
			if (content) {
				// Engaged/notes/e conclusions all ride in the visible text; the
				// model's own reasoning rides alongside — the "valuable insight"
				// class lives there for tool-driving agents (notes-to-self).
				messages.push({
					role: "assistant",
					content: thinking ? `${content}\n\n[internal reasoning]: ${thinking}` : content,
				})
			} else {
				// Pure-reasoning turns (text gated out by a toolCall block): the
				// reasoning is the only capture material this turn carries.
				if (thinking) messages.push({ role: "assistant", content: `[internal reasoning]: ${thinking}` })
				// Lane 1 (flagged): gatedAssistantText returned null — the turn
				// carried toolCall blocks with no text summary — so splice its
				// paired tool work summaries in at this exact position instead,
				// alongside any reasoning the turn carried.
				const work = toolWork.get(i)
				if (work) messages.push(...work)
			}
		}
	}
	return messages
}

/**
 * Tool-turn capture lane (env KIMCHI_MEMORY_CAPTURE_TOOL_TURNS, default OFF):
 * tool-using turns carry the benchmark's most valuable memory material —
 * the attempt (toolCall args: the command/query) and the receipt
 * (toolResult: what the environment returned). OFF is byte-parity with
 * before: assistant toolCall turns excluded whole, toolResults never read.
 */
export function toolTurnsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return parseBooleanFlag(env, "KIMCHI_MEMORY_CAPTURE_TOOL_TURNS", { strict: true })
}

/**
 * Pair assistant toolCall blocks with their toolResult follow-ups into
 * bounded request/response records ("[tool] name: args → result"), keyed
 * by the entries index of the owning assistant turn so the extractor
 * splices them in transcript order only when the text gate excluded that
 * turn. Records use the assistant role: the attempt is the agent's own
 * action, and receipts extraction reads the result as the environment's
 * response to that expectation. Thinking stays excluded — reasoning never
 * enters fact text.
 */
function extractToolWork(entries: readonly SessionEntry[]): Map<number, CaptureMessage[]> {
	const out = new Map<number, CaptureMessage[]>()
	const results = new Map<string, string>()
	for (const entry of entries) {
		if (entry.type !== "message") continue
		const m = entry.message as { role?: string; content?: unknown; toolCallId?: string }
		if (m?.role !== "toolResult") continue
		if (typeof m.toolCallId !== "string") continue
		const text = messageText(m.content).trim()
		if (text) results.set(m.toolCallId, text)
	}
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]
		if (entry.type !== "message") continue
		const m = entry.message as { role?: string; content?: unknown }
		if (m?.role !== "assistant" || !Array.isArray(m.content)) continue
		const records: CaptureMessage[] = []
		for (const part of m.content) {
			const p = part as { type?: string; name?: string; id?: string; arguments?: unknown }
			if (p?.type !== "toolCall" || typeof p.name !== "string") continue
			const args = toolCallArgsText(p.arguments)
			const call = args ? `${p.name}: ${args.slice(0, MEMORY_CAPTURE_TOOL_CALL_CHARS)}` : p.name
			// Attempt (assistant) and receipt (user) as separate records: that
			// is the text-protocol shape (QUERY action text + observation user
			// message) the extraction contracts were built on — extraction
			// explicitly excludes assistant-side tool output, so a combined
			// assistant record would starve itself.
			records.push({ role: "assistant", content: `[tool] ${call}` })
			const result = typeof p.id === "string" ? results.get(p.id) : undefined
			if (result !== undefined) records.push({ role: "env", content: boundedResult(result) })
			if (typeof p.id === "string") results.delete(p.id)
		}
		if (records.length > 0) out.set(i, records)
	}
	return out
}

function toolCallArgsText(args: unknown): string {
	if (typeof args === "string") return args.trim()
	if (args == null) return ""
	try {
		return JSON.stringify(args)
	} catch {
		return ""
	}
}

/**
 * Bound a tool result: keep the head (column lists, first rows) plus the
 * tail (final aggregate / verdict), elide the middle; short results pass
 * through whole.
 */
function boundedResult(text: string): string {
	const head = MEMORY_CAPTURE_TOOL_RESULT_HEAD_CHARS
	const tail = MEMORY_CAPTURE_TOOL_RESULT_TAIL_CHARS
	if (text.length <= head + tail) return text
	return `${text.slice(0, head)} …[${text.length - head - tail} chars elided]… ${text.slice(-tail)}`
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
		// internal reasoning and live in their own capture lane (thinkingText
		// below) so cross-cutting readers (drift signals, job text builders)
		// stay reasoning-free.
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

/** Read one capture session's cumulative stored-facts count from the
 *  worker's completion record (capture-completions.json — per-session
 *  counts, merge-written by each drain under the capture lock). Degrades
 *  to 0: surfacing is best-effort and must never break a session. */
export function readCaptureSessionSaved(sessionId: string): number {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(defaultMemoryDir(), "capture-completions.json"), "utf-8"))
		const sessions =
			parsed && typeof parsed === "object" && !Array.isArray(parsed)
				? (parsed as { sessions?: unknown }).sessions
				: undefined
		if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) return 0
		const entry = (sessions as Record<string, unknown>)[sessionId]
		if (!entry || typeof entry !== "object") return 0
		const factsAdded = (entry as { factsAdded?: unknown }).factsAdded
		return typeof factsAdded === "number" && factsAdded > 0 ? factsAdded : 0
	} catch {
		return 0
	}
}

/**
 * Assistant internal-reasoning lane: thinking blocks concatenated and
 * bounded. Reasoning is the model's own process voice — for an
 * agent driving an environment ("buttons are batches of ~12 ticks, so
 * stagger one action per batch") it is often the ONLY place durable
 * tactical insight appears, so capture-time extraction sees it under an
 * explicit [internal reasoning]: marker the extraction prompt can lean
 * on. Kept out of messageText deliberately: broadcast readers (drift
 * signals, recall queries) must stay reasoning-free.
 */
export function thinkingText(content: unknown): string {
	if (!Array.isArray(content)) return ""
	const parts: string[] = []
	for (const part of content) {
		if (typeof part !== "object" || part === null) continue
		if ((part as { type?: string }).type !== "thinking") continue
		const text = (part as { text?: string }).text ?? ""
		if (text.trim()) parts.push(text)
	}
	return parts.join("\n\n").slice(0, MEMORY_CAPTURE_ASSISTANT_MAX_CHARS)
}

/** The session id for the current process — scoping job ids and hashes.
 * A uuid, not a timestamp: recording time never enters LLM input. */
const CAPTURE_SESSION_ID = randomUUID()

function captureSessionId(): string {
	return CAPTURE_SESSION_ID
}

function captureMessages(messages: CaptureMessage[], cwd: string): boolean {
	if (captureDisabled() || messages.length === 0) return true
	try {
		const dbPath = digestDbPath()
		const pendingDir = join(defaultMemoryDir(), "pending")
		mkdirSync(pendingDir, { recursive: true })
		const project = resolveProjectScope(cwd)
		// Deterministic job id: identical content in the same scope overwrites
		// the same job file instead of queueing duplicates.
		const id = createHash("sha1")
			.update(JSON.stringify({ messages, project: project?.id ?? null, session }))
			.digest("hex")
			.slice(0, 16)
		const jobFile = join(pendingDir, `${id}.json`)
		const tmp = `${jobFile}.${process.pid}.tmp`
		writeFileSync(tmp, JSON.stringify({ messages, project, session }))
		renameSync(tmp, jobFile)
		spawnCaptureWorker(jobFile, dbPath)
		return true
	} catch (err) {
		console.error("[memory] capture scheduling failed:", err instanceof Error ? err.message : err)
		return false
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
	// The worker runs loadConfig() itself, but startup strips KIMCHI_API_KEY
	// from the inherited environment (the security scrub in config.ts) —
	// when the key came only from env (not the saved config file), the
	// worker would start with no API key. Re-inject the retained key.
	const apiKey = getEnvironmentApiKey()
	const env = apiKey ? { ...process.env, KIMCHI_API_KEY: apiKey } : process.env
	// Drain visibility: worker output must land somewhere even when the main
	// session's own logs vanish (bench: runtime-spawned children were never
	// observable — the only diagnostics came from the worker-logs files we
	// sprinkled). Append each child's stdout+stderr to per-store files.
	let outFd: number | undefined
	try {
		const logsDir = join(dirname(dbPath), "..", "worker-logs")
		mkdirSync(logsDir, { recursive: true })
		outFd = openSync(join(logsDir, `capture-${process.pid}-${Date.now()}.log`), "a")
	} catch {
		// visibility must never break the spawn
	}
	const child = spawn(cmd[0], cmd.slice(1), {
		detached: true,
		stdio: outFd !== undefined ? (["ignore", outFd, outFd] as const) : "ignore",
		env,
	})
	if (outFd !== undefined) {
		child.on("spawn", () => {
			try {
				closeSync(outFd)
			} catch {
				// already closed
			}
		})
	}
	// Spawn visibility: stdio is ignored, so without this line a worker that
	// never starts leaves zero evidence in the session's own attempt log.
	const spawnTag = `[memory] capture worker spawn pid=${child.pid ?? "?"} cmd=${cmd.length}`
	child.on("error", (err) => {
		console.error(`${spawnTag} failed:`, err instanceof Error ? err.message : err)
	})
	child.on("spawn", () => {
		console.error(spawnTag)
	})
	child.unref()
}
