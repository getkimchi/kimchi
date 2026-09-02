/**
 * Process registry for background bash execution.
 *
 * Spawns a command via an injected `BashOperations` (upstream
 * `createLocalBashOperations` in production) and keeps it running
 * independently of the agent loop. The bash tool's `execute` resolves at
 * the command's one-time initial handoff with an incremental output
 * snapshot plus the handle; the process then joins the session cohort's
 * shared review schedule (see `./review-coordinator.ts`).
 *
 * Design notes:
 *  - The registry does NOT resolve on process exit. `ops.exec` is started
 *    without an upstream `timeout` (the registry owns one absolute
 *    harness safety limit), and its promise is captured per entry so
 *    callers can race a handoff/review timer against natural exit via
 *    `whenExited`.
 *  - Killing is delegated to upstream: aborting the entry's
 *    `AbortController` triggers `killProcessTree` inside `exec` (see
 *    `createLocalBashOperations`), so detached grandchildren are reaped
 *    consistently with the synchronous bash path.
 *  - Output is held in a bounded ring buffer (last `maxBufferBytes`),
 *    so long-running commands cannot grow memory unbounded. Incremental
 *    snapshots (`snapshotSince`) return only output not yet delivered to
 *    the model, accounting for bytes evicted from the ring.
 *  - Each entry has an absolute wall-clock safety deadline
 *    (`limitSeconds` after spawn). When it passes, the registry
 *    auto-kills the process (reason `"safety-limit"`) so a forgotten
 *    process is deterministically bounded. The limit is configured by
 *    the human/operator (`--bash-process-limit`), never by the model.
 *
 * This module is intentionally free of any `ExtensionAPI` dependency so it
 * can be unit-tested with a fake `BashOperations`. The owning extension
 * (see `./index.ts`) instantiates one registry per session and wires
 * `session_shutdown` → `shutdown()`.
 */

import { randomBytes, randomUUID } from "node:crypto"
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type BashOperations, type TruncationResult, truncateTail } from "@earendil-works/pi-coding-agent"

/** Default ring-buffer capacity (bytes) kept per running process. */
export const DEFAULT_MAX_BUFFER_BYTES = 65_536

/** Default tail-window size (bytes) returned for running snapshots. */
export const DEFAULT_TAIL_BYTES = 8192

/**
 * Universal absolute safety limit (seconds) applied to every background
 * process when the operator did not pass `--bash-process-limit`. This is
 * a product policy (one hour), not a per-command runtime prediction.
 */
export const DEFAULT_BASH_PROCESS_LIMIT_SECONDS = 3600

/** Reason recorded when the harness safety limit kills a process. */
export const SAFETY_LIMIT_REASON = "safety-limit"

export type ProcessState = "running" | "stopped" | "exited"

export interface SpawnOptions {
	/** Absolute safety limit in seconds; the process is killed when it is still running this long after spawn. */
	limitSeconds: number
	/** Max bytes retained in the output ring buffer. */
	maxBufferBytes?: number
}

/**
 * Collapse a command into a single-line, whitespace-normalized, bounded
 * summary safe to repeat in status lines and review messages. Never
 * re-sends an entire heredoc or environment payload to the model.
 */
export function summarizeCommand(command: string, maxLength = 96): string {
	const collapsed = command.replace(/\s+/g, " ").trim()
	if (collapsed.length <= maxLength) return collapsed
	return `${collapsed.slice(0, Math.max(0, maxLength - 1))}…`
}

export interface TailSnapshot {
	/** UTF-8 decode of the last `bytes` of output. */
	text: string
	/** Number of bytes in the snapshot. */
	bytes: number
	state: ProcessState
	exitCode: number | null
	/** Set when the process was killed (`"stop"` | `"deadline"` | `"aborted"`). */
	reason: string | null
}

/**
 * Incremental output snapshot: only bytes appended to the stream since
 * the cursor last delivered to the model, plus eviction accounting.
 */
