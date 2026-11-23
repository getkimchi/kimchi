/**
 * Per-drain trace recording for the memory capture worker — the data
 * source behind `kimchi memory dashboard`.
 *
 * One append-only JSONL file (plus bounded partitions when needed) per
 * drain/recall. Compact mode records phase, decision, latency, counts,
 * outcome and stable text hashes; no raw prompt or response by default.
 * KIMCHI_MEMORY_TRACE_EXCHANGES=full opts into raw exchanges with the shared
 * redactor (redact: false explicitly preserves raw values).
 *
 * Bounded queueing, write deadlines and per-file/aggregate byte pruning keep
 * observability off the critical capture path. Dropped, failed and unflushed
 * counts are explicit: crash/replayed history is best-effort, never claimed
 * complete. JSONL readers retain partial/corrupt-line tolerance and legacy
 * record compatibility.
 *
 * Scope: capture drains AND the session recall path (digest computation,
 * turn recall, memory_search calls). Recall traces are one compact record
 * per event — the raw chat/d3 request-response traffic stays exclusive to
 * drains so session traffic never pays drain-scale bytes.
 */
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { appendFile } from "node:fs/promises"
import { basename, dirname, join, resolve, sep } from "node:path"
import { defaultMemoryDir } from "./backend.js"
import { TRACE_DRAINS_KEPT, TRACE_RECALLS_KEPT } from "./config.js"
import type { RecallCancellationReason } from "./deadline.js"

/** Drain trace directory — exported for the dashboard and tests. The
 * `root` override exists for the dashboard's injected memory root
 * (its tests serve fixture traces from a temp dir). */
export function tracesDir(root: string = defaultMemoryDir()): string {
	return join(root, "traces")
}

/**
 * A single trace event. Every event carries `ts` (ISO); the rest is
 * per-type payload. `type` values: drain_start, job, api, phase, job_end,
 * drain_end — see capture-worker.ts for the payload of each. Kept as an
 * open shape: this is a debug surface cross-read by a web UI, so a rigid
 * GraphQL-ish schema buys nothing over JSON-discriminated objects.
 */
export interface TraceEvent {
	type: string
	ts: string
	[key: string]: unknown
}

/**
 * The request/response payloads an onExchange hook records around one HTTP
 * call. Chat completions record
 * `{ request: { model, system, user }, response: { content, usage } }`;
 * d3 calls record `{ request: { model, state, questions },
 * response: { id, model, answers, usage } }`. Failures record
 * `error`/`status` instead of `response`.
 */
export interface ApiExchange {
	request: Record<string, unknown>
	response?: Record<string, unknown>
	error?: string
	status?: number
	/** Complete request lifecycle, including retries, not just the last HTTP attempt. */
	durationMs?: number
	cancelled?: RecallCancellationReason
}

/** Optional per-call observability hook on chatJson/decide. Only the
 * capture worker sets it (drain-site injection): the session turn path
 * passes nothing and changes no behavior. */
export type OnExchange = (exchange: ApiExchange) => void

/**
 * How many drains the ring keeps. KIMCHI_MEMORY_TRACE_DRAINS: a
 * non-negative integer overrides the default; "0" disables tracing;
 * anything else falls back to TRACE_DRAINS_KEPT.
 */
export function traceDrainKeep(): number {
	const raw = process.env.KIMCHI_MEMORY_TRACE_DRAINS
	if (raw === undefined || raw.trim() === "") return TRACE_DRAINS_KEPT
	const parsed = Number(raw)
	if (!Number.isFinite(parsed) || parsed < 0) return TRACE_DRAINS_KEPT
	return Math.floor(parsed)
}

const warnedRoots = new Set<string>()

function traceBrokenWarning(err: unknown, what: string, root = "global"): void {
	if (warnedRoots.has(root)) return
	if (warnedRoots.size >= 32) warnedRoots.delete(warnedRoots.values().next().value as string)
	warnedRoots.add(root)
	console.warn(`[memory-trace] trace store unavailable (${what} not traced until it recovers):`, err)
}

/** Recorder input: any payload with a `type`; `ts` is stamped at emit. */
export type TraceEventInput = Record<string, unknown> & { type: string }

