/**
 * Process registry for background bash execution.
 *
 * Spawns a command via an injected `BashOperations` (upstream
 * `createLocalBashOperations` in production) and keeps it running
 * independently of the agent loop. The bash tool's `execute` resolves at
 * each checkin with a tail-window of the buffered output plus the handle;
 * the `bash_control` tool then calls back into this registry to continue,
 * stop, or extend the deadline.
 *
 * Design notes:
 *  - The registry does NOT resolve on process exit. `ops.exec` is started
 *    without an upstream `timeout` (background mode manages its own
 *    deadline), and its promise is captured per entry so callers can race
 *    a checkin timer against natural exit via `whenExited`.
 *  - Killing is delegated to upstream: aborting the entry's
 *    `AbortController` triggers `killProcessTree` inside `exec` (see
 *    `createLocalBashOperations`), so detached grandchildren are reaped
 *    consistently with the synchronous bash path.
 *  - Output is held in a bounded ring buffer (last `maxBufferBytes`),
 *    so long-running commands cannot grow memory unbounded. Tail
 *    snapshots return the last `maxBytes` of that buffer.
 *  - Each entry has an absolute wall-clock `deadlineMs`. If it passes
 *    without a `continue`+`extend`, the registry auto-kills the process
 *    (reason `"deadline"`) so a stalled agent cannot leave a runaway
 *    process behind.
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

/** Default tail-window size (bytes) returned at each checkin. */
export const DEFAULT_TAIL_BYTES = 8192

export type ProcessState = "running" | "stopped" | "exited"

export interface SpawnOptions {
	/** Checkin cadence in seconds (informational; the tool arms the timer). */
	intervalSeconds: number
	/** Absolute wall-clock deadline in ms (Date.now() + ...). */
	deadlineMs: number
	/** Total seconds granted to the process (for timeout messages). Derived from deadlineMs when absent. */
	deadlineSeconds?: number
	/** Max bytes retained in the output ring buffer. */
	maxBufferBytes?: number
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
	state: ProcessState
	exitCode: number | null
	reason: string | null
	intervalSeconds: number
	deadlineMs: number
	deadlineSeconds: number
	readonly buffer: OutputRingBuffer
	readonly accumulator: OutputAccumulator
	readonly controller: AbortController
	rawExecPromise: Promise<{ exitCode: number | null }> | undefined
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

	constructor(capacity: number = DEFAULT_MAX_BUFFER_BYTES) {
		this.capacity = Math.max(0, Math.floor(capacity))
	}

	append(data: Buffer): void {
		if (data.length === 0 || this.capacity === 0) return
		this.chunks.push(data)
		this.totalBytes += data.length
		this.evict()
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
	/** Full output snapshot (truncated + temp-file spill, like upstream). */
	finalSnapshot(handle: string): FinalSnapshot | undefined
	/** Kill a running process and await abort settlement. `reason` defaults to "stop". */
	kill(handle: string, reason?: string): Promise<void>
	/** Push the deadline out by `addSeconds` and re-arm the deadline timer. */
	extend(handle: string, addSeconds: number): void
	/** Change the checkin cadence for a running process (applies at the next re-arm). */
	setIntervalSeconds(handle: string, seconds: number): void
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
			killInternal(entry, "deadline")
			return
		}
		entry.deadlineTimer = setTimeout(() => {
			killInternal(entry, "deadline")
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

		const entry: ProcessEntry = {
			handle,
			state: "running",
			exitCode: null,
			reason: null,
			intervalSeconds: opts.intervalSeconds,
			deadlineMs: opts.deadlineMs,
			deadlineSeconds: opts.deadlineSeconds ?? Math.max(0, Math.round((opts.deadlineMs - Date.now()) / 1000)),
			buffer,
			accumulator,
			controller,
			rawExecPromise: undefined as unknown as Promise<{ exitCode: number | null }>,
			execPromise: undefined as unknown as Promise<{ exitCode: number | null }>,
			deadlineTimer: undefined,
		}

		const rawExec = ops.exec(command, cwd, {
			onData: (data: Buffer) => {
				buffer.append(data)
				accumulator.append(data)
			},
			signal: controller.signal,
			// No upstream timeout: background mode manages its own deadline.
			timeout: undefined,
			env,
		})
		entry.rawExecPromise = rawExec
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

		entry.execPromise = execPromise
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

	async function kill(handle: string, reason = "stop"): Promise<void> {
		const entry = entries.get(handle)
		if (!entry) return
		killInternal(entry, reason)
		// Await abort settlement so callers observe the final exitCode/reason.
		await entry.execPromise.catch(() => {})
	}

	function extend(handle: string, addSeconds: number): void {
		const entry = entries.get(handle)
		if (!entry) return
		if (entry.state !== "running") return
		if (addSeconds > 0) {
			entry.deadlineMs += addSeconds * 1000
			entry.deadlineSeconds += addSeconds
		}
		armDeadline(entry)
	}

	function setIntervalSeconds(handle: string, seconds: number): void {
		const entry = entries.get(handle)
		if (!entry) return
		if (entry.state !== "running") return
		if (!Number.isFinite(seconds) || seconds <= 0) return
		entry.intervalSeconds = seconds
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
		return {
			content: snap.content,
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
		finalSnapshot,
		kill,
		extend,
		setIntervalSeconds,
		whenExited,
		getEntry,
		remove,
		shutdown,
		get size() {
			return entries.size
		},
	}
}
