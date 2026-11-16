/**
 * Event-loop lag tracing — attribution for holds the UI actually feels.
 *
 * Enabled only when KIMCHI_LOOP_TRACE points at an ABSOLUTE file path (same
 * discipline as KIMCHI_SUBMIT_TIMING: relative values are refused loudly once,
 * the file is created 0o600, and without the env var every part is a no-op so
 * the extension registers unconditionally). Marks are one JSONL line each,
 * shaped like submit-timing's envelope (`{ ...detail, t, perf, seq, event }`)
 * so the same extractors read both files; there is no session stamp (a
 * splitter treats a missing session key as its own bucket).
 *
 * What it answers that per-site timing marks cannot: WHEN the event loop was
 * held and WHO held it, for holds anywhere in the process — including paths
 * nobody instrumented.
 *
 *   - `loop.lag`  — every watchdog gap over the threshold (40 ms default):
 *     { lagMs, cpuMs, eluUtil, beat, resType, where }
 *       cpuMs/eluUtil  — CPU consumed during the gap: a busy loop, not I/O wait.
 *       beat           — ticks a real worker thread kept while the main loop
 *                        stalled: ~lagMs/10 → process-wide (CPU saturation),
 *                        ~0 → event-loop-only (the common UI stall class).
 *       resType/where  — attribution: the async resource that was executing
 *                        when the loop went quiet, with its creation stack.
 *   - `loop.trace.arm` — once at startup, with the thresholds in effect.
 *
 * Attribution mechanics: async_hooks records every non-PROMISE resource's
 * creation stack at init and tracks which resource is executing. A
 * synchronous block freezes the loop mid-resource; when the watchdog fires
 * late, the resource still between before/after is the blocker, and its
 * creation stack names the scheduling site. PROMISE resources are tracked
 * for execution but not stack-captured (a stack per await would dominate the
 * cost of tracing); a block inside a promise continuation therefore
 * attributes to the enclosing timer/IO resource that started the chain —
 * which still names the subsystem that owns the hold.
 *
 * Flood protection: after 2,000 lag marks the sampler disarms itself (a
 * pathological loop must not fill the disk).
 */

import { createHook } from "node:async_hooks"
import { appendFileSync, chmodSync, mkdirSync, statSync } from "node:fs"
import { dirname, isAbsolute } from "node:path"
import { Worker } from "node:worker_threads"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

const LAG_THRESHOLD_MS = 40
const WATCHDOG_INTERVAL_MS = 10
const HEARTBEAT_INTERVAL_MS = 10
const MAX_LAG_MARKS = 2_000
const STACK_MAX_CHARS = 400

let seq = 0
let warnedPath = false

let warnedWrite = false
const ensuredPrivate = new Set<string>()

/** Node's ELU API is not in the DOM Performance typings; Bun implements it. */
interface EventLoopUtilization {
	utilization: number
}
type EluFn = (since?: EventLoopUtilization) => EventLoopUtilization
const eluFn = (performance as { eventLoopUtilization?: EluFn }).eventLoopUtilization?.bind(performance)

function writeMark(path: string, event: string, detail: Record<string, unknown>): void {
	try {
		if (!ensuredPrivate.has(path)) {
			mkdirSync(dirname(path), { recursive: true })
			appendFileSync(path, "", { mode: 0o600 })
			try {
				const mode = statSync(path).mode & 0o777
				if (mode & 0o077) chmodSync(path, 0o600)
			} catch {
				// A stat failure must not take the tracer down; the marks file is
				// diagnostics, not authority.
			}
			ensuredPrivate.add(path)
		}
		appendFileSync(
			path,
			`${JSON.stringify({ ...detail, t: Date.now(), perf: performance.now(), seq: seq++, event })}\n`,
		)
	} catch (error) {
		if (!warnedWrite) {
			warnedWrite = true
			console.error(`[loop-trace] cannot write marks: ${String(error)}`)
		}
	}
}

function truncateStack(stack: string): string {
	// Drop the async-hooks plumbing frames so the stack leads with the
	// scheduling site; the init hook itself and node's internals come first.
	const lines = stack
		.split("\n")
		.slice(1)
		.map((l) => l.trim().replace(/^at /, ""))
		.filter((l) => l && !l.includes("node:internal/async_hooks") && !l.includes("node:internal/process_task_queues"))
	return lines.slice(1, 7).join(" | ").slice(0, STACK_MAX_CHARS)
}

/**
 * Arm the tracer against a marks path. Pure side effect; exported for tests.
 * The async-hooks bookkeeping and the watchdog are process-global and
 * idempotent — a second call (jiti can load this module twice) is a no-op.
 */
