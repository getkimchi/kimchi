import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
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