export interface TraceRecorder {
	/** Absolute path of this drain's JSONL file. */
	file: string
	/**
	 * Append one event (ts stamped here); never throws. A write failure
	 * logs once and the drain continues untraced — observability must not
	 * break capture.
	 */
	emit(event: TraceEventInput): void
	/** Wait only for bounded writer progress, never an unbounded I/O tail. */
	flush?: () => Promise<void>
	stats?: () => TraceWriteStats
}

export interface TraceWriteStats {
	dropped: number
	failed: number
	unflushed: number
	/** Appends whose deadline elapsed but whose eventual outcome is unknown. */
	timedOut: number
	bytes: number
}

export interface TraceRecorderOptions {
	rawExchanges?: boolean
	redact?: boolean
	maxFileBytes?: number
	maxPending?: number
	writeTimeoutMs?: number
	append?: (file: string, body: string) => Promise<void> | void
}

const RAW_TEXT_LIMIT = 32_768
const HASHED_TEXT = new Set(["fact", "text", "query", "memory", "system", "user", "state", "prompt", "instructions"])
const CATEGORY_TEXT = new Set([
	"type",
	"kind",
	"phase",
	"trigger",
	"reason",
	"conclusion",
	"status",
	"model",
	"job",
	"store",
	"session",
	"recall_id",
	"factId",
	"selectedIds",
	"injectedIds",
	"scheduledStep",
	"root",
	"rootScope",
	"source",
	"error",
])

function hashText(text: string): string {
	return createHash("sha256").update(text).digest("hex").slice(0, 16)
}

/** Stable compact representation used by pre-ID recall records. */
export function traceTextHash(text: string): string {
	return hashText(text)
}

function traceValue(value: unknown, key: string, raw: boolean, seen = new WeakSet<object>(), depth = 0): unknown {
	if (typeof value === "string") {
		if (!raw && HASHED_TEXT.has(key)) return hashText(value)
		const text = raw ? value.slice(0, RAW_TEXT_LIMIT) : CATEGORY_TEXT.has(key) ? value.slice(0, 160) : hashText(value)
		return value.length > RAW_TEXT_LIMIT
			? { text, textTruncated: true, textBytes: Buffer.byteLength(value), hash: hashText(value) }
			: text
	}
	if (typeof value === "number" || typeof value === "boolean" || value === null) return value
	if (typeof value === "bigint") return String(value)
	if (typeof value !== "object" || value === undefined) return undefined
	if (seen.has(value) || depth >= 5) return { hash: hashText(JSON.stringify(value)) }
	seen.add(value)
	if (Array.isArray(value)) {
		if (!raw && key === "jobFiles") {
			return { count: value.length, samples: value.slice(0, 16).map((item) => basename(String(item)).slice(0, 160)) }
		}
		const items = value.slice(0, raw ? 64 : 8).map((item) => traceValue(item, key, raw, seen, depth + 1))
		return value.length > (raw ? 64 : 8) ? { items, truncated: value.length - (raw ? 64 : 8) } : items
	}
	const out: Record<string, unknown> = {}
	for (const [childKey, child] of Object.entries(value).slice(0, 64)) {
		const mapped = traceValue(child, childKey, raw, seen, depth + 1)
		if (mapped !== undefined) out[childKey] = mapped
	}
	return out
}

function compactTraceEvent(event: TraceEventInput, raw: boolean): TraceEventInput {
	const trimmed = traceValue(event, "", raw) as TraceEventInput
	if (raw || event.type !== "api") return { ts: new Date().toISOString(), ...trimmed }
	const requestBytes = Buffer.byteLength(JSON.stringify(event.request ?? {}))
	const responseBytes = Buffer.byteLength(JSON.stringify(event.response ?? {}))
	const request = event.request as Record<string, unknown> | undefined
	const response = event.response as Record<string, unknown> | undefined
	return {
		ts: new Date().toISOString(),
		...trimmed,
		request: { model: request?.model, requestBytes },
		response: response ? { usage: response.usage, responseBytes } : { responseBytes },
	}
}