export function armLoopTrace(path: string, maxLagMarks = MAX_LAG_MARKS): void {
	const g = globalThis as { __loopTraceArmed?: boolean }
	if (g.__loopTraceArmed) return
	g.__loopTraceArmed = true

	// --- Worker-thread heartbeat: ticks into shared memory while the main loop
	// runs or stalls, so each lag can be classed event-loop-only vs process-wide.
	const heartbeat = new Int32Array(new SharedArrayBuffer(4))
	try {
		const worker = new Worker(
			`const { parentPort } = require("node:worker_threads"); ` +
				`parentPort.on("message", (buffer) => { ` +
				`const a = new Int32Array(buffer); ` +
				`setInterval(() => Atomics.add(a, 0, 1), ${HEARTBEAT_INTERVAL_MS}) })`,
			{ eval: true },
		)
		worker.postMessage(heartbeat.buffer)
		worker.unref()
	} catch (error) {
		console.error(`[loop-trace] heartbeat worker failed: ${String(error)}`)
	}

	// --- Attribution: creation stacks for non-promise resources, plus which
	// resource is executing right now. A synchronous block leaves exactly one
	// resource between before/after — the blocker.
	const stacks = new Map<number, { type: string; where: string }>()
	let executing: { type: string; where: string } | undefined
	createHook({
		init(id, type) {
			if (type === "PROMISE") return
			// The creation stack is the scheduling site — the code that asked for
			// this timer/callback/IO, which is who the lag belongs to.
			stacks.set(id, { type, where: truncateStack(new Error().stack ?? "") })
		},
		before(id) {
			executing = stacks.get(id)
		},
		after() {
			executing = undefined
		},
		destroy(id) {
			stacks.delete(id)
		},
	}).enable()
	// Bound the bookkeeping: a long-lived process must not accumulate entries
	// for resources that never destroy (an index leak would grow unbounded).
	setInterval(() => {
		if (stacks.size > 4096) {
			stacks.clear()
			writeMark(path, "loop.trace.reset", { entries: stacks.size })
		}
	}, 60_000).unref()

	writeMark(path, "loop.trace.arm", {
		lagThresholdMs: LAG_THRESHOLD_MS,
		watchdogIntervalMs: WATCHDOG_INTERVAL_MS,
		heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
	})

	// --- In-process cause classification: GC pauses and heap shape at hold
	// time. Sandbox-immune (no process inspection, no interposition of sealed
	// module exports). A HOLD whose gcMs explains most of lagMs is a GC pause;
	// one with zero GC and cpuMs≈lagMs is genuine multi-threaded compute in
	// the process (sqlite, render, markdown) — the fork Tier-2 needs.
	const gc = { count: 0, ms: 0, byKind: {} as Record<string, { count: number; ms: number }> }
	let gcWarned = false
	try {
		const obs = new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				const kind =
					(entry as { detail?: { kind?: number } }).detail?.kind === 1
						? "scavenge"
						: (entry as { detail?: { kind?: number } }).detail?.kind === 2
							? "marksweep"
							: (entry as { detail?: { kind?: number } }).detail?.kind === 4
								? "incremental"
								: `kind${(entry as { detail?: { kind?: number } }).detail?.kind ?? "?"}`
				gc.count++
				gc.ms += entry.duration
				const k = gc.byKind[kind] ?? (gc.byKind[kind] = { count: 0, ms: 0 })
				k.count++
				k.ms += entry.duration
			}
		})
		obs.observe({ entryTypes: ["gc"] })
	} catch (error) {
		if (!gcWarned) {
			gcWarned = true
			console.error(`[loop-trace] gc observer unavailable: ${String(error)}`)
		}
	}

	// --- Lag watchdog: the sampler itself runs on the loop it measures; a gap
	// between its ticks is time the loop spent elsewhere.
	let last = performance.now()
	let lastCpu = process.cpuUsage()
	let lastElu: EventLoopUtilization | undefined
	let lastBeat = Atomics.load(heartbeat, 0)
	let lastGc = { count: 0, ms: 0, byKind: {} as Record<string, { count: number; ms: number }> }
	let marks = 0
	const timer = setInterval(() => {
		const now = performance.now()
		const lag = now - last - WATCHDOG_INTERVAL_MS
		if (lag > LAG_THRESHOLD_MS) {
			const cpu = process.cpuUsage(lastCpu)
			const elu = eluFn ? eluFn(lastElu) : { utilization: 0 }
			const beat = Atomics.load(heartbeat, 0)
			const mem = process.memoryUsage()
			writeMark(path, "loop.lag", {
				lagMs: Math.round(lag),
				cpuMs: Math.round(((cpu.user + cpu.system) / 1000) * 1000) / 1000,
				eluUtil: Math.round(elu.utilization * 1000) / 1000,
				beat: beat - lastBeat,
				gcCount: gc.count - lastGc.count,
				gcMs: Math.round((gc.ms - lastGc.ms) * 10) / 10,
				gcByKind: Object.fromEntries(
					Object.entries(gc.byKind).map(([kind, now]) => {
						const prev = lastGc.byKind[kind] ?? { count: 0, ms: 0 }
						return [kind, { count: now.count - prev.count, ms: Math.round((now.ms - prev.ms) * 10) / 10 }]
					}),
				),
				heapMb: Math.round(mem.heapUsed / 1048576),
				rssMb: Math.round(mem.rss / 1048576),
				externalMb: Math.round(mem.external / 1048576),
				resType: executing?.type,
				where: executing?.where,
			})
			lastGc = {
				count: gc.count,
				ms: gc.ms,
				byKind: Object.fromEntries(Object.entries(gc.byKind).map(([k, v]) => [k, { ...v }])),
			}
			if (++marks >= maxLagMarks) {
				writeMark(path, "loop.trace.disarm", { marks })
				clearInterval(timer)
			}
		}
		last = now
		lastCpu = process.cpuUsage()
		lastElu = eluFn?.()
		lastBeat = Atomics.load(heartbeat, 0)
	}, WATCHDOG_INTERVAL_MS)
	timer.unref()
}

export default function loopTraceExtension(_pi: ExtensionAPI): void {
	const path = process.env.KIMCHI_LOOP_TRACE
	if (!path) return
	if (!isAbsolute(path)) {
		if (!warnedPath) {
			warnedPath = true
			console.error(`[loop-trace] KIMCHI_LOOP_TRACE must be an absolute path, ignoring: ${path}`)
		}
		return
	}
	armLoopTrace(path)
}
