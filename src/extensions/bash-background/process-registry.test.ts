/**
 * Unit tests for the background bash process registry.
 *
 * Uses a fake `BashOperations` that captures `onData`/`signal`/`timeout`
 * and can be driven deterministically (emit output, exit, observe abort)
 * so the registry's tail-window, incremental-snapshot, kill, and
 * safety-limit behaviour can be asserted without spawning real shells.
 */

import { existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createFakeOps } from "./__mocks__/fake-bash-ops.js"
import {
	createProcessRegistry,
	elapsedSecondsSince,
	OutputRingBuffer,
	SAFETY_LIMIT_REASON,
	summarizeCommand,
	type TailSnapshot,
} from "./process-registry.js"

const OPTS = { limitSeconds: 60 }

// ─── Tests ────────────────────────────────────────────────────────────────────

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllEnvs()
})

describe("summarizeCommand", () => {
	it("collapses whitespace and truncates long commands", () => {
		expect(summarizeCommand("pnpm   run\n\ttest")).toBe("pnpm run test")
		const long = `x `.repeat(100)
		const summary = summarizeCommand(long, 96)
		expect(summary.length).toBeLessThanOrEqual(96)
		expect(summary.endsWith("…")).toBe(true)
		expect(summary).not.toContain("\n")
	})
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

	it("tracks the absolute appended offset and retained start", () => {
		const buf = new OutputRingBuffer(10)
		buf.append(Buffer.from("aaaa"))
		buf.append(Buffer.from("bbbb"))
		expect(buf.appendedBytes).toBe(8)
		expect(buf.retainedStartOffset).toBe(0)
		buf.append(Buffer.from("cccc")) // evicts "aaaa"
		expect(buf.appendedBytes).toBe(12)
		expect(buf.retainedStartOffset).toBe(4)
	})

	it("snapshot smaller than buffer returns only what exists", () => {
		const buf = new OutputRingBuffer(64)
		buf.append(Buffer.from("abc"))
		expect(buf.snapshot(10).text).toBe("abc")
		expect(buf.snapshot(10).bytes).toBe(3)
	})

	it("snapshotRange walks forward from an absolute offset", () => {
		const buf = new OutputRingBuffer(64)
		buf.append(Buffer.from("hello "))
		buf.append(Buffer.from("world"))
		expect(buf.snapshotRange(0, 100).text).toBe("hello world")
		expect(buf.snapshotRange(6, 5).text).toBe("world")
		expect(buf.snapshotRange(3, 4).text).toBe("lo w")
		// Offsets past the end / zero-length windows are empty.
		expect(buf.snapshotRange(11, 5).text).toBe("")
		expect(buf.snapshotRange(0, 0).text).toBe("")
	})

	it("snapshotRange clamps a start offset before the retained window", () => {
		const buf = new OutputRingBuffer(8)
		buf.append(Buffer.from("aaaa"))
		buf.append(Buffer.from("bbbbbbbb")) // evicts "aaaa"; appended 12, retained start 4
		expect(buf.retainedStartOffset).toBe(4)
		expect(buf.snapshotRange(0, 100).text).toBe("bbbbbbbb")
		expect(buf.snapshotRange(6, 100).text).toBe("bbbbbb")
	})
})