export interface IncrementalSnapshot {
	/** UTF-8 decode of the retained unseen output (empty when nothing new). */
	text: string
	/** Cursor to pass to the next snapshot once this one is delivered. */
	nextCursor: number
	/** Total stream bytes appended since the delivered cursor (including evicted). */
	newBytes: number
	/**
	 * Unseen bytes NOT included in `text` (contained in `newBytes`): bytes
	 * the ring buffer already evicted, plus older unseen bytes skipped
	 * because the retained unseen range exceeds the snapshot cap. The
	 * cursor advances past them on delivery, so they only reappear via the
	 * final truncation/spill path.
	 */
	omittedBytes: number
	/** Total stream bytes appended since spawn. */
	totalBytes: number
	state: ProcessState
	exitCode: number | null
	reason: string | null
}

/** Full output snapshot for final results (mirrors upstream OutputSnapshot). */
export interface FinalSnapshot {
	/** Full output text (truncated to upstream limits). */
	content: string
	/** Truncation info (matches upstream TruncationResult). */
	truncation?: TruncationResult
	/** Path to the complete spilled output; await remove() or shutdown() before reading it. */
	fullOutputPath?: string
	state: ProcessState
	exitCode: number | null
	reason: string | null
}

interface OutputSnapshot {
	content: string
	truncation: TruncationResult
	fullOutputPath?: string
}

function defaultTempFilePath(prefix: string): string {
	return join(tmpdir(), `${prefix}-${randomBytes(8).toString("hex")}.log`)
}

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8")
}

/**
 * Drop the first `byteCount` bytes of `text`, advancing past any split
 * UTF-8 continuation bytes so the result never starts mid-character.
 */
function sliceBufferText(text: string, byteCount: number): string {
	const buffer = Buffer.from(text, "utf-8")
	if (byteCount >= buffer.length) return ""
	let start = Math.max(0, byteCount)
	while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++
	return buffer.subarray(start).toString("utf-8")
}

class OutputAccumulator {
	private readonly maxLines: number
	private readonly maxBytes: number
	private readonly maxRollingBytes: number
	private readonly tempFilePrefix: string
	private readonly decoder = new TextDecoder()
	private rawChunks: Buffer[] = []
	private tailText = ""
	private tailBytes = 0
	private tailStartsAtLineBoundary = true
	private totalRawBytes = 0
	private totalDecodedBytes = 0
	private completedLines = 0
	private totalLines = 0
	private hasOpenLine = false
	private finished = false
	private tempFilePath: string | undefined
	private tempFileStream: WriteStream | undefined
	private tempFileError: Error | undefined

	constructor(options: { maxLines?: number; maxBytes?: number; tempFilePrefix?: string } = {}) {
		this.maxLines = options.maxLines ?? 2000
		this.maxBytes = options.maxBytes ?? 50 * 1024
		this.maxRollingBytes = Math.max(this.maxBytes * 2, 1)
		this.tempFilePrefix = options.tempFilePrefix ?? "pi-output"
	}

	append(data: Buffer): void {
		if (this.finished) throw new Error("Cannot append to a finished output accumulator")
		this.totalRawBytes += data.length
		this.appendDecodedText(this.decoder.decode(data, { stream: true }))
		if (this.tempFileStream || this.shouldUseTempFile()) {
			this.ensureTempFile()
			this.writeTempFile(data)
			return
		}
		if (data.length > 0) this.rawChunks.push(data)
	}

	finish(): void {
		if (this.finished) return
		this.finished = true
		this.appendDecodedText(this.decoder.decode())
		if (this.shouldUseTempFile()) this.ensureTempFile()
	}

	snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
		const tailTruncation = truncateTail(this.getSnapshotText(), {
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		})
		const truncated = this.totalLines > this.maxLines || this.totalDecodedBytes > this.maxBytes
		const truncatedBy = truncated
			? (tailTruncation.truncatedBy ?? (this.totalDecodedBytes > this.maxBytes ? "bytes" : "lines"))
			: null
		const truncation = {
			...tailTruncation,
			truncated,
			truncatedBy,
			totalLines: this.totalLines,
			totalBytes: this.totalDecodedBytes,
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		}
		if (options.persistIfTruncated && truncation.truncated) this.ensureTempFile()
		return { content: truncation.content, truncation, fullOutputPath: this.tempFilePath }
	}

	async closeTempFile(): Promise<void> {
		if (!this.tempFileStream) {
			if (this.tempFileError) throw this.tempFileError
			return
		}
		const stream = this.tempFileStream
		this.tempFileStream = undefined
		if (this.tempFileError) {
			stream.destroy()
			throw this.tempFileError
		}
		await new Promise<void>((resolve, reject) => {
			const onError = (error: Error) => {
				stream.off("finish", onFinish)
				reject(error)
			}
			const onFinish = () => {
				stream.off("error", onError)
				resolve()
			}
			stream.once("error", onError)
			stream.once("finish", onFinish)
			stream.end()
		})
		if (this.tempFileError) throw this.tempFileError
	}

	private appendDecodedText(text: string): void {
		if (text.length === 0) return
		const bytes = byteLength(text)
		this.totalDecodedBytes += bytes
		this.tailText += text
		this.tailBytes += bytes
		if (this.tailBytes > this.maxRollingBytes * 2) this.trimTail()

		let newlines = 0
		let lastNewline = -1
		for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
			newlines++
			lastNewline = i
		}
		if (newlines === 0) {
			this.hasOpenLine = true
		} else {
			this.completedLines += newlines
			const tail = text.slice(lastNewline + 1)
			this.hasOpenLine = tail.length > 0
		}
		this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0)
	}

	private trimTail(): void {
		const buffer = Buffer.from(this.tailText, "utf-8")
		if (buffer.length <= this.maxRollingBytes) {
			this.tailBytes = buffer.length
			return
		}
		let start = buffer.length - this.maxRollingBytes
		while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start++
		this.tailStartsAtLineBoundary = start === 0 ? this.tailStartsAtLineBoundary : buffer[start - 1] === 0x0a
		this.tailText = buffer.subarray(start).toString("utf-8")
		this.tailBytes = byteLength(this.tailText)
	}

	private getSnapshotText(): string {
		if (this.tailStartsAtLineBoundary) return this.tailText
		const firstNewline = this.tailText.indexOf("\n")
		return firstNewline === -1 ? this.tailText : this.tailText.slice(firstNewline + 1)
	}

	private shouldUseTempFile(): boolean {
		return (
			this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines
		)
	}

	private ensureTempFile(): void {
		if (this.tempFilePath) return
		this.tempFilePath = defaultTempFilePath(this.tempFilePrefix)
		mkdirSync(tmpdir(), { recursive: true })
		this.tempFileStream = createWriteStream(this.tempFilePath)
		this.tempFileStream.on("error", (error) => {
			this.tempFileError ??= error
		})
		for (const chunk of this.rawChunks) this.writeTempFile(chunk)
		this.rawChunks = []
	}

	private writeTempFile(data: Buffer): void {
		if (!this.tempFileError) this.tempFileStream?.write(data)
	}
}

export interface ProcessEntry {
	readonly handle: string
	/** Wall-clock ms (Date.now()) when the process was spawned. Used to report elapsed time. */
	readonly spawnedAtMs: number
	state: ProcessState
	exitCode: number | null
	reason: string | null
	/** Single-line, bounded command summary shown in status/review text. */
	readonly commandSummary: string
	/** Working directory the process was spawned in. */
	readonly cwd: string
	/** Absolute wall-clock ms when the safety limit kills the process. */
	deadlineMs: number
	/** Total seconds granted to the process (the configured safety limit). */
	deadlineSeconds: number
	/** Wall-clock ms of the most recent output byte, or undefined when silent. */
	lastOutputAtMs: number | undefined
	/** Absolute stream offset (bytes) last delivered to the model. */
	deliveredCursor: number
	readonly buffer: OutputRingBuffer
	readonly accumulator: OutputAccumulator
	readonly controller: AbortController
	execPromise: Promise<{ exitCode: number | null }>
	deadlineTimer: NodeJS.Timeout | undefined
}

