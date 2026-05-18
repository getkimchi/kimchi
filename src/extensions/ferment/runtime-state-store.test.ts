import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	bumpBlockRetry,
	bumpStepCompleteAttempt,
	bumpStepStart,
	clearAllScopingGates,
	clearAllStepStarts,
	clearFermentState,
	getBlockRetry,
	getPhaseStartRef,
	getStepStartRef,
	recordBlockHashAndCheckRepeat,
	setPhaseStartRef,
	setRuntimeStatePersistRoot,
	setStepStartRef,
} from "./state.js"

let persistRoot: string

beforeEach(() => {
	persistRoot = mkdtempSync(join(tmpdir(), "ferment-runtime-state-"))
	setRuntimeStatePersistRoot(persistRoot)
})

afterEach(() => {
	// Reset state between tests so global maps don't leak across cases.
	clearAllStepStarts()
	clearAllScopingGates()
	setRuntimeStatePersistRoot(undefined)
})

function simulateRestart(): void {
	// Forget all in-memory state for the active persist root. Subsequent
	// accessors must re-hydrate from disk.
	clearAllStepStarts()
	clearAllScopingGates()
	// Re-set the persist root so hydratedFerments gets cleared and disk
	// reads target the same directory.
	setRuntimeStatePersistRoot(persistRoot)
}

describe("runtime-state persistence — write-through + lazy hydrate", () => {
	it("persists stepStartCounts across a simulated restart", () => {
		const fId = "ferment-test-1"
		bumpStepStart(fId, "phase-1", "step-1")
		bumpStepStart(fId, "phase-1", "step-1")
		bumpStepStart(fId, "phase-1", "step-1")

		simulateRestart()

		// The next bump must continue from 3, not reset to 1.
		const next = bumpStepStart(fId, "phase-1", "step-1")
		expect(next).toBe(4)
	})

	it("persists blockRetries across a simulated restart", () => {
		const fId = "ferment-test-2"
		bumpBlockRetry(fId, "phase-1")
		bumpBlockRetry(fId, "phase-1")
		expect(getBlockRetry(fId, "phase-1")).toBe(2)

		simulateRestart()

		expect(getBlockRetry(fId, "phase-1")).toBe(2)
		expect(bumpBlockRetry(fId, "phase-1")).toBe(3)
	})

	it("persists lastBlockHashes and detects repeats after restart", () => {
		const fId = "ferment-test-3"
		const hashA = "abc123"
		expect(recordBlockHashAndCheckRepeat(fId, "phase-1", hashA)).toBe(false)

		simulateRestart()

		// Same hash again after restart — must be detected as repeat.
		expect(recordBlockHashAndCheckRepeat(fId, "phase-1", hashA)).toBe(true)
	})

	it("persists stepCompleteAttempts across a simulated restart", () => {
		const fId = "ferment-test-5"
		bumpStepCompleteAttempt(fId, "phase-1", "step-1")
		bumpStepCompleteAttempt(fId, "phase-1", "step-1")

		simulateRestart()

		// Continuing the count must yield 3, proving disk read worked.
		expect(bumpStepCompleteAttempt(fId, "phase-1", "step-1")).toBe(3)
	})

	it("persists phaseStartRefs and stepStartRefs across a simulated restart", () => {
		const fId = "ferment-test-6"
		setPhaseStartRef(fId, "phase-1", "deadbeef")
		setStepStartRef(fId, "phase-1", "step-1", "cafef00d")

		simulateRestart()

		expect(getPhaseStartRef(fId, "phase-1")).toBe("deadbeef")
		expect(getStepStartRef(fId, "phase-1", "step-1")).toBe("cafef00d")
	})

	it("clearFermentState wipes both in-memory and on-disk state", () => {
		const fId = "ferment-test-7"
		bumpBlockRetry(fId, "phase-1")
		setPhaseStartRef(fId, "phase-1", "deadbeef")

		clearFermentState(fId)

		expect(getBlockRetry(fId, "phase-1")).toBe(0)
		expect(getPhaseStartRef(fId, "phase-1")).toBeUndefined()

		// Even after a simulated restart, the cleared state stays empty.
		simulateRestart()
		expect(getBlockRetry(fId, "phase-1")).toBe(0)
		expect(getPhaseStartRef(fId, "phase-1")).toBeUndefined()
	})

	it("does not cross-contaminate between two ferments in the same session", () => {
		const fA = "ferment-A"
		const fB = "ferment-B"
		bumpBlockRetry(fA, "phase-1")
		bumpBlockRetry(fA, "phase-1")
		bumpBlockRetry(fB, "phase-1")

		expect(getBlockRetry(fA, "phase-1")).toBe(2)
		expect(getBlockRetry(fB, "phase-1")).toBe(1)

		simulateRestart()

		expect(getBlockRetry(fA, "phase-1")).toBe(2)
		expect(getBlockRetry(fB, "phase-1")).toBe(1)
	})

	it("writes the snapshot atomically — only runtime.json is the final artifact", () => {
		const fId = "ferment-test-9"
		bumpBlockRetry(fId, "phase-1")
		setPhaseStartRef(fId, "phase-1", "deadbeef")

		// Verify the JSON shape on disk.
		const path = join(persistRoot, fId, "runtime.json")
		const parsed = JSON.parse(readFileSync(path, "utf-8"))
		expect(parsed.schemaVersion).toBe(1)
		expect(parsed.blockRetries["phase-1"]).toBe(1)
		expect(parsed.phaseStartRefs["phase-1"]).toBe("deadbeef")
	})
})