describe("createProcessRegistry — spawn", () => {
	it("spawns via the injected ops and returns a handle", async () => {
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "echo hi", "/tmp", undefined, OPTS)

		expect(typeof handle).toBe("string")
		expect(ops.started).toHaveLength(1)
		expect(ops.started[0]?.command).toBe("echo hi")
		expect(ops.started[0]?.cwd).toBe("/tmp")
		// Background mode must not pass an upstream timeout.
		expect(ops.started[0]?.timeout).toBeUndefined()
		expect(registry.size).toBe(1)

		await registry.shutdown()
	})

	it("records identity and running state for a freshly spawned process", async () => {
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "sleep   1", "/tmp", undefined, OPTS)
		const entry = registry.getEntry(handle)
		expect(entry?.state).toBe("running")
		expect(entry?.exitCode).toBeNull()
		expect(entry?.commandSummary).toBe("sleep 1")
		expect(entry?.cwd).toBe("/tmp")
		expect(entry?.deliveredCursor).toBe(0)
		expect(entry?.lastOutputAtMs).toBeUndefined()
		await registry.shutdown()
	})

	it("derives the entry deadline from the configured limit", async () => {
		vi.useFakeTimers()
		const start = Date.now()
		vi.setSystemTime(start)
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "sleep 1", "/tmp", undefined, { limitSeconds: 120 })
		const entry = registry.getEntry(handle)
		expect(entry?.deadlineMs).toBe(start + 120_000)
		expect(entry?.deadlineSeconds).toBe(120)
		await registry.shutdown()
	})
})

describe("createProcessRegistry — spawnedAtMs / elapsed", () => {
	it("captures spawnedAtMs at spawn time", async () => {
		const now = Date.UTC(2025, 0, 1, 12, 0, 0)
		vi.setSystemTime(now)
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "sleep 1", "/tmp", undefined, OPTS)
		const entry = registry.getEntry(handle)
		expect(entry?.spawnedAtMs).toBe(now)
		expect(elapsedSecondsSince(entry?.spawnedAtMs ?? now)).toBe(0)
		vi.setSystemTime(now + 30_000)
		expect(elapsedSecondsSince(entry?.spawnedAtMs ?? now)).toBe(30)
		vi.useRealTimers()
		await registry.shutdown()
	})

	it("elapsedSecondsSince never goes negative under clock skew", () => {
		const future = Date.UTC(2030, 0, 1)
		expect(elapsedSecondsSince(future + 10_000)).toBe(0)
	})

	it("records the last-output timestamp when data arrives", async () => {
		vi.useFakeTimers()
		const start = Date.now()
		vi.setSystemTime(start)
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "yes", "/tmp", undefined, OPTS)
		expect(registry.getEntry(handle)?.lastOutputAtMs).toBeUndefined()
		vi.setSystemTime(start + 5_000)
		ops.emit("tick\n")
		expect(registry.getEntry(handle)?.lastOutputAtMs).toBe(start + 5_000)
		await registry.shutdown()
	})
})

