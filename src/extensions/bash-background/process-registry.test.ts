/**
 * Unit tests for the background bash process registry.
 *
 * Uses a fake `BashOperations` that captures `onData`/`signal`/`timeout`
 * and can be driven deterministically (emit output, exit, observe abort)
 * so the registry's tail-window, kill, extend, and deadline behaviour
 * can be asserted without spawning real shells.
 */

import { existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BashOperations } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createProcessRegistry, OutputRingBuffer, type TailSnapshot } from "./process-registry.js"

// ─── Fake BashOperations ─────────────────────────────────────────────────────

interface FakeExec {
	command: string
	cwd: string
	env: NodeJS.ProcessEnv | undefined
	timeout: number | undefined
	signal: AbortSignal | undefined
	onData: (data: Buffer) => void
}

interface FakeOps extends BashOperations {
	/** Start a fake exec and capture its control surface. */
	started: FakeExec[]
	/** Resolve the pending exec with an exit code. */
	exit(code: number | null): Promise<void>
	/** Emit stdout/stderr bytes to the running exec. */
	emit(data: Buffer | string): void
	/** True if the exec's abort signal has been aborted. */
	aborted: boolean
}

function createFakeOps(_exitCode: number | null = 0): FakeOps {
	let settleExec: (r: { exitCode: number | null }) => void
	let rejectExec: (err: Error) => void
	const execPromise = new Promise<{ exitCode: number | null }>((resolve, reject) => {
		settleExec = resolve
		rejectExec = reject
	})
	const started: FakeExec[] = []
	let current: FakeExec | undefined
	let aborted = false

	const ops: FakeOps = {
		started,
		async exit(code: number | null) {
			settleExec({ exitCode: code })
			await execPromise
		},
		emit(data: Buffer | string) {
			const buf = typeof data === "string" ? Buffer.from(data) : data
			current?.onData(buf)
		},
		get aborted() {
			return aborted
		},
		exec: async (command, cwd, { onData, signal, timeout, env }) => {
			const exec: FakeExec = { command, cwd, env, timeout, signal, onData }
			current = exec
			started.push(exec)
			if (signal) {
				signal.addEventListener(
					"abort",
					() => {
						aborted = true
						// Mirror upstream: abort rejects the exec promise.
						rejectExec(new Error("aborted"))
					},
					{ once: true },
				)
			}
			return execPromise
		},
	}
	return ops
}

// ─── Tests ────────────────────────────────────────────────────────────────────

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllEnvs()
})

describe("OutputRingBuffer", () => {
	it("returns empty snapshot when nothing appended", () => {
		const buf = new OutputRingBuffer(64)
		expect(buf.snapshot(8)).toEqual({ text: "", bytes: 0 })
	})

	it("returns the last maxBytes of accumulated output", () => {
		const buf = new OutputRingBuffer(64)
		buf.append(Buffer.from("hello world"))
		expect(buf.snapshot(5).text).toBe("world")
		expect(buf.snapshot(5).bytes).toBe(5)
	})

	it("drops leading chunks when capacity exceeded", () => {
		const buf = new OutputRingBuffer(10)
		buf.append(Buffer.from("aaaa")) // 4
		buf.append(Buffer.from("bbbb")) // 8
		buf.append(Buffer.from("cccc")) // 12 -> evict "aaaa" -> 8, keep "bbbb"+"cccc"
		const snap = buf.snapshot(10)
		expect(snap.text).toBe("bbbbcccc")
		expect(snap.bytes).toBe(8)
	})

	it("keeps the tail of a single oversized chunk", () => {
		const buf = new OutputRingBuffer(4)
		buf.append(Buffer.from("abcdefgh")) // 8 -> keep last 4 "efgh"
		expect(buf.snapshot(4).text).toBe("efgh")
	})

	it("snapshot smaller than buffer returns only what exists", () => {
		const buf = new OutputRingBuffer(64)
		buf.append(Buffer.from("abc"))
		expect(buf.snapshot(10).text).toBe("abc")
		expect(buf.snapshot(10).bytes).toBe(3)
	})
})

describe("createProcessRegistry — spawn", () => {
	it("spawns via the injected ops and returns a handle", async () => {
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "echo hi", "/tmp", undefined, {
			intervalSeconds: 15,
			deadlineMs: Date.now() + 60_000,
		})

		expect(typeof handle).toBe("string")
		expect(ops.started).toHaveLength(1)
		expect(ops.started[0]?.command).toBe("echo hi")
		expect(ops.started[0]?.cwd).toBe("/tmp")
		// Background mode must not pass an upstream timeout.
		expect(ops.started[0]?.timeout).toBeUndefined()
		expect(registry.size).toBe(1)

		await registry.shutdown()
	})

	it("records running state for a freshly spawned process", async () => {
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "sleep 1", "/tmp", undefined, {
			intervalSeconds: 15,
			deadlineMs: Date.now() + 60_000,
		})
		const entry = registry.getEntry(handle)
		expect(entry?.state).toBe("running")
		expect(entry?.exitCode).toBeNull()
		await registry.shutdown()
	})
})

