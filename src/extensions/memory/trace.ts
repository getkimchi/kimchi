/**
 * Per-drain trace recording for the memory capture worker — the data
 * source behind `kimchi memory dashboard`.
 *
 * One append-only JSONL file per drain at `~/.config/kimchi/memory/traces/
 * drain-<isotime>-<pid>.jsonl`: every phase's exact input/output during a
 * drain — the full chat API request text and complete response (both
 * extraction passes, the chat supersede judge), every d3 decision call
 * (full state, every question asked, every answer with probabilities and
 * confidence), and every local store decision (triage/valuation skips with
 * probabilities, durability-regex name, redaction before→after, oversized,
 * exact-dup, near-dup score+twin, supersede deletions).
 *
 * Contract (mirrors usage-ledger.ts): tracing is always-on, **fail-soft,
 * and never throws into the drain** — an unwritable traces dir logs once
 * per outage streak and the drain continues untraced. Events are appended
 * as complete newline-terminated JSON objects (one appendFileSync each);
 * readers parse line-by-line and silently drop an unparseable line, which
 * is exactly what a crash mid-append or a dashboard reading while the
 * worker writes produces — a crashed worker still leaves a
 * partially-readable, fully truthful drain.
 *
 * Retention is a ring of the newest TRACE_DRAINS_KEPT drains, pruned at
 * worker start (KIMCHI_MEMORY_TRACE_DRAINS overrides; 0 disables tracing
 * entirely). Files record raw, pre-redaction text — a local-only debug
 * surface, same exposure class as the memory store directory itself.
 *
 * Scope: capture drains AND the session recall path (digest computation,
 * turn recall, memory_search calls). Recall traces are one compact record
 * per event — the raw chat/d3 request-response traffic stays exclusive to
 * drains so session traffic never pays drain-scale bytes.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { basename, join, resolve, sep } from "node:path"
import { defaultMemoryDir } from "./backend.js"
import { TRACE_DRAINS_KEPT, TRACE_RECALLS_KEPT } from "./config.js"

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

let warnedBroken = false

function traceBrokenWarning(err: unknown, what: string): void {
	if (warnedBroken) return
	warnedBroken = true
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
}

/**
 * Create the recorder for one drain. Returns null when tracing is disabled
 * (KIMCHI_MEMORY_TRACE_DRAINS=0) or the traces dir cannot be created —
 * callers treat null as "emit nothing".
 */
export function createTraceRecorder(): TraceRecorder | null {
	if (traceDrainKeep() === 0) return null
	try {
		const dir = tracesDir()
		mkdirSync(dir, { recursive: true })
		// ':' sanitised out of the ISO time: portable filenames everywhere.
		const stamp = new Date().toISOString().replace(/[:.]/g, "-")
		const file = join(dir, `drain-${stamp}-${process.pid}.jsonl`)
		return {
			file,
			emit(event) {
				try {
					const line = { ts: new Date().toISOString(), ...event }
					appendFileSync(file, `${JSON.stringify(line)}\n`, "utf-8")
				} catch (err) {
					traceBrokenWarning(err, "drain")
				}
			},
		}
	} catch (err) {
		traceBrokenWarning(err, "drain")
		return null
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
		const files = readdirSync(dir)
			.filter((name) => name.startsWith("drain-") && name.endsWith(".jsonl"))
			.sort()
		for (const name of files.slice(0, Math.max(0, files.length - keep))) {
			try {
				rmSync(join(dir, name), { force: true })
			} catch (err) {
				traceBrokenWarning(err, "drain ring")
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
	const dir = resolve(tracesDir(root))
	const resolved = resolve(dir, name)
	if (!resolved.startsWith(dir + sep)) return null
	if (!existsSync(resolved)) return null
	return resolved
}

/** Oldest-to-newest drain file listing (names only) — the dashboard's
 * /api/traces source; readers reverse for newest-first. */
export function listTraceFiles(root?: string): string[] {
	try {
		const dir = tracesDir(root)
		if (!existsSync(dir)) return []
		return readdirSync(dir)
			.filter((name) => name.startsWith("drain-") && name.endsWith(".jsonl"))
			.sort()
	} catch {
		// Unreadable dir → empty list; the dashboard shows "no drains".
		return []
	}
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
export function createRecallRecorder(): TraceRecorder | null {
	if (traceRecallKeep() === 0) return null
	try {
		const dir = tracesDir()
		mkdirSync(dir, { recursive: true })
		const stamp = new Date().toISOString().replace(/[:.]/g, "-")
		const file = join(dir, `recall-${stamp}-${process.pid}-${recallFileCounter++}.jsonl`)
		pruneRecallTraces()
		return {
			file,
			emit(event) {
				try {
					const line = { ts: new Date().toISOString(), ...event }
					appendFileSync(file, `${JSON.stringify(line)}\n`, "utf-8")
				} catch (err) {
					traceBrokenWarning(err, "recall")
				}
			},
		}
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
		const files = readdirSync(dir)
			.filter((name) => name.startsWith("recall-") && name.endsWith(".jsonl"))
			.sort()
		for (const name of files.slice(0, Math.max(0, files.length - keep))) {
			try {
				rmSync(join(dir, name), { force: true })
			} catch (err) {
				traceBrokenWarning(err, "recall ring")
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
