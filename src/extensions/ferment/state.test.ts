import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Ferment, FermentStatus } from "../../ferment/types.js"
import {
	clearActiveFermentId,
	clearCompactionInFlight,
	clearFermentState,
	clearPendingCompaction,
	getActiveFermentId,
	getFermentLockPath,
	getPendingCompaction,
	hasActiveFerment,
	isCompactionInFlight,
	isFermentLockedByLiveProcess,
	markCompactionInFlight,
	onActiveFermentChange,
	removeFermentLock,
	setActive,
	setPendingCompaction,
	writeFermentLock,
} from "./state.js"

const NOW = "2026-01-01T00:00:00.000Z"

function makeFerment(status: FermentStatus): Ferment {
	return {
		id: `ferment-${status}`,
		name: `${status} ferment`,
		status,
		worktree: { path: "/repo" },
		scoping: {},
		phases: [],
		decisions: [],
		memories: [],
		createdAt: NOW,
		updatedAt: NOW,
	}
}

afterEach(() => {
	setActive(undefined)
	vi.unstubAllEnvs()
	clearActiveFermentId()
})

describe("lockfile helpers", () => {
	let lockDir: string

	beforeEach(() => {
		lockDir = mkdtempSync(join(tmpdir(), "kimchi-lock-test-"))
		vi.stubEnv("KIMCHI_FERMENT_LOCK_DIR", lockDir)
	})

	afterEach(() => {
		rmSync(lockDir, { recursive: true, force: true })
	})

	it("writeFermentLock writes a JSON lockfile with the current PID", () => {
		writeFermentLock("test-ferment-1")
		const lockPath = getFermentLockPath("test-ferment-1")
		expect(existsSync(lockPath)).toBe(true)
		const lock = JSON.parse(readFileSync(lockPath, "utf8"))
		expect(lock.pid).toBe(process.pid)
		expect(lock.fermentId).toBe("test-ferment-1")
		expect(lock.startedAt).toBeTruthy()
	})

	it("removeFermentLock deletes the lockfile", () => {
		writeFermentLock("test-ferment-2")
		expect(existsSync(getFermentLockPath("test-ferment-2"))).toBe(true)
		removeFermentLock("test-ferment-2")
		expect(existsSync(getFermentLockPath("test-ferment-2"))).toBe(false)
	})

	it("isFermentLockedByLiveProcess returns true for a lockfile with a live PID", () => {
		writeFermentLock("test-ferment-3")
		expect(isFermentLockedByLiveProcess("test-ferment-3")).toBe(true)
	})

	it("isFermentLockedByLiveProcess returns false when no lockfile exists", () => {
		expect(isFermentLockedByLiveProcess("nonexistent-ferment")).toBe(false)
	})

	it("isFermentLockedByLiveProcess returns false when the PID is dead", () => {
		// Write a lockfile with a PID that is guaranteed to not be running.
		const fs = require("node:fs")
		const lockPath = getFermentLockPath("test-ferment-4")
		fs.writeFileSync(
			lockPath,
			JSON.stringify({ pid: 999999999, startedAt: new Date().toISOString(), fermentId: "test-ferment-4" }),
			"utf8",
		)
		expect(isFermentLockedByLiveProcess("test-ferment-4")).toBe(false)
	})

	it("getFermentLockPath throws for invalid fermentIds", () => {
		for (const bad of ["../evil", "a/b", "a\\b", ".", "..", ""]) {
			expect(() => getFermentLockPath(bad), `expected throw for ${JSON.stringify(bad)}`).toThrow(/Invalid fermentId/)
		}
	})

	it("getFermentLockPath returns a path inside the lock dir for valid ids", () => {
		const p = getFermentLockPath("safe-id_123.test")
		expect(p.startsWith(lockDir)).toBe(true)
		expect(p.endsWith("safe-id_123.test.lock")).toBe(true)
	})

	it("writeFermentLock logs to console.error when mkdirSync fails", () => {
		// Point the lock dir at a path under a regular file so mkdirSync fails
		// with ENOTDIR — the canonical "lock dir unwritable" scenario.
		const blockerFile = join(tmpdir(), `kimchi-lock-blocker-${Date.now()}-${Math.random().toString(36).slice(2)}`)
		writeFileSync(blockerFile, "")
		vi.stubEnv("KIMCHI_FERMENT_LOCK_DIR", `${blockerFile}/subdir`)
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			writeFermentLock("ferment-write-fail")
			expect(errorSpy).toHaveBeenCalled()
			const msg = String(errorSpy.mock.calls[0]?.[0] ?? "")
			expect(msg).toContain("[ferment]")
			expect(msg).toContain("ferment-write-fail")
		} finally {
			errorSpy.mockRestore()
			rmSync(blockerFile, { force: true })
		}
	})

	it("removeFermentLock logs to console.error when rmSync fails", () => {
		// Create a directory at the lockfile path. rmSync on a directory without
		// {recursive:true} throws EISDIR, which force:true does NOT suppress (it
		// only ignores ENOENT). This exercises the real rmSync error path without
		// mocking the fs module (which is unreliable under ESM live bindings).
		const lockPath = getFermentLockPath("ferment-rm-fail")
		mkdirSync(lockPath)
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			removeFermentLock("ferment-rm-fail")
			expect(errorSpy).toHaveBeenCalled()
			const msg = String(errorSpy.mock.calls[0]?.[0] ?? "")
			expect(msg).toContain("[ferment]")
			expect(msg).toContain("ferment-rm-fail")
		} finally {
			errorSpy.mockRestore()
			rmSync(lockPath, { recursive: true, force: true })
		}
	})

	it("isFermentLockedByLiveProcess returns false when startedAt is older than KIMCHI_FERMENT_LOCK_MAX_AGE_MS", () => {
		// Tiny max age so the staleness guard triggers with a comfortably-old
		// timestamp; the lockfile's PID is still alive (process.pid).
		vi.stubEnv("KIMCHI_FERMENT_LOCK_MAX_AGE_MS", "1000")
		const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString()
		const lockPath = getFermentLockPath("test-ferment-stale")
		writeFileSync(
			lockPath,
			JSON.stringify({ pid: process.pid, startedAt: eightDaysAgo, fermentId: "test-ferment-stale" }),
			"utf8",
		)
		expect(isFermentLockedByLiveProcess("test-ferment-stale")).toBe(false)
	})

	it("isFermentLockedByLiveProcess returns false when startedAt is missing", () => {
		const lockPath = getFermentLockPath("test-ferment-missing-started")
		writeFileSync(lockPath, JSON.stringify({ pid: process.pid, fermentId: "test-ferment-missing-started" }), "utf8")
		expect(isFermentLockedByLiveProcess("test-ferment-missing-started")).toBe(false)
	})

	it("isFermentLockedByLiveProcess returns false when startedAt is unparseable", () => {
		const lockPath = getFermentLockPath("test-ferment-bad-started")
		writeFileSync(
			lockPath,
			JSON.stringify({ pid: process.pid, startedAt: "not-a-date", fermentId: "test-ferment-bad-started" }),
			"utf8",
		)
		expect(isFermentLockedByLiveProcess("test-ferment-bad-started")).toBe(false)
	})

	it("isFermentLockedByLiveProcess returns false when startedAt is in the future", () => {
		const futureStart = new Date(Date.now() + 60 * 60 * 1000).toISOString() // +1h
		const lockPath = getFermentLockPath("test-ferment-future-started")
		writeFileSync(
			lockPath,
			JSON.stringify({ pid: process.pid, startedAt: futureStart, fermentId: "test-ferment-future-started" }),
			"utf8",
		)
		expect(isFermentLockedByLiveProcess("test-ferment-future-started")).toBe(false)
	})
})

