import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createMiniEventBus } from "../../extensions/__mocks__/mini-event-bus.js"
import { createToolVisibility } from "../../extensions/prompt-construction/tool-visibility.js"
import { getToolsForProfile } from "./tool-catalog.js"
import {
	apply,
	applyCooperativeTweak,
	isSnapshotAppliedThisTurn,
	reapplyCurrentProfile,
	resetAll,
} from "./tool-profile-manager.js"

/** Build a fresh mock ExtensionAPI. */
const makeMockPi = (
	overrides: {
		allTools?: Array<{ name: string }>
		events?: { on: (c: string, h: (d: unknown) => void) => () => void; emit: (c: string, d: unknown) => void }
	} = {},
): ExtensionAPI => {
	const on = vi.fn()
	const getAllTools = vi.fn(() => overrides.allTools ?? [])
	// The cooperative visibility layer calls pi.getActiveTools() and
	// pi.setActiveTools() when applying a disable vote. Provide a real list
	// backed by the same mock so disabling a tool before apply() records the
	// vote correctly.
	let activeTools: string[] = []
	const getActiveTools = vi.fn(() => activeTools)
	const wrappedSetActiveTools = vi.fn((names: string[]) => {
		activeTools = [...names]
	})
	return {
		setActiveTools: wrappedSetActiveTools,
		on,
		getAllTools,
		getActiveTools,
		events: overrides.events ?? createMiniEventBus().events,
	} as unknown as ExtensionAPI
}

// Reset module-level state before every test so runs are fully independent
// even though the ESM module is evaluated once per VM.
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

	// Regression: implementation-ferment previously used a fixed catalog snapshot,
	// causing MCP/custom/third-party tools registered by other extensions to
	// silently disappear when a ferment phase activated.
	it("implementation-ferment profile includes MCP/custom tools registered by other extensions", () => {
		const pi = makeMockPi({
			allTools: [
				{ name: "read" },
				{ name: "bash" },
				{ name: "my_custom_mcp_tool" }, // third-party tool
				{ name: "another_mcp_tool" }, // third-party tool
				{ name: "propose_ferment_scoping" }, // ferment-only — included in implementation
			],
		})

		apply("implementation-ferment", "ferment", pi)

		const calledWith = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[]
		expect(calledWith).toContain("my_custom_mcp_tool")
		expect(calledWith).toContain("another_mcp_tool")
		expect(calledWith).toContain("read")
		expect(calledWith).toContain("bash")
	})

	it("implementation-ferment profile still includes all required ferment lifecycle tools", () => {
		const pi = makeMockPi({
			allTools: [{ name: "read" }, { name: "bash" }],
		})

		apply("implementation-ferment", "ferment", pi)

		const calledWith = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[]
		// Core ferment lifecycle tools must always be present
		expect(calledWith).toContain("activate_ferment_phase")
		expect(calledWith).toContain("complete_ferment_step")
		expect(calledWith).toContain("complete_ferment")
		expect(calledWith).toContain("edit")
		expect(calledWith).toContain("write")
		expect(calledWith).toContain("Agent")
	})

	it("implementation-ferment excludes adhoc-only tools (questionnaire) while keeping third-party tools", () => {
		// The adhoc planning tool `questionnaire` must stay hidden: its ferment
		// counterpart `ask_user` is the interactive-question surface inside a
		// ferment. Regression for the getAllTools-base resurrecting first-party
		// adhoc-only tools; third-party/MCP tools must still be preserved.
		const pi = makeMockPi({
			allTools: [
				{ name: "read" },
				{ name: "bash" },
				{ name: "questionnaire" }, // catalog modes: ["adhoc"] — NOT ferment
				{ name: "my_custom_mcp_tool" }, // third-party -> preserved
			],
		})

		apply("implementation-ferment", "ferment", pi)

		const calledWith = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[]
		expect(calledWith).not.toContain("questionnaire")
		expect(calledWith).toContain("my_custom_mcp_tool")
		expect(calledWith).toContain("read")
		expect(calledWith).toContain("bash")
	})
	it("applyCore on a PEER pi excludes a cross-extension vote cast on the shared bus (the DAP→ferment case)", () => {
		// pi-mono hands each extension its own ExtensionAPI; a full-toolset
		// snapshot taken under ferment's pi must still respect votes DAP cast
		// under DAP's pi. The shared synchronous bus is the session identity,
		// exactly as in the real runner (resource-loader creates one bus per
		// session).
		const handlers = new Map<string, Set<(d: unknown) => void>>()
		const events = {
			on: (c: string, h: (d: unknown) => void) => {
				const set = handlers.get(c) ?? new Set()
				set.add(h)
				handlers.set(c, set)
				return () => set.delete(h)
			},
			emit: (c: string, d: unknown) => {
				for (const h of [...(handlers.get(c) ?? [])]) h(d)
			},
		}
		const dapPi = makeMockPi({ allTools: [{ name: "bash" }, { name: "edit" }], events })
		const fermentPi = makeMockPi({ allTools: [{ name: "bash" }, { name: "edit" }], events })

		// DAP votes to defer a tool under its own pi at session_start.
		createToolVisibility(dapPi).disable(["bash"])

		// Ferment applies the full-toolset "idle" profile under ITS pi at
		// before_agent_start. The vote must be visible cross-pi, so the
		// snapshot must NOT re-surface bash.
		apply("idle", "ferment", fermentPi)

		const calledWith = (fermentPi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[0] as string[]
		expect(calledWith).not.toContain("bash")
		expect(calledWith).toContain("edit")
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

describe("reapplyCurrentProfile", () => {
	it("re-applies a planning profile without exposing newly registered MCP tools", () => {
		const pi = makeMockPi({ allTools: [{ name: "read" }] })
		apply("planning-ferment", "ferment", pi)

		;(pi.getAllTools as ReturnType<typeof vi.fn>).mockReturnValue([
			{ name: "read" },
			{ name: "mcp" },
			{ name: "server_get_record" },
		])
		vi.clearAllMocks()

		const reapplied = reapplyCurrentProfile(pi)

		expect(reapplied).toBe(true)
		expect(pi.setActiveTools).toHaveBeenCalledOnce()
		const calledWith = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[]
		expect(calledWith).not.toContain("mcp")
		expect(calledWith).not.toContain("server_get_record")
		expect(calledWith).toContain("read")
	})

	it("returns false and does not call setActiveTools when no profile was applied", () => {
		const pi = makeMockPi()

		const reapplied = reapplyCurrentProfile(pi)

		expect(reapplied).toBe(false)
		expect(pi.setActiveTools).not.toHaveBeenCalled()
	})

	it("re-applies the idle profile, picking up newly-registered tools", () => {
		// idle uses pi.getAllTools() as its base. If a tool is registered after
		// the initial apply(), reapplyCurrentProfile must pick it up.
		const pi = makeMockPi({ allTools: [{ name: "read" }] })
		apply("idle", "ferment", pi)

		// A new tool appears (simulated by updating getAllTools)
		;(pi.getAllTools as ReturnType<typeof vi.fn>).mockReturnValue([{ name: "read" }, { name: "server_get_record" }])
		vi.clearAllMocks()

		reapplyCurrentProfile(pi)

		const calledWith = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[]
		expect(calledWith).toContain("server_get_record")
	})
})
