/**
 * Per-block CPU instruction tracing, independent of subsystem identity.
 *
 * Enabled only when KIMCHI_BLOCKING_INSTRUMENT is an absolute file path.
 * One bounded in-memory series and one `blocking.instr.summary` mark contain
 * async execution spans' main-thread instruction deltas (async_hooks
 * before/after, promise continuations included). There are deliberately no
 * function names or per-subsystem counters: attribution is a separate concern.
 *
 * Production uses Linux's per-thread perf counter through Bun FFI. Diagnostics
 * never infer instructions from CPU time. Library/platform failures are marked
 * unsupported/error; scenario parsing treats them as missing measurements.
 */
import { createHook } from "node:async_hooks"
import { appendFileSync, chmodSync, mkdirSync, statSync } from "node:fs"
import { dirname, isAbsolute } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

// Matches tools/perf/sampler.py: attr through bp_len, instruction event,
// exclude_hv. x86-64 and arm64 have different syscall numbers; the CI class's
// per-process source is the latter, the container smoke test the former.
const PERF_ATTR_SIZE = 80
const PERF_TYPE_HARDWARE = 0
const PERF_COUNT_HW_INSTRUCTIONS = 1
const PERF_FLAG_EXCLUDE_HV = 1 << 6
const MAX_BELOW_CAP_SAMPLES = 100_000

interface InstructionCounter {
	read(): number
	close(): void
}
type CounterFactory = () => { counter?: InstructionCounter; reason?: string }

interface NativeSymbols {
	syscall(...args: unknown[]): number | bigint
	read(fd: number, buffer: number, length: number): number | bigint
	close(fd: number): number
}
interface FfiLibrary {
	symbols: NativeSymbols
	close(): void
}
interface FfiApi {
	dlopen(path: string, symbols: Record<string, unknown>): FfiLibrary
	ptr(view: ArrayBufferView): number
}

/** Linux per-thread retired-instructions counter. No dlopen is attempted elsewhere. */
export function openInstructionCounter(): { counter?: InstructionCounter; reason?: string } {
	if (process.platform !== "linux") return { reason: `unsupported platform: ${process.platform}` }
	if (!process.versions.bun) return { reason: "requires Bun for the Linux perf counter" }
	try {
		const ffi = require("bun:ffi") as FfiApi
		const lib = ffi.dlopen("libc.so.6", {
			syscall: { args: ["i64", "ptr", "i32", "i32", "i32", "u32"], returns: "i64" },
			read: { args: ["i32", "ptr", "u64"], returns: "i64" },
			close: { args: ["i32"], returns: "i32" },
		})
		const attr = Buffer.alloc(128)
		attr.writeUInt32LE(PERF_TYPE_HARDWARE, 0)
		attr.writeUInt32LE(PERF_ATTR_SIZE, 4)
		attr.writeBigUInt64LE(BigInt(PERF_COUNT_HW_INSTRUCTIONS), 8)
		attr.writeBigUInt64LE(BigInt(PERF_FLAG_EXCLUDE_HV), 16)
		const call = process.arch === "arm64" ? 241 : process.arch === "x64" ? 298 : undefined
		if (call === undefined) {
			lib.close()
			return { reason: `unsupported architecture: ${process.arch}` }
		}
		// The process leader's tid equals its pid: this is the event-loop thread,
		// not worker threads that the existing cgroup counter already handles.
		const fd = Number(lib.symbols.syscall(call, ffi.ptr(attr), process.pid, -1, -1, 0))
		if (fd < 0) {
			lib.close()
			return { reason: "perf_event_open failed (no per-thread PMU access)" }
		}
		const value = Buffer.alloc(8)
		return {
			counter: {
				read() {
					const bytes = Number(lib.symbols.read(fd, ffi.ptr(value), value.length))
					if (bytes !== value.length) throw new Error("perf counter read failed")
					return Number(value.readBigUInt64LE(0))
				},
				close() {
					lib.symbols.close(fd)
					lib.close()
				},
			},
		}
	} catch (error) {
		return { reason: `could not create perf counter: ${String(error)}` }
	}
}

interface Handle {
	close(): void
}
interface Trace extends Handle {
	counter: InstructionCounter
	hook: { disable(): void }
	values: number[]
	done: boolean
}