describe("setActive lockfile management", () => {
	let lockDir: string

	beforeEach(() => {
		lockDir = mkdtempSync(join(tmpdir(), "kimchi-setactive-lock-"))
		vi.stubEnv("KIMCHI_FERMENT_LOCK_DIR", lockDir)
	})

	afterEach(() => {
		rmSync(lockDir, { recursive: true, force: true })
	})

	it("writes a lockfile when setting an active running ferment", () => {
		setActive(makeFerment("running"))
		expect(existsSync(getFermentLockPath("ferment-running"))).toBe(true)
	})

	it("removes the lockfile when clearing the active ferment", () => {
		setActive(makeFerment("running"))
		expect(existsSync(getFermentLockPath("ferment-running"))).toBe(true)
		setActive(undefined)
		expect(existsSync(getFermentLockPath("ferment-running"))).toBe(false)
	})

	it("removes the old lockfile when switching to a different ferment", () => {
		const f1 = makeFerment("running")
		const f2 = { ...makeFerment("running"), id: "ferment-other" }
		setActive(f1)
		expect(existsSync(getFermentLockPath("ferment-running"))).toBe(true)
		setActive(f2)
		expect(existsSync(getFermentLockPath("ferment-running"))).toBe(false)
		expect(existsSync(getFermentLockPath("ferment-other"))).toBe(true)
	})
})

