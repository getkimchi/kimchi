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
import { isAbsolute, dirname } from "node:path"
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

function snapshotChildren(me: number): { pid: number; cpu: number; cmd: string }[] {
	try {
		const { execSync } = require("node:child_process")
		const out = execSync(`ps -eo pid,ppid,cpu,command -p $(pgrep -P ${me} | tr '\n' ',' | sed 's/,$//')`, {
			encoding: "utf-8",
			timeout: 500,
			windowsHide: true,
		})
		const rows: { pid: number; cpu: number; cmd: string }[] = []
		for (const line of out.split("\n").slice(1)) {
			const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)/)
			if (m) rows.push({ pid: Number(m[1]), cpu: Number(m[3]), cmd: m[4].slice(0, 60) })
		}
		return rows.sort((a, b) => b.cpu - a.cpu).slice(0, 8)
	} catch {
		return []
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

	// --- On-hold children CPU snapshot: for each hold, run a synchronous
	// `ps -o pid,ppid,cpu` bounded to children of this process — the only
	// sampling that works across ALL spawn paths without requiring in-process
	// interposition. Cost: spawn per ~lag, bounded.
	// Node >=20 seals node:child_process.exports.spawn (writable:false but
	// configurable:true) — plain assignment fails silently in a lib that cannot
	// tell. Object.defineProperty lands the shim and stays functionally equivalent.
	try {
		const cp = require("node:child_process") as { spawn: (...a: unknown[]) => unknown }
		const spawn = cp.spawn
		Object.defineProperty(cp, "spawn", {
			configurable: true,
			enumerable: true,
			get() {
				return function spawnTraced(command: unknown, args?: unknown, options?: unknown) {
					const child = spawn.call(cp, command as never, args as never, options as never) as {
						pid?: number
						on(event: "exit", cb: () => void): unknown
						cpuUsage: { user: number; system: number }
					}
					child.on("exit", () => {
						try {
							writeMark(path, "loop.channel.cpu", {
								pid: child.pid,
								cmd: String(command).split("/").pop()?.slice(0, 80),
								cpuMs: Math.round(((child.cpuUsage.user + child.cpuUsage.system) / 1000) * 1000) / 1000,
							})
						} catch {
							// tangential diagnostics must never break the spawn path
						}
					})
					return child
				}
			},
		})
	} catch {
		// spawn hook is best-effort diagnostics
	}


	// --- Lag watchdog: the sampler itself runs on the loop it measures; a gap
	// between its ticks is time the loop spent elsewhere.
	let last = performance.now()
	let lastCpu = process.cpuUsage()
	let lastElu: EventLoopUtilization | undefined
	let lastBeat = Atomics.load(heartbeat, 0)
	let marks = 0
	const timer = setInterval(() => {
		const now = performance.now()
		const lag = now - last - WATCHDOG_INTERVAL_MS
		if (lag > LAG_THRESHOLD_MS) {
			const cpu = process.cpuUsage(lastCpu)
			const elu = eluFn ? eluFn(lastElu) : { utilization: 0 }
			const beat = Atomics.load(heartbeat, 0)
			const children = snapshotChildren(process.pid)
			writeMark(path, "loop.lag", {
				lagMs: Math.round(lag),
				cpuMs: Math.round(((cpu.user + cpu.system) / 1000) * 1000) / 1000,
				eluUtil: Math.round(elu.utilization * 1000) / 1000,
				beat: beat - lastBeat,
				resType: executing?.type,
				where: executing?.where,
				children: children.length ? children.slice(0, 4).map((c) => ({ pid: c.pid, cpu: c.cpu, cmd: c.cmd.slice(0, 60) })) : undefined,
			})
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
