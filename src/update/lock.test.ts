// Tests for the updater lock — the machine-wide exclusion that lets only one
// session install at a time (see docs/auto-update.md). The seam is the
// lock file on disk: observable, not implementation detail.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { acquireUpdaterLock, LOCK_STALE_MS } from "./lock.js"

let dir: string
let lockPath: string

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "kimchi-lock-test-"))
	lockPath = join(dir, "updater.lock")
})

afterEach(() => {
	rmSync(dir, { recursive: true, force: true })
})

describe("acquireUpdaterLock", () => {
	it("acquires when no lock exists", () => {
		const lock = acquireUpdaterLock({ lockPath })
		expect(lock).not.toBeNull()
		lock?.release()
	})

	it("refuses while the lock is held by a live process", () => {
		const first = acquireUpdaterLock({ lockPath })
		// second acquire: the lock file names the current (live) pid
		expect(acquireUpdaterLock({ lockPath })).toBeNull()
		first?.release()
	})

	it("frees the lock on release so another acquire succeeds", () => {
		acquireUpdaterLock({ lockPath })?.release()
		const next = acquireUpdaterLock({ lockPath })
		expect(next).not.toBeNull()
		next?.release()
	})

	it("takes over a lock whose owner is dead", () => {
		// Simulate another session that died holding the lock.
		writeFileSync(lockPath, JSON.stringify({ pid: 12345 }))
		const lock = acquireUpdaterLock({ lockPath, isPidAlive: () => false })
		expect(lock).not.toBeNull()
		lock?.release()
	})

	it("refuses a lock owned by a live foreign pid", () => {
		writeFileSync(lockPath, JSON.stringify({ pid: 12345, at: Date.now() }))
		expect(acquireUpdaterLock({ lockPath, isPidAlive: () => true })).toBeNull()
	})

	it("takes over a lock older than LOCK_STALE_MS even when its pid is alive (recycled pid)", () => {
		const now = Date.now()
		writeFileSync(lockPath, JSON.stringify({ pid: 12345, at: now - LOCK_STALE_MS - 1 }))
		const lock = acquireUpdaterLock({ lockPath, isPidAlive: () => true, now: () => now })
		expect(lock).not.toBeNull()
		lock?.release()
	})

	it("takes over an unparseable lock file", () => {
		writeFileSync(lockPath, "not json {{{")
		const lock = acquireUpdaterLock({ lockPath })
		expect(lock).not.toBeNull()
		lock?.release()
	})

	it("release removes the lock file", () => {
		const lock = acquireUpdaterLock({ lockPath })
		lock?.release()
		expect(() => readFileSync(lockPath)).toThrow()
	})
})
