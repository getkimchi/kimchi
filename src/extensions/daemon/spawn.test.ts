/**
 * Integration tests for detached daemon spawn/stop (`spawn.ts`).
 *
 * Uses REAL processes (`sleep` / `bash`) in a temp state dir: the core
 * guarantees here — survival past the spawning shell, process-group
 * identity, instant-crash detection, log capture — are meaningless behind
 * a fake child_process. POSIX-only: Windows detachment semantics differ
 * (`detached: true` without setsid) and the benchmark targets are Linux
 * containers anyway; CI exercises the POSIX path.
 *
 * Cleanup: afterEach force-kills every recorded pid so a failing test
 * can't leak sleeps into CI.
 */

import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { readLogTail, spawnDaemon, stopDaemon } from "./spawn.js"
import { isPidAlive, listDaemons, readDaemon } from "./state.js"

// All nested child-process work here is POSIX (kill, negative pid groups).
const describePosix = process.platform === "win32" ? describe.skip : describe

const SHORT_GRACE = 100

describePosix("spawnDaemon / stopDaemon (real processes)", () => {
	let dir: string
	const livePids: number[] = []

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "daemon-spawn-test-"))
	})

	afterEach(() => {
		for (const pid of livePids) {
			try {
				process.kill(-pid, "SIGKILL")
			} catch {
				// Already gone — fine for teardown.
			}
		}
		livePids.length = 0
		rmSync(dir, { recursive: true, force: true })
	})

	it("spawns a detached process that survives its spawning shell", async () => {
		const outcome = await spawnDaemon({
			command: "sleep 60",
			cwd: dir,
			name: "test-sleeper",
			stateDir: dir,
			crashGraceMs: SHORT_GRACE,
		})
		expect(outcome.ok).toBe(true)
		if (!outcome.ok) return
		livePids.push(outcome.record.pid)

		const { record } = outcome
		expect(record.id).toMatch(/^test-sleeper-[0-9a-f]{6}$/)
		expect(isPidAlive(record.pid)).toBe(true)
		// The pid is the process-group leader (detached: true → setsid). The
		// command itself may exec-replace that leader or leave a thin shell
		// wrapper behind — group kill behaves the same either way.
		expect(readFileSync(record.pidFile, "utf8")).toBe(String(record.pid))
		const recordOnDisk = readDaemon(dir, record.id)
		expect(recordOnDisk).toEqual(record)
	})

	it("detects instant crashes inside the grace window and surfaces the log", async () => {
		const outcome = await spawnDaemon({
			command: "echo boot-failed-message; exit 3",
			cwd: dir,
			name: "crasher",
			stateDir: dir,
			crashGraceMs: SHORT_GRACE,
		})
		expect(outcome.ok).toBe(false)
		if (outcome.ok) return
		expect(outcome.error).toContain("exited immediately")
		expect(outcome.error).toContain("boot-failed-message")
		// No record left behind for a failed spawn.
		expect(listDaemons(dir)).toEqual([])
	})

	it("treats an empty command as missing", async () => {
		const outcome = await spawnDaemon({
			command: "",
			cwd: dir,
			stateDir: dir,
			crashGraceMs: SHORT_GRACE,
		})
		expect(outcome.ok).toBe(false)
		if (outcome.ok) return
		expect(outcome.error).toContain("Empty command")
	})

	it("captures the daemon's output into its log file", async () => {
		const outcome = await spawnDaemon({
			command: "bash -c 'echo daemon-booted; exec sleep 60'",
			cwd: dir,
			name: "logger",
			stateDir: dir,
			crashGraceMs: SHORT_GRACE,
		})
		expect(outcome.ok).toBe(true)
		if (!outcome.ok) return
		livePids.push(outcome.record.pid)

		// Wait for output with a hard cutoff — polling without a limit is a
		// review-lessons violation and hangs CI when the daemon is broken.
		const deadline = Date.now() + 3000
		let tail: string | undefined
		while (Date.now() < deadline) {
			tail = readLogTail(outcome.record.logFile)
			if (tail?.includes("daemon-booted")) break
			await new Promise((r) => setTimeout(r, 50))
		}
		expect(tail).toContain("daemon-booted")
	})

	it("stopDaemon kills the whole process group (children included)", async () => {
		// Grandchild demonstates the setsid problem in reverse: without a
		// process GROUP kill, only the leader would die and `sleep` would
		// leak. The daemon here spawns a child sleep of its own. Located via
		// pgrep — shell $! expansion would fight the JSON/bash -c quoting
		// layers in spawn().
		const outcome = await spawnDaemon({
			command: "bash -c 'sleep 333 & wait'",
			cwd: dir,
			name: "parent",
			stateDir: dir,
			crashGraceMs: SHORT_GRACE,
		})
		expect(outcome.ok).toBe(true)
		if (!outcome.ok) return
		livePids.push(outcome.record.pid)

		// Bounded poll for the grandchild to appear in the process table.
		const deadline = Date.now() + 3000
		let childPid: number | undefined
		while (Date.now() < deadline) {
			const found = Number(
				// -fx: match the full cmdline exactly so the parent's
				// `bash -c 'sleep 333 & wait'` cmdline doesn't self-match.
				(spawnSync("pgrep", ["-fx", "sleep 333"], { encoding: "utf8" }).stdout as string).trim().split("\n")[0],
			)
			if (found > 0) {
				childPid = found
				break
			}
			await new Promise((r) => setTimeout(r, 50))
		}
		expect(childPid).toBeGreaterThan(0)
		if (childPid === undefined || childPid <= 0) throw new Error("grandchild pid not discovered")
		expect(isPidAlive(childPid)).toBe(true)

		const stop = await stopDaemon(outcome.record, dir)
		expect(stop.stopped).toBe(true)
		expect(isPidAlive(outcome.record.pid)).toBe(false)
		// The grandchild dies too — negative-pid group kill, not leader-only.
		expect(isPidAlive(childPid)).toBe(false)
		// And the state record is gone.
		expect(readDaemon(dir, outcome.record.id)).toBeUndefined()
	})

	it("stopDaemon is idempotent for an already-dead daemon", async () => {
		const outcome = await spawnDaemon({
			command: "sleep 60",
			cwd: dir,
			name: "short-lived",
			stateDir: dir,
			crashGraceMs: SHORT_GRACE,
		})
		expect(outcome.ok).toBe(true)
		if (!outcome.ok) return
		livePids.push(outcome.record.pid)

		// Kill it out-of-band, then stop: soft report, not an error.
		process.kill(-outcome.record.pid, "SIGKILL")
		await new Promise((r) => setTimeout(r, 50))
		const stop = await stopDaemon(outcome.record, dir)
		expect(stop.stopped).toBe(false)
		expect(stop.note).toContain("already not running")
	})

	it("readLogTail never emits mojibake when the cut splits a UTF-8 character", () => {
		const logFile = join(dir, "utf8.log")
		// 1000 ASCII bytes + two 3-byte chars, so the tail window starts
		// mid-code-point for alignments that the fix must snap away from.
		writeFileSync(logFile, `x'.repeat(1000)}€€✓✓`)
		for (const maxBytes of [6, 7, 8, 9, 10]) {
			const tail = readLogTail(logFile, maxBytes)
			expect(tail).not.toContain("�")
		}
	})
})