export function summarizeBlockingInstructions(values: readonly number[], truncated = false): Record<string, unknown> {
	const sorted = [...values].sort((a, b) => a - b)
	return {
		samples: values.length,
		total: values.reduce((sum, value) => sum + value, 0),
		max: sorted.at(-1) ?? 0,
		p95: sorted.length ? sorted[maxIndex(sorted.length, 0.95)] : 0,
		truncated,
	}
}
function maxIndex(length: number, fraction: number): number {
	return Math.max(0, Math.ceil(length * fraction) - 1)
}

/** Instrument one process using the given backend factory; test-injectable without Bun. */
export function instrumentBlockingInstructions(path: string, factory: CounterFactory = openInstructionCounter): Handle {
	const { counter, reason } = factory()
	if (!counter) {
		writeMark(path, "blocking.instr.unsupported", { reason: reason ?? "counter unavailable" })
		return { close: noop }
	}
	const entered = new Map<number, number>()
	const values: number[] = []
	let insideTrace = false
	let failed = false
	let truncated = false
	const failedOnce = (error: unknown) => {
		if (failed) return
		failed = true
		writeMark(path, "blocking.instr.error", { reason: String(error) })
	}
	const enter = (id: number) => {
		if (insideTrace || failed || truncated) return
		insideTrace = true
		try {
			entered.set(id, counter.read())
		} catch (error) {
			failedOnce(error)
		} finally {
			insideTrace = false
		}
	}
	const leave = (id: number) => {
		if (insideTrace || failed || truncated) return
		const begin = entered.get(id)
		if (begin === undefined) return
		insideTrace = true
		try {
			const instructions = counter.read() - begin
			if (instructions < 0) throw new Error("CPU instruction counter moved backwards")
			if (values.length >= MAX_BELOW_CAP_SAMPLES) {
				truncated = true
				writeMark(path, "blocking.instr.truncated", { samples: values.length })
			} else values.push(instructions)
		} catch (error) {
			failedOnce(error)
		} finally {
			insideTrace = false
			entered.delete(id)
		}
	}
	const hook = createHook({
		before: enter,
		after: leave,
		promiseResolve: leave,
		destroy(id) {
			entered.delete(id)
		},
	}).enable()
	writeMark(path, "blocking.instr.arm", { backend: "linux-thread-perf", pid: process.pid })
	const trace: Trace = {
		counter,
		hook,
		values,
		done: false,
		close() {
			if (this.done) return
			this.done = true
			hook.disable()
			writeMark(path, "blocking.instr.summary", summarizeBlockingInstructions(values, truncated))
			counter.close()
		},
	}
	return trace
}

function noop(): void {}
let warnedWrite = false
function writeMark(path: string, event: string, detail: Record<string, unknown>): void {
	try {
		mkdirSync(dirname(path), { recursive: true })
		appendFileSync(path, "", { mode: 0o600 })
		const mode = statSync(path).mode & 0o777
		if (mode & 0o077) chmodSync(path, 0o600)
		appendFileSync(path, `${JSON.stringify({ ...detail, event, t: Date.now(), pid: process.pid })}\n`)
	} catch (error) {
		if (warnedWrite) return
		warnedWrite = true
		console.error(`[blocking-instructions] cannot write trace: ${String(error)}`)
	}
}

interface SharedTrace extends Handle {
	refs: number
	trace: Handle
}
interface GlobalTraceRegistry {
	blockingInstructions?: Map<string, SharedTrace>
}
const globalRegistry = globalThis as GlobalTraceRegistry

/** Process-wide sharing prevents jiti duplicate loads opening duplicate PMUs. */
export function armBlockingInstructions(path: string): Handle {
	let map = globalRegistry.blockingInstructions
	if (!map) {
		map = new Map()
		globalRegistry.blockingInstructions = map
	}
	const existing = map.get(path)
	if (existing) {
		existing.refs++
		return existing
	}
	const trace = instrumentBlockingInstructions(path)
	const release = (): void => {
		const current = map.get(path)
		if (current !== shared) return
		current.refs = current.refs - 1
		if (current.refs === 0) {
			map.delete(path)
			trace.close()
		}
	}
	const shared: SharedTrace = { refs: 1, trace, close: release }
	map.set(path, shared)
	return shared
}

export default function blockingInstructionsExtension(pi: ExtensionAPI): void {
	const path = process.env.KIMCHI_BLOCKING_INSTRUMENT
	if (!path) return
	if (!isAbsolute(path)) {
		console.error(`[blocking-instructions] KIMCHI_BLOCKING_INSTRUMENT must be an absolute path, ignoring: ${path}`)
		return
	}
	const handle = armBlockingInstructions(path)
	pi.on("session_shutdown", () => handle.close())
}