/**
 * Bounded byte ring buffer. Keeps at most `capacity` bytes, dropping whole
 * leading chunks when over capacity (and truncating the head of a single
 * over-sized chunk). `snapshot(maxBytes)` returns the last `maxBytes`
 * bytes as a UTF-8 string.
 *
 * Note: byte-level truncation can split a multi-byte UTF-8 sequence at the
 * head of the window. This is acceptable for a command-output tail window
 * (overwhelmingly ASCII) and matches the granularity of upstream bash
 * truncation.
 */
export class OutputRingBuffer {
	private chunks: Buffer[] = []
	private totalBytes = 0
	readonly capacity: number
	/** Absolute count of bytes ever appended (never decreases on eviction). */
	private appended = 0

	constructor(capacity: number = DEFAULT_MAX_BUFFER_BYTES) {
		this.capacity = Math.max(0, Math.floor(capacity))
	}

	append(data: Buffer): void {
		if (data.length === 0 || this.capacity === 0) return
		this.chunks.push(data)
		this.totalBytes += data.length
		this.appended += data.length
		this.evict()
	}

	/** Total bytes ever appended to the stream (absolute cursor end). */
	get appendedBytes(): number {
		return this.appended
	}

	/** Absolute stream offset of the first retained byte (bytes evicted). */
	get retainedStartOffset(): number {
		return this.appended - this.totalBytes
	}

	private evict(): void {
		// Drop whole leading chunks until at or under capacity (keep at least
		// the most recent chunk so a single huge write still yields a tail).
		while (this.totalBytes > this.capacity && this.chunks.length > 1) {
			const head = this.chunks[0] as Buffer
			this.chunks.shift()
			this.totalBytes -= head.length
		}
		// If the sole remaining chunk still exceeds capacity, keep its tail.
		if (this.totalBytes > this.capacity && this.chunks.length === 1) {
			const excess = this.totalBytes - this.capacity
			const only = this.chunks[0] as Buffer
			this.chunks[0] = only.subarray(excess)
			this.totalBytes = this.capacity
		}
	}

	snapshot(maxBytes: number = DEFAULT_TAIL_BYTES): { text: string; bytes: number } {
		const limit = Math.min(maxBytes, this.totalBytes)
		if (limit <= 0) return { text: "", bytes: 0 }
		const result = Buffer.alloc(limit)
		let remaining = limit
		for (let i = this.chunks.length - 1; i >= 0 && remaining > 0; i--) {
			const chunk = this.chunks[i] as Buffer
			const take = Math.min(chunk.length, remaining)
			chunk.copy(result, remaining - take, chunk.length - take, chunk.length)
			remaining -= take
		}
		return { text: result.toString("utf8"), bytes: limit }
	}

	/**
	 * Snapshot up to `maxBytes` of retained output starting AT absolute
	 * stream offset `startOffset` (clamped to the retained range). Unlike
	 * `snapshot` — which always returns the NEWEST bytes — this walks
	 * forward from a specific offset so incremental snapshots can begin
	 * exactly at the unseen cursor rather than at the ring's tail.
	 */
	snapshotRange(startOffset: number, maxBytes: number): { text: string; bytes: number } {
		const start = Math.max(0, Math.max(Math.floor(startOffset), this.retainedStartOffset))
		const limit = Math.min(Math.max(0, Math.floor(maxBytes)), this.appended - start)
		if (limit <= 0) return { text: "", bytes: 0 }
		const result = Buffer.alloc(limit)
		let chunkStart = this.retainedStartOffset
		let written = 0
		for (const chunk of this.chunks) {
			const chunkEnd = chunkStart + chunk.length
			const copyFrom = Math.max(chunkStart, start)
			const copyTo = Math.min(chunkEnd, start + limit)
			if (copyFrom < copyTo) {
				chunk.copy(result, written, copyFrom - chunkStart, copyTo - chunkStart)
				written += copyTo - copyFrom
			}
			chunkStart = chunkEnd
		}
		return { text: result.toString("utf8"), bytes: written }
	}

	clear(): void {
		this.chunks = []
		this.totalBytes = 0
	}

	get length(): number {
		return this.totalBytes
	}
}

