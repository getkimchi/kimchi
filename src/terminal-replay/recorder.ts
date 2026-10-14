import { randomUUID } from "node:crypto"
import { appendFile, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import { gunzip, gzip } from "node:zlib"
import { lock } from "proper-lockfile"
import { recordingCheckpointInWorker } from "./checkpoint.js"
import type { ReplayTraceDetail } from "./details.js"
import { boundedTraceStep, type TraceStep } from "./trace.js"

const compress = promisify(gzip)
const decompress = promisify(gunzip)
const CHUNK_BYTES = 256 * 1024
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const SYNC_BEGIN = "\x1b[?2026h"

interface PendingTrace {
	step: TraceStep
	sequence: number
	observedUs: number
	bytes: number
}

/** A stalled disk must not hold up startup, session replacement or shutdown. */
export async function recordingDeadline<T>(operation: Promise<T>, timeoutMs = 1000): Promise<T | undefined> {
	let timer: NodeJS.Timeout | undefined
	try {
		return await Promise.race([
			operation,
			new Promise<undefined>((resolve) => {
				timer = setTimeout(() => resolve(undefined), timeoutMs)
			}),
		])
	} finally {
		clearTimeout(timer)
	}
}
export const RECORDING_LIMITS = {
	slots: 16,
	rawBytes: 32 * 1024 * 1024,
	compressedBytes: 8 * 1024 * 1024,
	queuedBytes: 1024 * 1024,
}

type RecordingStatus = "recording" | "complete" | "continued" | "size-limit" | "queue-limit" | "storage-error"
export interface RecordingMetadata {
	version: 1
	id: string
	sessionId: string
	pid: number
	startedAt: string
	status: RecordingStatus
	cols: number
	rows: number
	chunks: number
	rawBytes: number
	compressedBytes: number
	queueHighWaterBytes: number
	duration: number
	part?: number
}

export interface Recording {
	metadata: RecordingMetadata
	gzip: string
	traceDetails?: Record<string, ReplayTraceDetail>
	traceDetailsGzip?: string
	traceDetailsOmitted?: number
}

interface RecorderOptions {
	root: string
	sessionId: string
	cols: number
	rows: number
	limits?: Partial<typeof RECORDING_LIMITS>
	now?: () => number
}

async function readMetadata(directory: string): Promise<RecordingMetadata | undefined> {
	try {
		const value = JSON.parse(await readFile(join(directory, "metadata.json"), "utf8"))
		if (value.version === 1 && typeof value.id === "string" && typeof value.sessionId === "string") return value
	} catch {
		// A missing or damaged slot is reusable. Recording is best effort.
	}
}

function isLive(metadata: RecordingMetadata): boolean {
	if (metadata.pid <= 0 || !Number.isInteger(metadata.pid)) return false
	try {
		process.kill(metadata.pid, 0)
		return true
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM"
	}
}

/** Fixed slots bound aggregate disk usage, including simultaneous Kimchi processes. */
async function reserveSlot(options: RecorderOptions, slots: number): Promise<string> {
	await mkdir(options.root, { recursive: true, mode: 0o700 })
	const release = await lock(options.root, { retries: { retries: 3, minTimeout: 50, maxTimeout: 100 } })
	try {
		const candidates: { directory: string; at: number }[] = []
		for (let i = 0; i < slots; i++) {
			const directory = join(options.root, `slot-${i}`)
			const metadata = await readMetadata(directory)
			if (metadata && isLive(metadata)) continue
			candidates.push({ directory, at: metadata ? Date.parse(metadata.startedAt) : 0 })
			if (metadata && Date.now() - Date.parse(metadata.startedAt) > RETENTION_MS) {
				await rm(directory, { recursive: true, force: true })
			}
		}
		candidates.sort((a, b) => a.at - b.at)
		const slot = candidates[0]
		if (!slot) throw new Error("All terminal recording slots are in use")
		await rm(slot.directory, { recursive: true, force: true })
		await mkdir(slot.directory, { mode: 0o700 })
		// Publish ownership while still holding the allocation lock.
		await writeFile(
			join(slot.directory, "metadata.json"),
			JSON.stringify({
				version: 1,
				id: randomUUID(),
				sessionId: options.sessionId,
				pid: process.pid,
				startedAt: new Date().toISOString(),
			}),
			{ mode: 0o600 },
		)
		return slot.directory
	} finally {
		await release()
	}
}

/** Writes bounded, independently playable parts without making terminal writes wait. */
export class TerminalRecorder {
	metadata: RecordingMetadata
	private readonly limits: typeof RECORDING_LIMITS
	private readonly now: () => number
	private readonly started: number
	private readonly wallStartedMs: number
	private lastTimeUs = 0
	private lastEventWasMarker = false
	private partStartedUs = 0
	private queuedBytes = 0
	private pending: string[] = []
	private pendingBytes = 0
	private writing: Promise<void> = Promise.resolve()
	private timer: NodeJS.Timeout | undefined
	private closed = false
	private discardQueued = false
	private traceSequence = 0
	private traceBytes = 0
	private pendingTrace: PendingTrace[] = []
	private framedTrace: PendingTrace[] = []
	private syncTail = ""
	private syncOpen = false

	private constructor(
		public directory: string,
		private readonly options: RecorderOptions,
	) {
		this.limits = { ...RECORDING_LIMITS, ...options.limits }
		this.now = options.now ?? (() => performance.now())
		this.started = this.now()
		this.wallStartedMs = Date.now()
		this.metadata = {
			version: 1,
			id: randomUUID(),
			sessionId: options.sessionId,
			pid: process.pid,
			startedAt: new Date(this.wallStartedMs).toISOString(),
			status: "recording",
			cols: options.cols,
			rows: options.rows,
			chunks: 0,
			rawBytes: 0,
			compressedBytes: 0,
			queueHighWaterBytes: 0,
			duration: 0,
			part: 1,
		}
	}

	static async create(options: RecorderOptions): Promise<TerminalRecorder> {
		const directory = await reserveSlot(options, options.limits?.slots ?? RECORDING_LIMITS.slots)
		const recorder = new TerminalRecorder(directory, options)
		await recorder.saveMetadata()
		recorder.enqueue(
			`${JSON.stringify({ version: 3, term: { cols: options.cols, rows: options.rows }, timestamp: Date.now() / 1000 })}\n`,
		)
		await recorder.flush()
		return recorder
	}

	write(data: string): void {
		if (!data) return
		const watching = this.pendingTrace.length > 0 || this.framedTrace.length > 0
		const scan = watching ? this.syncTail + data : ""
		// A second synchronous frame must not overtake markers for the completed first frame.
		if (this.framedTrace.length && scan.includes(SYNC_BEGIN)) this.drainTrace(true)
		if (!this.event("o", data) || !watching) return
		// Both pinned Pi renderers wrap frames in synchronized output, possibly split across writes.
		// biome-ignore lint/suspicious/noControlCharactersInRegex: Recorded terminal frame delimiters.
		for (const match of scan.matchAll(/\x1b\[\?2026([hl])/g)) {
			if (match[1] === "h") this.syncOpen = true
			else if (this.syncOpen) {
				this.syncOpen = false
				if (!this.pendingTrace.length) continue
				this.framedTrace.push(...this.pendingTrace)
				this.pendingTrace = []
				// Main-screen rendering positions the cursor after the synchronized-output end.
				queueMicrotask(() => this.drainTrace(true))
			}
		}
		this.syncTail = scan.slice(-7)
	}

	trace(step: TraceStep): void {
		if (this.closed || this.metadata.status !== "recording") return
		const bounded = boundedTraceStep(step)
		const sequence = ++this.traceSequence
		const marker = {
			type: "kimchi.trace",
			version: 1,
			step: sequence,
			...bounded,
			frame: false,
			delayMs: Number.MAX_SAFE_INTEGER,
		}
		const bytes = Buffer.byteLength(JSON.stringify([Number.MAX_SAFE_INTEGER, "m", JSON.stringify(marker)])) + 1
		if (!this.hasCapacity(bytes)) return
		this.pendingTrace.push({ step: bounded, sequence, observedUs: this.elapsedUs(), bytes })
		this.traceBytes += bytes
		this.metadata.queueHighWaterBytes = Math.max(this.metadata.queueHighWaterBytes, this.queuedBytes + this.traceBytes)
	}

	/** Export and close need an explicit trace boundary; ordinary disk flushes do not. */
	finalizeTrace(): void {
		this.drainTrace(true)
		this.drainTrace(false)
	}

	private drainTrace(frame: boolean): void {
		const pending = frame ? this.framedTrace : this.pendingTrace
		if (frame) this.framedTrace = []
		else this.pendingTrace = []
		for (const item of pending) {
			this.traceBytes -= item.bytes
			const timeUs = this.elapsedUs()
			this.event(
				"m",
				JSON.stringify({
					type: "kimchi.trace",
					version: 1,
					step: item.sequence,
					...item.step,
					frame,
					delayMs: (timeUs - item.observedUs) / 1000,
				}),
				timeUs,
			)
		}
	}

	private elapsedUs(): number {
		return Math.max(this.lastTimeUs, Math.round((this.now() - this.started) * 1000))
	}

	resize(cols: number, rows: number): void {
		this.event("r", `${Math.max(1, cols)}x${Math.max(1, rows)}`)
	}

	private event(code: "o" | "r" | "m", data: string, observedUs?: number): boolean {
		if (this.closed || this.metadata.status !== "recording") return false
		// String length is a lower bound on encoded size. Reject huge writes before copying them into JSON.
		if (!this.hasCapacity(data.length)) return false
		// Round the absolute elapsed time, then subtract, so rounding cannot accumulate drift.
		let timeUs = observedUs ?? this.elapsedUs()
		// Seeking is time-based: a later frame must not share the preceding marker's timestamp.
		if (code !== "m" && this.lastEventWasMarker && timeUs === this.lastTimeUs) timeUs++
		const line = `${JSON.stringify([(timeUs - this.lastTimeUs) / 1_000_000, code, data])}\n`
		const previous = this.lastTimeUs
		this.lastTimeUs = timeUs
		if (!this.enqueue(line)) {
			this.lastTimeUs = previous
			return false
		}
		this.lastEventWasMarker = code === "m"
		return true
	}

	private hasCapacity(bytes: number): boolean {
		if (bytes > this.limits.rawBytes) {
			this.metadata.status = "size-limit"
			void this.flush()
			return false
		}
		if (this.queuedBytes + this.traceBytes + bytes > this.limits.queuedBytes) {
			this.metadata.status = "queue-limit"
			void this.flush()
			return false
		}
		return true
	}

	private enqueue(line: string): boolean {
		const bytes = Buffer.byteLength(line)
		if (!this.hasCapacity(bytes)) return false
		if (this.pendingBytes && this.pendingBytes + bytes > this.limits.rawBytes) void this.flush()
		this.pending.push(line)
		this.pendingBytes += bytes
		this.queuedBytes += bytes
		this.metadata.queueHighWaterBytes = Math.max(this.metadata.queueHighWaterBytes, this.queuedBytes + this.traceBytes)
		if (this.pendingBytes >= CHUNK_BYTES) void this.flush()
		else if (!this.timer) this.timer = setTimeout(() => void this.flush(), 1000).unref()
		return true
	}

	async flush(): Promise<void> {
		clearTimeout(this.timer)
		this.timer = undefined
		if (!this.pendingBytes && this.metadata.status === "recording") return this.writing
		const data = this.pending.join("")
		const bytes = this.pendingBytes
		const durationUs = this.lastTimeUs
		this.pending = []
		this.pendingBytes = 0
		this.writing = this.writing.then(async () => {
			try {
				if (data && !this.discardQueued && this.metadata.status !== "storage-error") {
					const compressed = await compress(data, { level: 1 })
					if (!this.fits(bytes, compressed.length) && !(await this.rotate(bytes, compressed.length))) {
						this.metadata.status = "size-limit"
						this.discardQueued = true
					} else {
						await this.appendChunk(compressed, bytes)
						this.metadata.duration = (durationUs - this.partStartedUs) / 1_000_000
					}
				}
				await this.saveMetadata()
			} catch {
				this.metadata.status = "storage-error"
			} finally {
				this.queuedBytes -= bytes
			}
		})
		await this.writing
	}

	private fits(rawBytes: number, compressedBytes: number): boolean {
		return (
			this.metadata.rawBytes + rawBytes <= this.limits.rawBytes &&
			this.metadata.compressedBytes + compressedBytes + 4 <= this.limits.compressedBytes
		)
	}

	private async appendChunk(compressed: Buffer, rawBytes: number): Promise<void> {
		// Length framing leaves an interrupted final chunk ignorable.
		const length = Buffer.alloc(4)
		length.writeUInt32BE(compressed.length)
		await appendFile(join(this.directory, "output.bin"), Buffer.concat([length, compressed]), { mode: 0o600 })
		this.metadata.chunks++
		this.metadata.compressedBytes += compressed.length + 4
		this.metadata.rawBytes += rawBytes
	}

	private async rotate(rawBytes: number, compressedBytes: number): Promise<boolean> {
		if (!this.metadata.chunks) return false
		const snapshot = await recordingCheckpointInWorker(this.directory, { ...this.metadata })
		const partStartedUs = this.partStartedUs + Math.round(this.metadata.duration * 1_000_000)
		const startedAtMs = this.wallStartedMs + partStartedUs / 1000
		const startedAt = new Date(startedAtMs).toISOString()
		const prefix = `${JSON.stringify({ version: 3, term: { cols: snapshot.cols, rows: snapshot.rows }, timestamp: startedAtMs / 1000 })}\n${JSON.stringify([0, "o", snapshot.data])}\n`
		const bytes = Buffer.byteLength(prefix)
		const compressed = await compress(prefix, { level: 1 })
		if (
			bytes + rawBytes > this.limits.rawBytes ||
			compressed.length + compressedBytes + 8 > this.limits.compressedBytes
		)
			return false
		await this.saveMetadata({ ...this.metadata, status: "continued", pid: 0 })
		this.directory = await reserveSlot(this.options, this.limits.slots)
		this.partStartedUs = partStartedUs
		this.metadata = {
			...this.metadata,
			id: randomUUID(),
			startedAt,
			cols: snapshot.cols,
			rows: snapshot.rows,
			part: (this.metadata.part ?? 1) + 1,
			chunks: 0,
			rawBytes: 0,
			compressedBytes: 0,
			duration: 0,
			queueHighWaterBytes: this.queuedBytes + this.traceBytes,
		}
		await this.appendChunk(compressed, bytes)
		return true
	}

	async close(): Promise<void> {
		if (this.closed) return this.writing
		this.finalizeTrace()
		this.event("o", "") // Preserve the final idle interval.
		this.closed = true
		await this.flush()
		if (this.metadata.status === "recording") this.metadata.status = "complete"
		this.metadata.pid = 0
		try {
			await this.saveMetadata()
		} catch {
			this.metadata.status = "storage-error"
		}
	}

	private async saveMetadata(metadata = this.metadata): Promise<void> {
		const file = join(this.directory, "metadata.json")
		await writeFile(`${file}.tmp`, JSON.stringify(metadata), { mode: 0o600 })
		await rename(`${file}.tmp`, file)
	}
}

export async function* recordingChunks(directory: string, metadata: RecordingMetadata): AsyncGenerator<Buffer> {
	if (metadata.compressedBytes > RECORDING_LIMITS.compressedBytes || metadata.rawBytes > RECORDING_LIMITS.rawBytes) {
		throw new Error("Recording exceeds its limit")
	}
	const encoded = await readFile(join(directory, "output.bin"))
	let offset = 0
	let remaining = RECORDING_LIMITS.rawBytes
	for (let i = 0; i < metadata.chunks; i++) {
		if (remaining <= 0) throw new Error("Recording exceeds its decoded limit")
		const length = encoded.readUInt32BE(offset)
		offset += 4
		if (offset + length > metadata.compressedBytes) throw new Error("Incomplete recording chunk")
		const decoded = await decompress(encoded.subarray(offset, offset + length), { maxOutputLength: remaining })
		offset += length
		remaining -= decoded.length
		yield decoded
	}
}

/** Read only committed chunks; an interrupted write cannot corrupt earlier frames. */
export async function readRecordings(root: string, sessionId: string): Promise<Recording[]> {
	let slots: string[]
	try {
		slots = await readdir(root)
	} catch {
		return []
	}
	const recordings: Recording[] = []
	const candidates = await Promise.all(
		slots
			.filter((name) => /^slot-\d+$/.test(name) && Number(name.slice(5)) < RECORDING_LIMITS.slots)
			.map(async (name) => ({
				directory: join(root, name),
				metadata: await readMetadata(join(root, name)),
			})),
	)
	candidates.sort((a, b) => (b.metadata?.startedAt ?? "").localeCompare(a.metadata?.startedAt ?? ""))
	for (const { directory, metadata } of candidates) {
		if (!metadata || metadata.sessionId !== sessionId || !metadata.chunks) continue
		if (Date.now() - Date.parse(metadata.startedAt) > RETENTION_MS) continue
		try {
			const chunks: Buffer[] = []
			for await (const chunk of recordingChunks(directory, metadata)) chunks.push(chunk)
			// Repack one part at a time; exports never retain every part decoded in memory.
			const gzip = (await compress(Buffer.concat(chunks), { level: 6 })).toString("base64")
			// Allocation can reuse a closed slot while an export is reading it.
			if ((await readMetadata(directory))?.id !== metadata.id) continue
			recordings.push({ metadata, gzip })
		} catch {
			// Missing/corrupt/evicted recordings do not break the conversation export.
		}
	}
	return recordings.reverse()
}