class BoundedTraceWriter implements TraceRecorder {
	file: string
	private readonly batchFile: string
	private readonly options: Required<TraceRecorderOptions>
	private pending: TraceEventInput[] = []
	private timer?: ReturnType<typeof setTimeout>
	private active?: Promise<void>
	private activeCount = 0
	private dropped = 0
	private failed = 0
	private timedOut = 0
	private bytes = 0
	private part = 0
	private retryAt = 0

	constructor(file: string, options: TraceRecorderOptions) {
		this.file = file
		this.batchFile = file.replace(/\.jsonl$/, "")
		this.options = {
			rawExchanges: options.rawExchanges ?? process.env.KIMCHI_MEMORY_TRACE_EXCHANGES === "full",
			redact: options.redact ?? process.env.KIMCHI_MEMORY_TRACE_REDACT !== "0",
			maxFileBytes: Math.max(128, options.maxFileBytes ?? 262_144),
			maxPending: Math.max(1, options.maxPending ?? 128),
			writeTimeoutMs: Math.max(1, options.writeTimeoutMs ?? 50),
			append: options.append ?? ((path, body) => appendFile(path, body, "utf-8")),
		}
	}

	stats(): TraceWriteStats {
		return {
			dropped: this.dropped,
			failed: this.failed,
			unflushed: this.pending.length + this.activeCount,
			timedOut: this.timedOut,
			bytes: this.bytes,
		}
	}

	emit(event: TraceEventInput): void {
		if (Date.now() < this.retryAt) {
			this.dropped += 1
			return
		}
		if (this.pending.length + this.activeCount >= this.options.maxPending) {
			this.dropped += 1
			return
		}
		try {
			this.pending.push(compactTraceEvent(event, this.options.rawExchanges))
			this.schedule()
		} catch (err) {
			this.failed += 1
			traceBrokenWarning(err, "event serialization")
		}
	}

	async flush(): Promise<void> {
		clearTimeout(this.timer)
		this.timer = undefined
		const deadline = Date.now() + this.options.writeTimeoutMs
		while (this.pending.length > 0 || this.active) {
			if (Date.now() >= deadline) return
			if (!this.active && this.pending.length > 0) void this.writeBatch()
			if (this.active && !(await this.waitForActive(deadline))) return
		}
	}

	private waitForActive(deadline: number): Promise<boolean> {
		const active = this.active
		if (!active) return Promise.resolve(true)
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(false), Math.max(1, deadline - Date.now()))
			timer.unref()
			active.then(
				() => {
					clearTimeout(timer)
					resolve(true)
				},
				() => {
					clearTimeout(timer)
					resolve(true)
				},
			)
		})
	}

	private schedule(): void {
		if (this.timer || this.active) return
		this.timer = setTimeout(() => {
			this.timer = undefined
			void this.writeBatch()
		}, 5)
		this.timer.unref()
	}

	private async writeBatch(): Promise<void> {
		if (this.active) return this.active
		if (this.pending.length === 0 || Date.now() < this.retryAt) return
		const batch = this.pending.splice(0, 64)
		this.activeCount = batch.length
		// Each append gets its own timeout; serialization time is not an I/O stall.
		const remaining = (): number => this.options.writeTimeoutMs
		this.active = (async () => {
			try {
				let body = ""
				for (const rawEvent of batch) {
					const event =
						this.options.rawExchanges && this.options.redact
							? await (await import("../pii-redaction/redactor.js")).redactObjectStrings(rawEvent)
							: rawEvent
					const serialized = JSON.stringify(event)
					const bytes = Buffer.byteLength(serialized)
					const line =
						bytes > this.options.maxFileBytes
							? `${JSON.stringify({
									type: rawEvent.type,
									kind: rawEvent.kind,
									recall_id: rawEvent.recall_id,
									truncated: true,
									originalBytes: bytes,
									hash: hashText(serialized),
								})}\n`
							: `${serialized}\n`
					const length = Buffer.byteLength(line)
					if (this.bytes + length > this.options.maxFileBytes && body.length > 0) {
						await this.appendBounded(this.file, body, remaining())
						body = ""
						this.part += 1
						this.file = `${this.batchFile}.part-${this.part}.jsonl`
						this.bytes = 0
					}
					body += line
					this.bytes += length
				}
				if (this.dropped + this.failed > 0) {
					const stats = `${JSON.stringify({ type: "trace_stats", ts: new Date().toISOString(), dropped: this.dropped, failed: this.failed, unflushed: this.pending.length, timedOut: this.timedOut })}\n`
					body += stats
					this.bytes += Buffer.byteLength(stats)
				}
				await this.appendBounded(this.file, body, remaining())
			} catch (err) {
				this.failed += batch.length
				this.retryAt = Date.now() + 250
				traceBrokenWarning(err, "bounded write")
			} finally {
				this.activeCount = 0
			}
		})().finally(() => {
			this.active = undefined
			if (this.pending.length > 0) this.schedule()
		})
		return this.active
	}

	private async appendBounded(file: string, body: string, remainingMs: number): Promise<void> {
		if (!body) return
		let timer: ReturnType<typeof setTimeout> | undefined
		const deadline = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => reject(new Error("memory trace append deadline exceeded")), Math.max(1, remainingMs))
		})
		let operation: Promise<void> | undefined
		try {
			operation = Promise.resolve(this.options.append(file, body))
			await Promise.race([operation, deadline])
			warnedRoots.delete(dirname(file))
		} catch (error) {
			if (operation && error instanceof Error && error.message === "memory trace append deadline exceeded") {
				this.timedOut += 1
				void operation
					.finally(() => {
						this.timedOut = Math.max(0, this.timedOut - 1)
					})
					.catch(() => undefined)
			}
			throw error
		} finally {
			if (timer) clearTimeout(timer)
		}
	}
}

