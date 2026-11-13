import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { acquireCaptureLock, breakIfHolderDead } from "./lock.js"

// A pid that is certainly dead right now: the first probe at or below
// our own pid that answers ESRCH. No child lifecycle, deterministic
// under test-workers where spawn event delivery is unreliable.
function deadPid(): number {
	for (let pid = process.pid; pid > 1; pid--) {
		try {
			process.kill(pid, 0)
		} catch (err) {
			if ((err as { code?: string }).code === "ESRCH") return pid
		}
	}
	throw new Error("no free pid below own — test environment is degenerate")
}

describe("capture lock — dead-holder break", () => {
	let dir: string
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "kimchi-lock-"))
	})
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
	})

	const lockFile = () => join(dir, "capture.lock")
	const lockDir = () => `${lockFile()}.lock`
	const pidFile = () => `${lockFile()}.pid`

	const makeStaleLock = (pid: number) => {
		mkdirSync(lockDir(), { recursive: true })
		writeFileSync(lockFile(), "")
		writeFileSync(pidFile(), String(pid))
	}

	it("breaks the lock when the recorded holder is dead", () => {
		makeStaleLock(deadPid())
		expect(breakIfHolderDead(lockFile())).toBe(true)
		expect(existsSync(lockDir())).toBe(false)
		expect(existsSync(pidFile())).toBe(false)
	})

	it("keeps a lock whose recorded holder is alive (even if mtime is old)", () => {
		makeStaleLock(process.pid)
		expect(breakIfHolderDead(lockFile())).toBe(false)
		expect(existsSync(lockDir())).toBe(true)
	})

	it("falls back to mtime staleness when no sidecar exists", () => {
		mkdirSync(lockDir(), { recursive: true })
		writeFileSync(lockFile(), "")
		expect(breakIfHolderDead(lockFile())).toBe(false)
		expect(existsSync(lockDir())).toBe(true)
	})

	it("breaks a sidecar-absent lock whose mtime froze past three update cycles", () => {
		mkdirSync(lockDir(), { recursive: true })
		writeFileSync(lockFile(), "")
		// A live holder refreshes the dir mtime every update cycle — this
		// freeze (past 3x the 30s update) is the dead-hold signature from
		// the crash-without-sidecar bench incident.
		const frozen = new Date(Date.now() - 120_000)
		utimesSync(lockDir(), frozen, frozen)
		expect(breakIfHolderDead(lockFile())).toBe(true)
		expect(existsSync(lockDir())).toBe(false)
	})

	it("keeps a sidecar-absent lock whose mtime is still fresh (live holder)", () => {
		mkdirSync(lockDir(), { recursive: true })
		writeFileSync(lockFile(), "")
		const fresh = new Date(Date.now() - 30_000)
		utimesSync(lockDir(), fresh, fresh)
		expect(breakIfHolderDead(lockFile())).toBe(false)
		expect(existsSync(lockDir())).toBe(true)
	})

	it("acquire succeeds immediately after a dead holder's lock is broken", async () => {
		makeStaleLock(deadPid())
		const release = await acquireCaptureLock(dir, { pollMs: 50 })
		expect(release).not.toBeNull()
		// The acquisition wrote its own pid sidecar.
		expect(readFileSync(pidFile(), "utf-8").trim()).toBe(String(process.pid))
		if (!release) throw new Error("expected the dead-holder lock to be stealable")
		await release()
		expect(existsSync(pidFile())).toBe(false)
	})

	it("a live holder means fail-fast: null without waiting", async () => {
		const first = await acquireCaptureLock(dir, { pollMs: 50 })
		expect(first).not.toBeNull()
		const started = Date.now()
		// Same-process reentrant acquire conflicts: proper-lockfile tracks
		// ownership by pid, and our own sidecar is treated as live (the
		// break helper refuses our own pid), so this models a live holder.
		const second = await acquireCaptureLock(dir, { pollMs: 50 })
		expect(second).toBeNull()
		// Fail-fast: breaks only come from dead pids, so contention returns
		// immediately — no poll loops (previously up to an hour).
		expect(Date.now() - started).toBeLessThan(1_000)
		if (!first) throw new Error("expected the initial acquisition to succeed")
		await first()
	})
})