describe("createProcessRegistry — snapshotTail", () => {
	it("returns a tail window of emitted output", async () => {
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "seq 100", "/tmp", undefined, {
			intervalSeconds: 15,
			deadlineMs: Date.now() + 60_000,
		})
		ops.emit("line one\nline two\nline three\n")

		const snap: TailSnapshot = registry.snapshotTail(handle, 100)
		expect(snap.state).toBe("running")
		expect(snap.text).toContain("line three")
		expect(snap.bytes).toBeGreaterThan(0)

		await registry.shutdown()
	})

	it("returns only the last maxBytes of a long output", async () => {
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "yes", "/tmp", undefined, {
			intervalSeconds: 15,
			deadlineMs: Date.now() + 60_000,
		})
		ops.emit(Buffer.alloc(1000, "x".charCodeAt(0)))

		const snap = registry.snapshotTail(handle, 10)
		expect(snap.bytes).toBe(10)
		expect(snap.text).toBe("xxxxxxxxxx")
		await registry.shutdown()
	})

	it("returns a stopped/unknown snapshot for an unknown handle", () => {
		const registry = createProcessRegistry()
		const snap = registry.snapshotTail("nope")
		expect(snap.state).toBe("stopped")
		expect(snap.reason).toBe("unknown")
		expect(snap.text).toBe("")
	})

	it("returns a truncated final snapshot with a spill path", async () => {
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "yes", "/tmp", undefined, {
			intervalSeconds: 15,
			deadlineMs: Date.now() + 60_000,
		})
		ops.emit(Buffer.alloc(60_000, "x".charCodeAt(0)))
		await ops.exit(0)
		await registry.whenExited(handle)

		const snap = registry.finalSnapshot(handle)
		expect(snap?.truncation?.truncated).toBe(true)
		expect(snap?.content).toHaveLength(50_000)
		expect(snap?.fullOutputPath).toContain("pi-bash-")
		const spillPath = snap?.fullOutputPath
		if (!spillPath) throw new Error("expected spill path")

		await registry.remove(handle)
		expect(existsSync(spillPath)).toBe(true)
		await registry.shutdown()
		expect(existsSync(spillPath)).toBe(false)
	})

	it("creates a missing temp directory before spilling output", async () => {
		const missingTmpDir = join(tmpdir(), `missing-kimchi-dir-${Date.now()}`)
		vi.stubEnv("TMPDIR", missingTmpDir)
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "yes", "/tmp", undefined, {
			intervalSeconds: 15,
			deadlineMs: Date.now() + 60_000,
		})

		ops.emit(Buffer.alloc(60_000, "x".charCodeAt(0)))
		await new Promise((resolve) => setImmediate(resolve))

		const spillPath = registry.finalSnapshot(handle)?.fullOutputPath
		expect(spillPath).toContain(missingTmpDir)
		await registry.remove(handle)
		expect(existsSync(spillPath ?? "")).toBe(true)
		await registry.shutdown()
		rmSync(missingTmpDir, { recursive: true, force: true })
	})
})

describe("createProcessRegistry — kill", () => {
	it("aborts the running process and marks it stopped with reason 'stop'", async () => {
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "sleep 100", "/tmp", undefined, {
			intervalSeconds: 15,
			deadlineMs: Date.now() + 60_000,
		})

		await registry.kill(handle)

		expect(ops.aborted).toBe(true)
		const entry = registry.getEntry(handle)
		expect(entry?.state).toBe("stopped")
		expect(entry?.reason).toBe("stop")
	})

	it("kill on an unknown handle is a no-op", async () => {
		const registry = createProcessRegistry()
		await expect(registry.kill("nope")).resolves.toBeUndefined()
	})

	it("kill on an already-exited process does not re-abort", async () => {
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "true", "/tmp", undefined, {
			intervalSeconds: 15,
			deadlineMs: Date.now() + 60_000,
		})
		await ops.exit(0)
		await registry.whenExited(handle)
		// Process exited naturally.
		expect(registry.getEntry(handle)?.state).toBe("exited")

		await registry.kill(handle)
		// Aborted flag stays false — we did not abort an exited process.
		expect(ops.aborted).toBe(false)
		expect(registry.getEntry(handle)?.state).toBe("exited")
	})
})