/**
 * Create the recorder for one drain. Returns null when tracing is disabled
 * (KIMCHI_MEMORY_TRACE_DRAINS=0) or the traces dir cannot be created —
 * callers treat null as "emit nothing".
 */
let drainFileSequence = 0

export function createTraceRecorder(options: TraceRecorderOptions = {}): TraceRecorder | null {
	if (traceDrainKeep() === 0) return null
	try {
		const dir = tracesDir()
		mkdirSync(dir, { recursive: true })
		const stamp = new Date().toISOString().replace(/[:.]/g, "-")
		const file = join(dir, `drain-${stamp}-${process.pid}-${drainFileSequence++}.jsonl`)
		return new BoundedTraceWriter(file, options)
	} catch (err) {
		traceBrokenWarning(err, "drain", tracesDir())
		return null
	}
}

interface TraceGroup {
	name: string
	files: Array<{ path: string; bytes: number }>
}

function traceGroups(prefix: "drain" | "recall", dir: string): TraceGroup[] {
	const groups = new Map<string, TraceGroup>()
	for (const name of readdirSync(dir)) {
		if (!name.startsWith(prefix) || !name.endsWith(".jsonl")) continue
		const logical = drainLogicalName(name)
		const path = join(dir, name)
		const child = { path, bytes: statSync(path).size }
		const group = groups.get(logical) ?? { name: logical, files: [] }
		group.files.push(child)
		groups.set(logical, group)
	}
	return [...groups.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Enforce aggregate bytes per logical record, not per partition. */
export function pruneTraceBudget(maxBytes = 8 * 1024 * 1024, root = defaultMemoryDir()): void {
	try {
		const dir = tracesDir(root)
		if (!existsSync(dir)) return
		const groups = [...traceGroups("drain", dir), ...traceGroups("recall", dir)]
		let bytes = 0
		for (const group of groups.reverse()) {
			bytes += group.files.reduce((sum, file) => sum + file.bytes, 0)
			if (bytes > maxBytes) {
				for (const file of group.files) rmSync(file.path, { force: true })
			}
		}
	} catch (err) {
		traceBrokenWarning(err, "trace byte budget")
	}
}

/** Ring enforcement: keep the newest `keep` drain files by name (names are
 * timestamp-prefixed, so lexical order is chronological), delete the rest.
 * Fail-soft: a deletion failure logs once and leaves the file (disk usage
 * is a quality concern, never a drain-correctness one). */
export function pruneTraces(keep = traceDrainKeep()): void {
	if (keep <= 0) return
	try {
		const dir = tracesDir()
		if (!existsSync(dir)) return
		for (const group of traceGroups("drain", dir).slice(0, Math.max(0, traceGroups("drain", dir).length - keep))) {
			for (const file of group.files) {
				try {
					rmSync(file.path, { force: true })
				} catch (err) {
					traceBrokenWarning(err, "drain ring")
				}
			}
		}
	} catch (err) {
		traceBrokenWarning(err, "drain ring")
	}
}

/**
 * Tolerant JSONL reader: returns every parseable line as an event,
 * silently skipping unparseable ones. The canonical partial line is the
 * trailing one (crash mid-append, or read-while-writing), but skipping is
 * per-line — a corrupt middle line costs one event, never the drain.
 */
export function readTraceEvents(file: string): TraceEvent[] {
	let text: string
	try {
		text = readFileSync(file, "utf-8")
	} catch {
		// Unreadable file (deleted mid-read, replaced by a directory) — the
		// dashboard shows an empty drain, never a crash.
		return []
	}
	const events: TraceEvent[] = []
	for (const line of text.split("\n")) {
		if (!line.trim()) continue
		try {
			const parsed: unknown = JSON.parse(line)
			if (parsed && typeof parsed === "object" && typeof (parsed as TraceEvent).type === "string") {
				events.push(parsed as TraceEvent)
			}
		} catch {
			// Partial line (crash tail / read-while-write) or corrupt event —
			// skip it; the dashboard degrades to the complete prefix.
		}
	}
	return events
}

/**
 * Resolve a dashboard-supplied trace filename to an absolute path inside
 * `traces/` — or null when the name is not a legitimate drain file
 * (basename mismatch, wrong prefix/suffix, path traversal).
 */
export function resolveTraceFile(name: string, root: string = defaultMemoryDir()): string | null {
	if (typeof name !== "string" || name.length === 0) return null
	if (basename(name) !== name) return null
	if (!name.startsWith("drain-") || !name.endsWith(".jsonl")) return null
	const logical = drainLogicalName(name)
	const dir = resolve(tracesDir(root))
	const file = listTracePartitions(root).find((entry) => basename(drainLogicalName(entry.path)) === logical)
	if (!file || !resolve(file.path).startsWith(dir + sep)) return null
	return file.path
}

/** Logical drains — one record with all of its ordered partitions. */
export interface TracePartition {
	path: string
	part: number
	mtimeMs: number
}

function drainLogicalName(name: string): string {
	return name.replace(/\.part-\d+\.jsonl$/, ".jsonl")
}

function listTracePartitions(root?: string): TracePartition[] {
	const dir = tracesDir(root)
	if (!existsSync(dir)) return []
	return readdirSync(dir)
		.filter((name) => name.startsWith("drain-") && name.endsWith(".jsonl"))
		.map((name) => {
			const file = join(dir, name)
			const part = Number(name.match(/\.part-(\d+)\.jsonl$/)?.[1] ?? 0)
			return { path: file, part, mtimeMs: traceFileMtime(file) }
		})
		.sort((a, b) => drainLogicalName(a.path).localeCompare(drainLogicalName(b.path)) || a.part - b.part)
}

/** Oldest-to-newest logical record names (partitions are not separate drains). */
export function listTraceFiles(root?: string): string[] {
	try {
		return [...new Set(listTracePartitions(root).map((entry) => basename(drainLogicalName(entry.path))))].sort()
	} catch {
		return []
	}
}

/** Read one logical drain across its ordered partition sequence. */
export function readDrainEvents(name: string, root = defaultMemoryDir()): TraceEvent[] {
	if (typeof name !== "string" || basename(name) !== name || !name.startsWith("drain-") || !name.endsWith(".jsonl"))
		return []
	return listTracePartitions(root)
		.filter((entry) => basename(drainLogicalName(entry.path)) === name)
		.flatMap((entry) => readTraceEvents(entry.path))
}

/** Latest partition mtime for one logical drain. */
export function traceDrainMtime(name: string, root = defaultMemoryDir()): number {
	return listTracePartitions(root)
		.filter((entry) => basename(drainLogicalName(entry.path)) === name)
		.reduce((latest, entry) => Math.max(latest, entry.mtimeMs), 0)
}

/** Best-effort mtime for a drain file (0 when unreadable — sorts old). */
export function traceFileMtime(file: string): number {
	try {
		return statSync(file).mtimeMs
	} catch {
		return 0
	}
}

/**
 * Recall traces — the retrieval side: `recall-<isotime>-<pid>-<n>.jsonl`,
 * one small file per digest computation, turn recall/search, or
 * memory_search call. Same fail-soft contract as drain traces. Recall
 * events fire per prompt, so the ring defaults to a hundred files and
 * KIMCHI_MEMORY_TRACE_RECALLS overrides (0 disables).
 */
let recallFileCounter = 0

/** How many recall traces the ring keeps (KIMCHI_MEMORY_TRACE_RECALLS). */
export function traceRecallKeep(): number {
	const raw = process.env.KIMCHI_MEMORY_TRACE_RECALLS
	if (raw === undefined || raw.trim() === "") return TRACE_RECALLS_KEPT
	const parsed = Number(raw)
	if (!Number.isFinite(parsed) || parsed < 0) return TRACE_RECALLS_KEPT
	return Math.floor(parsed)
}

/** Create the recorder for one recall event; null when disabled or the
 * traces dir is unwritable. Prunes the recall ring on creation so the
 * directory cannot grow unboundedly between dashboard visits. */
export function createRecallRecorder(options: TraceRecorderOptions = {}): TraceRecorder | null {
	if (traceRecallKeep() === 0) return null
	try {
		const dir = tracesDir()
		mkdirSync(dir, { recursive: true })
		const stamp = new Date().toISOString().replace(/[:.]/g, "-")
		const file = join(dir, `recall-${stamp}-${process.pid}-${recallFileCounter++}.jsonl`)
		pruneRecallTraces()
		return new BoundedTraceWriter(file, options)
	} catch (err) {
		traceBrokenWarning(err, "recall")
		return null
	}
}

/** Ring enforcement for recall files (name-sorted = chronological). */
export function pruneRecallTraces(keep = traceRecallKeep()): void {
	if (keep <= 0) return
	try {
		const dir = tracesDir()
		if (!existsSync(dir)) return
		for (const group of traceGroups("recall", dir).slice(0, Math.max(0, traceGroups("recall", dir).length - keep))) {
			for (const file of group.files) {
				try {
					rmSync(file.path, { force: true })
				} catch (err) {
					traceBrokenWarning(err, "recall ring")
				}
			}
		}
	} catch (err) {
		traceBrokenWarning(err, "recall ring")
	}
}

/** Oldest-to-newest recall file listing (names only) — the dashboard's
 * /api/recalls source. */
export function listRecallFiles(root?: string): string[] {
	try {
		const dir = tracesDir(root)
		if (!existsSync(dir)) return []
		return readdirSync(dir)
			.filter((name) => name.startsWith("recall-") && name.endsWith(".jsonl"))
			.sort()
	} catch {
		return []
	}
}

/** Resolve a dashboard-supplied recall filename to an absolute path inside
 * `traces/` — same traversal defense as resolveTraceFile. */
export function resolveRecallFile(name: string, root: string = defaultMemoryDir()): string | null {
	if (typeof name !== "string" || name.length === 0) return null
	if (basename(name) !== name) return null
	if (!name.startsWith("recall-") || !name.endsWith(".jsonl")) return null
	const dir = resolve(tracesDir(root))
	const resolved = resolve(dir, name)
	if (!resolved.startsWith(dir + sep)) return null
	if (!existsSync(resolved)) return null
	return resolved
}

/** Resolve a dashboard-supplied pending-job filename to an absolute path
 * inside `pending/` — same traversal defense as resolveTraceFile/
 * resolveRecallFile: basename-only, .json suffix, resolved-inside check,
 * and the name must appear in the pending dir listing (no path joins on
 * untrusted input). */
export function resolvePendingJobFile(name: string, root: string = defaultMemoryDir()): string | null {
	if (typeof name !== "string" || name.length === 0) return null
	if (basename(name) !== name) return null
	if (!name.endsWith(".json")) return null
	const dir = resolve(join(root, "pending"))
	const resolved = resolve(dir, name)
	if (!resolved.startsWith(dir + sep)) return null
	try {
		if (!readdirSync(dir).includes(name)) return null
	} catch {
		return null
	}
	return resolved
}