export interface ProcessRegistry {
	/** Spawn a command in the background; returns the handle synchronously. */
	spawn(
		ops: BashOperations,
		command: string,
		cwd: string,
		env: NodeJS.ProcessEnv | undefined,
		opts: SpawnOptions,
	): string
	/** Tail-window snapshot of accumulated output + current state. */
	snapshotTail(handle: string, maxBytes?: number): TailSnapshot
	/**
	 * Incremental snapshot of unseen output since the entry's delivered
	 * cursor, capped at `maxBytes` of retained text. Pure: does NOT advance
	 * the cursor — call `markDelivered` once the snapshot is part of an
	 * authoritative result or message.
	 */
	snapshotSince(handle: string, maxBytes?: number): IncrementalSnapshot
	/** Advance the entry's delivered cursor after an authoritative delivery. */
	markDelivered(handle: string, cursor: number): void
	/** Full output snapshot (truncated + temp-file spill, like upstream). */
	finalSnapshot(handle: string): FinalSnapshot | undefined
	/** Kill a running process and await abort settlement. `reason` defaults to "stop". */
	kill(handle: string, reason?: string): Promise<void>
	/** Promise that resolves with the exit code when the process ends. */
	whenExited(handle: string): Promise<{ exitCode: number | null }>
	/** Read-only entry state, or undefined if unknown. */
	getEntry(handle: string): Readonly<ProcessEntry> | undefined
	/** Remove an entry, keeping any reported spill file readable until shutdown. */
	remove(handle: string): Promise<void>
	/** Kill every still-running entry and clear the registry. */
	shutdown(): Promise<void>
	/** Number of entries currently tracked. */
	readonly size: number
}

/**
 * How far back (bytes) `snapshotSince` looks for the last line boundary
 * when adding the small already-delivered overlap that keeps mid-line
 * snapshots readable.
 */
const SNAPSHOT_OVERLAP_WINDOW_BYTES = 256

/**
 * Elapsed whole seconds since `spawnedAtMs`, floored at zero so a clock
 * skew can never produce a negative duration. Reads Date.now() directly so
 * tests can control it with fake system time.
 */
export function elapsedSecondsSince(spawnedAtMs: number): number {
	return Math.max(0, Math.floor((Date.now() - spawnedAtMs) / 1000))
}

