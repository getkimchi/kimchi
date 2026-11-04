// Tests for the updater lock — the machine-wide exclusion that lets only one
// session install at a time (see docs/auto-update.md). The seam is the
// lock file on disk: observable, not implementation detail.

import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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

	it("takes over a lock file it cannot read, such as one left by a sudo run", () => {
		writeFileSync(lockPath, JSON.stringify({ pid: 12345, at: Date.now() }))
		chmodSync(lockPath, 0o000)
		const lock = acquireUpdaterLock({ lockPath, heartbeatMs: 0 })
		expect(lock).not.toBeNull()
		lock?.release()
	})

	it("release removes the lock file", () => {
		const lock = acquireUpdaterLock({ lockPath })
		lock?.release()
		expect(() => readFileSync(lockPath)).toThrow()
	})

	it("stamps the lock with an ownership nonce and leaves no temp litter", () => {
		const lock = acquireUpdaterLock({ lockPath })
		const contents = JSON.parse(readFileSync(lockPath, "utf-8")) as { nonce?: unknown }
		expect(typeof contents.nonce).toBe("string")
		expect((contents.nonce as string).length).toBeGreaterThan(0)
		// Publication is atomic (tmp + link/rename); no partial writes.
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([])
		lock?.release()
	})

	it("release is ignored once the lock was stolen by a takeover", () => {
		const first = acquireUpdaterLock({ lockPath, isPidAlive: () => true })
		// A rival session found our lock abandoned (dead owner / stale) and
		// took it over; we keep running our slow install in the background.
		const second = acquireUpdaterLock({ lockPath, isPidAlive: () => false, heartbeatMs: 0 })
		expect(second).not.toBeNull()
		first?.release()
		// The rival's lock survives our stale release: a third session still
		// sees the lock as held instead of racing the rival's install.
		expect(acquireUpdaterLock({ lockPath })).toBeNull()
		second?.release()
	})

	it("heartbeats keep the timestamp fresh during a long install", async () => {
		const lock = acquireUpdaterLock({ lockPath, heartbeatMs: 20 })
		const at0 = (JSON.parse(readFileSync(lockPath, "utf-8")) as { at: number }).at
		await new Promise((resolve) => setTimeout(resolve, 150))
		const at1 = (JSON.parse(readFileSync(lockPath, "utf-8")) as { at: number }).at
		expect(at1).toBeGreaterThan(at0)
		// Heartbeats publish atomically: no truncated reads, no tmp litter.
		expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([])
		lock?.release()
	})

	it("stops heartbeating once the lock is stolen", async () => {
		const first = acquireUpdaterLock({ lockPath, heartbeatMs: 20 })
		const second = acquireUpdaterLock({ lockPath, isPidAlive: () => false, heartbeatMs: 0 })
		expect(second).not.toBeNull()
		const stolen = readFileSync(lockPath, "utf-8")
		await new Promise((resolve) => setTimeout(resolve, 80))
		// The first owner's heartbeat must notice the changed ownership and
		// go quiet, not overwrite the rival's lock record.
		expect(readFileSync(lockPath, "utf-8")).toBe(stolen)
		first?.release()
		second?.release()
	})

	it("keeps heartbeating after a rival's failed claim moves the lock aside and restores it", async () => {
		const lock = acquireUpdaterLock({ lockPath, heartbeatMs: 20 })
		const aside = `${lockPath}.aside`
		renameSync(lockPath, aside)
		await new Promise((resolve) => setTimeout(resolve, 60))
		// A beat during the window must not recreate the file: the rival is
		// still deciding whose lock this is.
		expect(existsSync(lockPath)).toBe(false)
		renameSync(aside, lockPath)
		const restoredAt = (JSON.parse(readFileSync(lockPath, "utf-8")) as { at: number }).at
		await new Promise((resolve) => setTimeout(resolve, 100))
		const laterAt = (JSON.parse(readFileSync(lockPath, "utf-8")) as { at: number }).at
		expect(laterAt).toBeGreaterThan(restoredAt)
		lock?.release()
	})

	it("does not evict a rival that won the takeover after we judged the lock stale", () => {
		writeFileSync(lockPath, JSON.stringify({ pid: 12345 }))
		const rival = JSON.stringify({ pid: 67890, at: Date.now(), nonce: "rival" })
		const lock = acquireUpdaterLock({
			lockPath,
			heartbeatMs: 0,
			// The liveness probe runs between our read and our removal: the rival
			// finishes its takeover in exactly that window.
			isPidAlive: () => {
				rmSync(lockPath)
				writeFileSync(lockPath, rival)
				return false
			},
		})
		expect(lock).toBeNull()
		expect(readFileSync(lockPath, "utf-8")).toBe(rival)
		expect(readdirSync(dir)).toEqual(["updater.lock"])
	})

	it("leaves no claim files behind after taking over a stale lock", () => {
		writeFileSync(lockPath, JSON.stringify({ pid: 12345 }))
		const lock = acquireUpdaterLock({ lockPath, isPidAlive: () => false, heartbeatMs: 0 })
		expect(lock).not.toBeNull()
		expect(readdirSync(dir)).toEqual(["updater.lock"])
		lock?.release()
	})

	it("still excludes rivals on a filesystem without hard links", () => {
		const unsupported = vi.fn(() => {
			throw Object.assign(new Error("link not supported"), { code: "ENOTSUP" })
		})
		const first = acquireUpdaterLock({ lockPath, linkFile: unsupported, heartbeatMs: 0 })
		expect(first).not.toBeNull()
		expect(unsupported).toHaveBeenCalledOnce()
		expect(readdirSync(dir)).toEqual(["updater.lock"])
		expect(acquireUpdaterLock({ lockPath, linkFile: unsupported, heartbeatMs: 0 })).toBeNull()
		first?.release()
	})
})

describe("acquireUpdaterLock when the lock file cannot be written", () => {
	/** A path whose parent is a regular file, so every write fails with ENOTDIR. */
	function unwritableLockPath(): string {
		const blocker = join(dir, "blocker")
		writeFileSync(blocker, "")
		return join(blocker, "updater.lock")
	}

	it("returns null by default, so a tick skips", () => {
		expect(acquireUpdaterLock({ lockPath: unwritableLockPath() })).toBeNull()
	})

	it("returns a usable handle with allowUnavailable, so a manual update can proceed", () => {
		const lock = acquireUpdaterLock({ lockPath: unwritableLockPath(), allowUnavailable: true })
		expect(lock).not.toBeNull()
		expect(() => lock?.release()).not.toThrow()
	})

	it("still refuses with allowUnavailable when a live session holds the lock", () => {
		const first = acquireUpdaterLock({ lockPath, heartbeatMs: 0 })
		expect(acquireUpdaterLock({ lockPath, allowUnavailable: true })).toBeNull()
		first?.release()
	})
})