describe("createProcessRegistry — snapshotTail", () => {
	it("returns a tail window of emitted output", async () => {
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "seq 100", "/tmp", undefined, OPTS)
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
		const handle = registry.spawn(ops, "yes", "/tmp", undefined, OPTS)
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
		const handle = registry.spawn(ops, "yes", "/tmp", undefined, OPTS)
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
		const handle = registry.spawn(ops, "yes", "/tmp", undefined, OPTS)

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

describe("createProcessRegistry — incremental snapshots", () => {
	it("returns only output appended since the last delivered cursor", async () => {
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "seq 3", "/tmp", undefined, OPTS)

		ops.emit("one\n")
		const first = registry.snapshotSince(handle)
		expect(first.text).toBe("one\n")
		expect(first.newBytes).toBe(4)
		expect(first.totalBytes).toBe(4)
		expect(first.omittedBytes).toBe(0)

		// Snapshot is pure: the cursor does not advance by reading.
		const reread = registry.snapshotSince(handle)
		expect(reread.text).toBe("one\n")

		registry.markDelivered(handle, first.nextCursor)
		ops.emit("two\n")
		const second = registry.snapshotSince(handle)
		expect(second.text).toBe("two\n")
		expect(second.newBytes).toBe(4)
		expect(second.totalBytes).toBe(8)

		registry.markDelivered(handle, second.nextCursor)
		const third = registry.snapshotSince(handle)
		expect(third.text).toBe("")
		expect(third.newBytes).toBe(0)
		expect(third.totalBytes).toBe(8)

		await registry.shutdown()
	})

	it("reports evicted unseen bytes as omitted", async () => {
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "yes", "/tmp", undefined, {
			limitSeconds: 60,
			maxBufferBytes: 16,
		})

		ops.emit("aaaaaaaa") // 8 retained, delivered cursor 0
		const first = registry.snapshotSince(handle)
		expect(first.text).toBe("aaaaaaaa")
		registry.markDelivered(handle, first.nextCursor) // cursor = 8

		ops.emit("bbbbbbbbbbbbbbbb") // 16B appended; total 24, retained last 16 ("bbbb..." starting at 8)
		const second = registry.snapshotSince(handle)
		expect(second.newBytes).toBe(16)
		expect(second.omittedBytes).toBe(0) // retained start is 8 == cursor
		expect(second.text).toBe("bbbbbbbbbbbbbbbb")

		registry.markDelivered(handle, second.nextCursor) // cursor = 24
		ops.emit("cccccccccccccccc") // total 40, retained start 24 (16 retained)
		// (ring capacity 16 → keeps last 16 bytes: the cccc chunk)
		const third = registry.snapshotSince(handle)
		expect(third.newBytes).toBe(16)
		expect(third.omittedBytes).toBe(0)
		expect(third.text).toBe("cccccccccccccccc")

		// Cursor far behind the retained start: the gap is reported omitted.
		registry.markDelivered(handle, 30) // mid-stream; monotonic cursor stays 24
		expect(registry.getEntry(handle)?.deliveredCursor).toBe(30)
		ops.emit("dddddddddddddddd") // total 56; retained start 40
		const gapped = registry.snapshotSince(handle)
		expect(gapped.omittedBytes).toBe(40 - 30)
		expect(gapped.text).toBe("dddddddddddddddd")

		await registry.shutdown()
	})

	it("counts unseen bytes skipped by the snapshot cap as omitted instead of silently dropping them", async () => {
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "yes", "/tmp", undefined, OPTS)

		// 500 unseen bytes, snapshot cap 100 → the newest 100 are shown and
		// the older 400 MUST be reported as omitted (not lost with omitted=0).
		ops.emit("a".repeat(500))
		const capped = registry.snapshotSince(handle, 100)
		expect(capped.newBytes).toBe(500)
		expect(capped.text).toBe("a".repeat(100))
		expect(capped.omittedBytes).toBe(400)
		expect(capped.nextCursor).toBe(500)

		registry.markDelivered(handle, capped.nextCursor)
		// Next burst of 150 unseen bytes, also exceeding the cap.
		ops.emit("b".repeat(150))
		const second = registry.snapshotSince(handle, 100)
		expect(second.newBytes).toBe(150)
		expect(second.text).toBe("b".repeat(100))
		expect(second.omittedBytes).toBe(50)

		await registry.shutdown()
	})

	it("starts a cap-truncated tail at a line boundary when possible", async () => {
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "yes", "/tmp", undefined, OPTS)

		ops.emit(`${"x".repeat(200)}\n${"y".repeat(359)}`) // 560 unseen bytes
		const capped = registry.snapshotSince(handle, 400)
		// Window [160..560); leading 41 bytes (40 x's + newline) are trimmed,
		// so the shown tail is exactly the y-run on its own line.
		expect(capped.text).toBe("y".repeat(359))
		expect(capped.omittedBytes).toBe(160 + 41)

		await registry.shutdown()
	})

	it("prepends the delivered head of the current line so mid-line snapshots keep context", async () => {
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "seq", "/tmp", undefined, OPTS)

		ops.emit("line1\npartial") // 13 bytes
		const first = registry.snapshotSince(handle)
		registry.markDelivered(handle, first.nextCursor) // cursor = 13

		ops.emit("-continued\n") // total 24; unseen is 11 bytes starting mid-line
		const overlapped = registry.snapshotSince(handle)
		expect(overlapped.text).toBe("partial-continued\n")
		expect(overlapped.newBytes).toBe(11)
		expect(overlapped.omittedBytes).toBe(0)

		// A cursor exactly at a line boundary gets no redundant overlap.
		registry.markDelivered(handle, overlapped.nextCursor) // cursor = 24
		ops.emit("next\n")
		const clean = registry.snapshotSince(handle)
		expect(clean.text).toBe("next\n")

		await registry.shutdown()
	})

	it("final snapshot de-duplicates the already-delivered prefix", async () => {
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "seq 2", "/tmp", undefined, OPTS)

		ops.emit("delivered-part\n")
		const first = registry.snapshotSince(handle)
		registry.markDelivered(handle, first.nextCursor)
		ops.emit("final-part\n")
		await ops.exit(0)
		await registry.whenExited(handle)

		const final = registry.finalSnapshot(handle)
		expect(final?.content).toBe("final-part\n")
		expect(final?.state).toBe("exited")
		expect(final?.exitCode).toBe(0)
	})
})