export function createProcessRegistry(): ProcessRegistry {
	const entries = new Map<string, ProcessEntry>()
	const spillPaths = new Set<string>()

	function clearDeadlineTimer(entry: ProcessEntry): void {
		if (entry.deadlineTimer) {
			clearTimeout(entry.deadlineTimer)
			entry.deadlineTimer = undefined
		}
	}

	function killInternal(entry: ProcessEntry, reason: string): void {
		if (entry.state !== "running") return
		entry.state = "stopped"
		entry.reason = reason
		clearDeadlineTimer(entry)
		// Aborting triggers upstream `killProcessTree` inside `exec`.
		try {
			entry.controller.abort()
		} catch {
			// Controller already aborted — nothing to do.
		}
	}

	function armDeadline(entry: ProcessEntry): void {
		clearDeadlineTimer(entry)
		const delay = entry.deadlineMs - Date.now()
		if (delay <= 0) {
			killInternal(entry, SAFETY_LIMIT_REASON)
			return
		}
		entry.deadlineTimer = setTimeout(() => {
			killInternal(entry, SAFETY_LIMIT_REASON)
		}, delay)
		// Keep the event loop responsive: an unref'd timer won't keep Node
		// alive on its own, but a pending background process (held by the
		// child handle) will — and when the process is the only thing left,
		// it should exit, not be kept alive by this timer.
		entry.deadlineTimer.unref?.()
	}

	function spawn(
		ops: BashOperations,
		command: string,
		cwd: string,
		env: NodeJS.ProcessEnv | undefined,
		opts: SpawnOptions,
	): string {
		const handle = randomUUID()
		const controller = new AbortController()
		const buffer = new OutputRingBuffer(opts.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES)
		const accumulator = new OutputAccumulator({
			maxLines: 2000,
			maxBytes: 50_000,
			tempFilePrefix: "pi-bash",
		})

		// Declared before the exec callbacks so the onData/settlement closures
		// can mutate entry state; assigned immediately below, before any
		// callback can run (process data/settlement are always asynchronous).
		let entry: ProcessEntry
		const rawExec = ops.exec(command, cwd, {
			onData: (data: Buffer) => {
				entry.lastOutputAtMs = Date.now()
				buffer.append(data)
				accumulator.append(data)
			},
			signal: controller.signal,
			// No upstream timeout: the registry owns the absolute safety limit.
			timeout: undefined,
			env,
		})
		const execPromise = rawExec
			.then((result) => {
				if (entry.state === "running") {
					entry.state = "exited"
					entry.exitCode = result.exitCode
				}
				return result
			})
			.catch((err: unknown) => {
				if (entry.state === "running") {
					const msg = err instanceof Error ? err.message : String(err)
					entry.state = msg === "aborted" ? "stopped" : "exited"
					entry.exitCode = null
					if (!entry.reason) entry.reason = msg
				}
				return { exitCode: null }
			})
			.finally(() => {
				clearDeadlineTimer(entry)
				accumulator.finish()
			})

		entry = {
			handle,
			spawnedAtMs: Date.now(),
			state: "running",
			exitCode: null,
			reason: null,
			commandSummary: summarizeCommand(command),
			cwd,
			deadlineMs: Date.now() + Math.max(0, opts.limitSeconds) * 1000,
			deadlineSeconds: Math.max(0, Math.round(opts.limitSeconds)),
			lastOutputAtMs: undefined,
			deliveredCursor: 0,
			buffer,
			accumulator,
			controller,
			execPromise,
			deadlineTimer: undefined,
		}
		entries.set(handle, entry)
		armDeadline(entry)
		return handle
	}

	function snapshotTail(handle: string, maxBytes: number = DEFAULT_TAIL_BYTES): TailSnapshot {
		const entry = entries.get(handle)
		if (!entry) {
			return { text: "", bytes: 0, state: "stopped", exitCode: null, reason: "unknown" }
		}
		const { text, bytes } = entry.buffer.snapshot(maxBytes)
		return { text, bytes, state: entry.state, exitCode: entry.exitCode, reason: entry.reason }
	}

	function snapshotSince(handle: string, maxBytes: number = DEFAULT_TAIL_BYTES): IncrementalSnapshot {
		const entry = entries.get(handle)
		if (!entry) {
			return {
				text: "",
				nextCursor: 0,
				newBytes: 0,
				omittedBytes: 0,
				totalBytes: 0,
				state: "stopped",
				exitCode: null,
				reason: "unknown",
			}
		}
		const cursor = Math.min(entry.deliveredCursor, entry.buffer.appendedBytes)
		const appendedTotal = entry.buffer.appendedBytes
		const retainedStart = entry.buffer.retainedStartOffset
		const newBytes = appendedTotal - cursor
		if (newBytes <= 0) {
			return {
				text: "",
				nextCursor: appendedTotal,
				newBytes,
				omittedBytes: 0,
				totalBytes: appendedTotal,
				state: entry.state,
				exitCode: entry.exitCode,
				reason: entry.reason,
			}
		}
		const evictedUnseen = Math.max(0, Math.min(retainedStart, appendedTotal) - cursor)
		const unseenStart = Math.max(cursor, retainedStart)
		const retainedUnseen = appendedTotal - unseenStart
		const shownBytes = Math.min(Math.max(0, retainedUnseen), maxBytes)
		// The snapshot shows the NEWEST `shownBytes` of the unseen range. When
		// the cap skips older unseen bytes, they count as omitted so the model
		// is told a gap exists instead of silently losing output.
		let textStart = appendedTotal - shownBytes
		let textByteLength = shownBytes
		if (textByteLength > 0 && textStart === cursor && cursor > retainedStart) {
			// The full unseen range fits and begins exactly at the delivered
			// cursor: prepend the current line's already-delivered head (small
			// overlap) so mid-line snapshots keep enough context to be readable.
			const overlapFloor = Math.max(retainedStart, cursor - SNAPSHOT_OVERLAP_WINDOW_BYTES)
			const probe = entry.buffer.snapshotRange(overlapFloor, cursor - overlapFloor)
			const lastNewline = probe.text.lastIndexOf("\n")
			if (lastNewline !== -1 && lastNewline < probe.text.length - 1) {
				const overlapBytes = byteLength(probe.text.slice(lastNewline + 1))
				textStart = cursor - overlapBytes
				textByteLength += overlapBytes
			}
		} else if (textByteLength > 0 && textStart > unseenStart) {
			// Older unseen bytes were skipped by the cap: drop a leading partial
			// line so the shown tail starts at a line boundary.
			const raw = entry.buffer.snapshotRange(textStart, textByteLength)
			const firstNewline = raw.text.indexOf("\n")
			if (firstNewline !== -1 && firstNewline < raw.text.length - 1) {
				const dropped = byteLength(raw.text.slice(0, firstNewline + 1))
				textStart += dropped
				textByteLength -= dropped
			}
		}
		const { text } = entry.buffer.snapshotRange(textStart, textByteLength)
		const skippedUnseen = Math.max(0, textStart - unseenStart)
		return {
			text,
			nextCursor: appendedTotal,
			newBytes,
			omittedBytes: evictedUnseen + skippedUnseen,
			totalBytes: appendedTotal,
			state: entry.state,
			exitCode: entry.exitCode,
			reason: entry.reason,
		}
	}

	function markDelivered(handle: string, cursor: number): void {
		const entry = entries.get(handle)
		if (!entry) return
		if (cursor > entry.deliveredCursor) entry.deliveredCursor = cursor
	}

	async function kill(handle: string, reason = "stop"): Promise<void> {
		const entry = entries.get(handle)
		if (!entry) return
		killInternal(entry, reason)
		// Await abort settlement so callers observe the final exitCode/reason.
		await entry.execPromise.catch(() => {})
	}

	function whenExited(handle: string): Promise<{ exitCode: number | null }> {
		const entry = entries.get(handle)
		if (!entry) return Promise.resolve({ exitCode: null })
		return entry.execPromise
	}

	function getEntry(handle: string): Readonly<ProcessEntry> | undefined {
		return entries.get(handle)
	}

	function finalSnapshot(handle: string): FinalSnapshot | undefined {
		const entry = entries.get(handle)
		if (!entry) return undefined
		const snap = entry.accumulator.snapshot({ persistIfTruncated: true })
		// De-duplicate output the model already received at reviews: the
		// retained tail window may overlap the delivered stream range, so
		// drop the already-delivered prefix instead of re-sending it.
		const retainedStart = snap.truncation.totalBytes - byteLength(snap.content)
		const deliveredOverlap = entry.deliveredCursor - retainedStart
		const content = deliveredOverlap > 0 ? sliceBufferText(snap.content, deliveredOverlap) : snap.content
		return {
			content,
			truncation: snap.truncation,
			fullOutputPath: snap.fullOutputPath,
			state: entry.state,
			exitCode: entry.exitCode,
			reason: entry.reason,
		}
	}

	async function closeOutput(entry: ProcessEntry): Promise<void> {
		await entry.accumulator.closeTempFile().catch(() => {})
		const path = entry.accumulator.snapshot().fullOutputPath
		if (path) spillPaths.add(path)
	}

	async function remove(handle: string): Promise<void> {
		const entry = entries.get(handle)
		if (!entry) return
		await kill(handle)
		await closeOutput(entry)
		entries.delete(handle)
	}

	async function shutdown(): Promise<void> {
		const activeEntries = [...entries.values()]
		await Promise.all(activeEntries.map((entry) => kill(entry.handle)))
		await Promise.all(activeEntries.map(closeOutput))
		entries.clear()
		await Promise.allSettled([...spillPaths].map((p) => rm(p, { force: true })))
		spillPaths.clear()
	}

	return {
		spawn,
		snapshotTail,
		snapshotSince,
		markDelivered,
		finalSnapshot,
		kill,
		whenExited,
		getEntry,
		remove,
		shutdown,
		get size() {
			return entries.size
		},
	}
}
