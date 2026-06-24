import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { getToolsForProfile } from "./tool-catalog.js"
import {
	apply,
	applyCooperativeTweak,
	installTurnBoundaryReset,
	isSnapshotAppliedThisTurn,
	resetAll,
} from "./tool-profile-manager.js"

/** Build a fresh mock ExtensionAPI. */
const makeMockPi = (overrides: { allTools?: Array<{ name: string }> } = {}): ExtensionAPI => {
	const setActiveTools = vi.fn()
	const on = vi.fn()
	const getAllTools = vi.fn(() => overrides.allTools ?? [])
	return {
		setActiveTools,
		on,
		getAllTools,
	} as unknown as ExtensionAPI
}

// Reset both module-level state variables before every test so runs are
// fully independent even though the ESM module is evaluated once per VM.
beforeEach(() => {
	resetAll()
})

describe("apply", () => {
	it("(a) calls setActiveTools with the correct tool names and sets the snapshot flag", () => {
		const pi = makeMockPi()
		const profile = "planning-adhoc"
		const expectedTools = getToolsForProfile(profile).map((t) => t.name)

		apply(profile, "adhoc", pi)

		expect(pi.setActiveTools).toHaveBeenCalledOnce()
		expect(pi.setActiveTools).toHaveBeenCalledWith(expectedTools)
		expect(isSnapshotAppliedThisTurn()).toBe(true)
	})

	it("idle profile restores all registered tools minus ferment-only tools", () => {
		// Simulate a real-world toolset: shared core tools + bash + write + a
		// ferment-only tool. The idle profile should keep everything except the
		// ferment-only tool — mirroring the pre-unification behaviour where
		// exiting a ferment returned the user to their normal chat toolset.
		const pi = makeMockPi({
			allTools: [
				{ name: "read" },
				{ name: "bash" },
				{ name: "write" },
				{ name: "edit" },
				{ name: "propose_ferment_scoping" }, // ferment-only — filtered out
				{ name: "start_ferment_step" }, // ferment-only — filtered out
			],
		})

		apply("idle", "ferment", pi)

		expect(pi.setActiveTools).toHaveBeenCalledOnce()
		expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "bash", "write", "edit"])
	})

	it("idle profile returns an empty array when no tools are registered", () => {
		const pi = makeMockPi({ allTools: [] })

		apply("idle", "ferment", pi)

		expect(pi.setActiveTools).toHaveBeenCalledWith([])
	})
})

describe("applyCooperativeTweak", () => {
	it("(b) is a no-op (returns false, does not call setActiveTools) after apply() has been called", () => {
		const pi = makeMockPi()

		// Apply the snapshot first.
		apply("planning-adhoc", "adhoc", pi)
		vi.clearAllMocks()

		const result = applyCooperativeTweak(pi, ["some_tool"])

		expect(result).toBe(false)
		expect(pi.setActiveTools).not.toHaveBeenCalled()
	})

	it("(c) applies the tweak and calls setActiveTools when no snapshot has been applied this turn", () => {
		const pi = makeMockPi()

		// No apply() call — this is the "no snapshot this turn" condition.
		// Use flat string-array form.
		const tools = ["tool_alpha", "tool_beta"]

		const result = applyCooperativeTweak(pi, tools)

		expect(result).toBe(true)
		expect(pi.setActiveTools).toHaveBeenCalledOnce()
		expect(pi.setActiveTools).toHaveBeenCalledWith(tools)
	})
})

describe("installTurnBoundaryReset", () => {
	it("(d) resets the snapshot-applied flag when the 'turn_start' handler fires", () => {
		const pi = makeMockPi()

		// Confirm the flag is initially false.
		expect(isSnapshotAppliedThisTurn()).toBe(false)

		// Apply a snapshot (calls installTurnBoundaryReset internally).
		apply("planning-adhoc", "adhoc", pi)
		expect(isSnapshotAppliedThisTurn()).toBe(true)

		// The handler was registered as pi.on('turn_start', <handler>).
		// Capture it from the mock call.
		expect(pi.on).toHaveBeenCalledWith("turn_start", expect.any(Function))
		const mockOn = pi.on as unknown as { mock: { calls: Array<[string, () => void]> } }
		const found = mockOn.mock.calls.find((call) => call[0] === "turn_start")
		if (!found) throw new Error("pi.on was not called with 'turn_start'")
		const turnStartHandler = found[1]

		// Simulate the turn boundary by invoking the handler.
		turnStartHandler()

		// Flag must be cleared.
		expect(isSnapshotAppliedThisTurn()).toBe(false)
	})
})