describe("createProcessRegistry — kill", () => {
	it("aborts the running process and marks it stopped with reason 'stop'", async () => {
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "sleep 100", "/tmp", undefined, OPTS)

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
		const handle = registry.spawn(ops, "true", "/tmp", undefined, OPTS)
		await ops.exit(0)
		await registry.whenExited(handle)
		expect(registry.getEntry(handle)?.state).toBe("exited")

		await registry.kill(handle)
		expect(ops.aborted).toBe(false)
		expect(registry.getEntry(handle)?.state).toBe("exited")
	})
})

describe("createProcessRegistry — safety limit", () => {
	it("auto-kills a running process when the limit passes", async () => {
		vi.useFakeTimers()
		const start = Date.now()
		vi.setSystemTime(start)
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "sleep 100", "/tmp", undefined, { limitSeconds: 5 })

		expect(registry.getEntry(handle)?.state).toBe("running")
		await vi.advanceTimersByTimeAsync(6_000)
		expect(registry.getEntry(handle)?.state).toBe("stopped")
		expect(registry.getEntry(handle)?.reason).toBe(SAFETY_LIMIT_REASON)
		expect(ops.aborted).toBe(true)

		await registry.shutdown()
	})
})

describe("createProcessRegistry — whenExited", () => {
	it("resolves with the exit code on natural exit", async () => {
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "true", "/tmp", undefined, OPTS)
		ops.emit("done\n")
		await ops.exit(0)
		const result = await registry.whenExited(handle)
		expect(result.exitCode).toBe(0)
		expect(registry.getEntry(handle)?.state).toBe("exited")
	})

	it("resolves with null exit code after a kill", async () => {
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "sleep 100", "/tmp", undefined, OPTS)
		await registry.kill(handle)
		const result = await registry.whenExited(handle)
		expect(result.exitCode).toBeNull()
	})
})

describe("createProcessRegistry — remove & shutdown", () => {
	it("remove kills a running process and drops the entry", async () => {
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "sleep 100", "/tmp", undefined, OPTS)
		expect(registry.size).toBe(1)
		await registry.remove(handle)
		expect(registry.size).toBe(0)
		expect(registry.getEntry(handle)).toBeUndefined()
	})

	it("shutdown kills every running entry and clears the registry", async () => {
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		registry.spawn(ops, "sleep 1", "/tmp", undefined, OPTS)
		registry.spawn(ops, "sleep 2", "/tmp", undefined, OPTS)
		expect(registry.size).toBe(2)
		await registry.shutdown()
		expect(registry.size).toBe(0)
		expect(ops.aborted).toBe(true)
	})

	it("shutdown deletes spill files for entries that were not removed", async () => {
		const ops = createFakeOps(0)
		const registry = createProcessRegistry()
		const handle = registry.spawn(ops, "yes", "/tmp", undefined, OPTS)
		ops.emit(Buffer.alloc(60_000, "x".charCodeAt(0)))
		const spillPath = registry.finalSnapshot(handle)?.fullOutputPath
		if (!spillPath) throw new Error("expected spill path")

		await registry.shutdown()

		expect(existsSync(spillPath)).toBe(false)
	})
})