describe("createProcessRegistry — extend", () => {
	it("pushes the deadline out and re-arms the timer without killing", async () => {
		vi.useFakeTimers()
		const start = Date.now()
		vi.setSystemTime(start)
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "sleep 100", "/tmp", undefined, {
			intervalSeconds: 15,
			deadlineMs: start + 10_000, // 10s deadline
		})

		const before = registry.getEntry(handle)?.deadlineMs
		registry.extend(handle, 30) // +30s
		const after = registry.getEntry(handle)?.deadlineMs
		expect(after).toBe(before !== undefined ? before + 30_000 : undefined)
		expect(registry.getEntry(handle)?.state).toBe("running")

		// Advancing past the original deadline (10s) must NOT kill —
		// the deadline was extended to 40s.
		await vi.advanceTimersByTimeAsync(12_000)
		expect(registry.getEntry(handle)?.state).toBe("running")

		// Advancing past the new deadline kills with reason 'deadline'.
		await vi.advanceTimersByTimeAsync(30_000)
		expect(registry.getEntry(handle)?.state).toBe("stopped")
		expect(registry.getEntry(handle)?.reason).toBe("deadline")

		await registry.shutdown()
	})

	it("extend on an unknown or non-running handle is a no-op", async () => {
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "true", "/tmp", undefined, {
			intervalSeconds: 15,
			deadlineMs: Date.now() + 60_000,
		})
		await ops.exit(0)
		await registry.whenExited(handle)
		const before = registry.getEntry(handle)?.deadlineMs
		registry.extend(handle, 99)
		expect(registry.getEntry(handle)?.deadlineMs).toBe(before)
		registry.extend("nope", 99) // no throw
	})
})

describe("createProcessRegistry — deadline", () => {
	it("auto-kills a running process when the deadline passes", async () => {
		vi.useFakeTimers()
		const start = Date.now()
		vi.setSystemTime(start)
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "sleep 100", "/tmp", undefined, {
			intervalSeconds: 15,
			deadlineMs: start + 5_000,
		})

		expect(registry.getEntry(handle)?.state).toBe("running")
		await vi.advanceTimersByTimeAsync(6_000)
		expect(registry.getEntry(handle)?.state).toBe("stopped")
		expect(registry.getEntry(handle)?.reason).toBe("deadline")
		expect(ops.aborted).toBe(true)

		await registry.shutdown()
	})
})

describe("createProcessRegistry — whenExited", () => {
	it("resolves with the exit code on natural exit", async () => {
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "true", "/tmp", undefined, {
			intervalSeconds: 15,
			deadlineMs: Date.now() + 60_000,
		})
		ops.emit("done\n")
		await ops.exit(0)
		const result = await registry.whenExited(handle)
		expect(result.exitCode).toBe(0)
		expect(registry.getEntry(handle)?.state).toBe("exited")
	})

	it("resolves with null exit code after a kill", async () => {
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "sleep 100", "/tmp", undefined, {
			intervalSeconds: 15,
			deadlineMs: Date.now() + 60_000,
		})
		await registry.kill(handle)
		const result = await registry.whenExited(handle)
		expect(result.exitCode).toBeNull()
	})
})

describe("createProcessRegistry — remove & shutdown", () => {
	it("remove kills a running process and drops the entry", async () => {
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "sleep 100", "/tmp", undefined, {
			intervalSeconds: 15,
			deadlineMs: Date.now() + 60_000,
		})
		expect(registry.size).toBe(1)
		await registry.remove(handle)
		expect(registry.size).toBe(0)
		expect(registry.getEntry(handle)).toBeUndefined()
	})

	it("shutdown kills every running entry and clears the registry", async () => {
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		registry.spawn(ops, "sleep 1", "/tmp", undefined, {
			intervalSeconds: 15,
			deadlineMs: Date.now() + 60_000,
		})
		registry.spawn(ops, "sleep 2", "/tmp", undefined, {
			intervalSeconds: 15,
			deadlineMs: Date.now() + 60_000,
		})
		expect(registry.size).toBe(2)
		await registry.shutdown()
		expect(registry.size).toBe(0)
		expect(ops.aborted).toBe(true)
	})

	it("shutdown deletes spill files for entries that were not removed", async () => {
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "yes", "/tmp", undefined, {
			intervalSeconds: 15,
			deadlineMs: Date.now() + 60_000,
		})
		ops.emit(Buffer.alloc(60_000, "x".charCodeAt(0)))
		const spillPath = registry.finalSnapshot(handle)?.fullOutputPath
		if (!spillPath) throw new Error("expected spill path")

		await registry.shutdown()

		expect(existsSync(spillPath)).toBe(false)
	})
})