describe("setActive", () => {
	it("elevates permissions for active ferment states", () => {
		const notifyFermentActive = vi.fn()
		onActiveFermentChange(notifyFermentActive)

		for (const status of ["draft", "planned", "running", "paused"] as const) {
			setActive(makeFerment(status))

			expect(notifyFermentActive).toHaveBeenLastCalledWith(true)
			expect(getActiveFermentId()).toBe(`ferment-${status}`)
		}
	})

	it("does not elevate permissions for terminal states", () => {
		const notifyFermentActive = vi.fn()
		onActiveFermentChange(notifyFermentActive)

		for (const status of ["complete", "abandoned"] as const) {
			setActive(makeFerment(status))

			expect(notifyFermentActive).toHaveBeenLastCalledWith(false)
			expect(getActiveFermentId()).toBeUndefined()
		}
	})
})

describe("active ferment env helpers", () => {
	it("treats a non-empty env value as active", () => {
		vi.stubEnv("KIMCHI_ACTIVE_FERMENT", "ferment-123")

		expect(getActiveFermentId()).toBe("ferment-123")
		expect(hasActiveFerment()).toBe(true)
	})

	it("treats missing or blank env values as inactive", () => {
		expect(getActiveFermentId({})).toBeUndefined()
		expect(hasActiveFerment({ KIMCHI_ACTIVE_FERMENT: " " })).toBe(false)
	})
})

describe("clearFermentState", () => {
	afterEach(() => {
		clearPendingCompaction("ferment-A")
		clearPendingCompaction("ferment-B")
		clearCompactionInFlight("ferment-A")
		clearCompactionInFlight("ferment-B")
	})

	it("clears pending compactions and in-flight markers scoped to the ferment", () => {
		setPendingCompaction("ferment-A", {
			kind: "step",
			fermentId: "ferment-A",
			phaseId: "phase-1",
			stepId: "step-1",
			completedAt: NOW,
		})
		setPendingCompaction("ferment-B", {
			kind: "phase",
			fermentId: "ferment-B",
			phaseId: "phase-1",
			completedAt: NOW,
		})
		markCompactionInFlight("ferment-A")

		expect(getPendingCompaction("ferment-A")).toBeDefined()
		expect(isCompactionInFlight("ferment-A")).toBe(true)

		clearFermentState("ferment-A")

		expect(getPendingCompaction("ferment-A")).toBeUndefined()
		expect(isCompactionInFlight("ferment-A")).toBe(false)
		// Other ferments are unaffected.
		expect(getPendingCompaction("ferment-B")).toBeDefined()
	})
})
