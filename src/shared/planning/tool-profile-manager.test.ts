import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { createToolVisibility } from "../../extensions/prompt-construction/tool-visibility.js"
import { registerReadOnlyToolProvider, resetReadOnlyToolRegistry } from "./read-only-tool-registry.js"
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
	} as unknown as ExtensionAPI
}

// Reset both module-level state variables before every test so runs are
// fully independent even though the ESM module is evaluated once per VM.
// Also reset the read-only-tool registry so provider registrations from one
// test do not leak into another (the WeakMap is keyed on the mock pi, which
// is freshly constructed per test).
beforeEach(() => {
	resetAll()
	resetReadOnlyToolRegistry()
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
	describe("planning-ferment read-only MCP union", () => {
		it("includes read-only-qualified tool names from registered providers", () => {
			const pi = makeMockPi()
			registerReadOnlyToolProvider(pi, () => ["server_get_record", "server_search_items"])

			apply("planning-ferment", "ferment", pi)

			const calledWith = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[]
			expect(calledWith).toContain("server_get_record")
			expect(calledWith).toContain("server_search_items")
			// Catalog tools are still present
			expect(calledWith).toContain("read")
		})

		it("includes read-only-qualified tool names under planning-adhoc (else branch widened)", () => {
			const pi = makeMockPi()
			registerReadOnlyToolProvider(pi, () => ["server_get_record"])

			apply("planning-adhoc", "adhoc", pi)

			const calledWith = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[]
			expect(calledWith).toContain("server_get_record")
		})

		it("unions providers and deduplicates overlapping names", () => {
			const pi = makeMockPi()
			registerReadOnlyToolProvider(pi, () => ["server_get_record"])
			registerReadOnlyToolProvider(pi, () => ["server_get_record", "server_list_things"])

			apply("planning-ferment", "ferment", pi)

			const calledWith = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[]
			const occurrences = calledWith.filter((n) => n === "server_get_record").length
			expect(occurrences).toBe(1)
			expect(calledWith).toContain("server_list_things")
		})

		it("includes nothing extra when no providers are registered", () => {
			const pi = makeMockPi()

			apply("planning-ferment", "ferment", pi)

			const calledWith = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[]
			const expected = getToolsForProfile("planning-ferment").map((t) => t.name)
			expect(calledWith).toEqual(expected)
		})

		it("respects the cooperative-visibility disabled filter for read-only tools", () => {
			const pi = makeMockPi()
			registerReadOnlyToolProvider(pi, () => ["server_get_record"])
			// Simulate the cooperative layer voting to hide the read-only MCP
			// tool. `createToolVisibility` reads `pi.getActiveTools()` and
			// writes back via `pi.setActiveTools()`; the mock above mirrors
			// that. The disable vote must propagate through the WeakMap so
			// `getDisabledToolNames(pi)` returns it when `applyCore` runs.
			createToolVisibility(pi).disable(["server_get_record"])
			// Clear the disable's own setActiveTools call so the assertion below
			// observes the apply() call only.
			vi.mocked(pi.setActiveTools).mockClear()

			apply("planning-ferment", "ferment", pi)

			const calledWith = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[]
			expect(calledWith).not.toContain("server_get_record")
		})
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

describe("read-only MCP filter integration (planning-ferment vs implementation-ferment)", () => {
	// These tests verify the registry + profile-manager behaviour (union,
	// inclusion, exclusion) using pre-filtered fixture arrays. They do NOT
	// exercise `isReadOnlyMcpTool` — that predicate lives in
	// src/extensions/mcp-adapter/tool-metadata.ts and is covered by
	// src/extensions/mcp-adapter/tool-metadata.test.ts. Coupling to it here
	// would invert the dependency direction (shared/planning must not import
	// from src/extensions/mcp-adapter).
	//
	// Fixture: three MCP tools behind a server. Only `server_get_record` is
	// read-only-qualified (annotated with readOnlyHint:true).
	const mcpReadOnlyProvider = (): string[] => ["server_get_record"]

	it("planning-ferment: includes read-only MCP tool and excludes write/destructive MCP tools", () => {
		const pi = makeMockPi()
		registerReadOnlyToolProvider(pi, mcpReadOnlyProvider)

		apply("planning-ferment", "ferment", pi)

		const calledWith = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[]
		// Read-only tool is included
		expect(calledWith).toContain("server_get_record")
		// Write tools are NOT included — they're neither in the catalog nor read-only-qualified
		expect(calledWith).not.toContain("server_create_record")
		expect(calledWith).not.toContain("server_delete_record")
		// Catalog tools are still present
		expect(calledWith).toContain("read")
	})

	it("planning-ferment: heuristic-only read-only tool (no annotations) is included", () => {
		// A separate provider whose read-only set is hardcoded — simulates a
		// server that classified its tools via the name heuristic rather than
		// annotations. The fixture asserts the registry treats it as read-only.
		const pi = makeMockPi()
		registerReadOnlyToolProvider(pi, () => ["server_search_items"])

		apply("planning-ferment", "ferment", pi)

		const calledWith = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[]
		expect(calledWith).toContain("server_search_items")
		expect(calledWith).not.toContain("server_update_record")
	})

	it("planning-adhoc: includes read-only MCP tool and excludes write MCP tools", () => {
		const pi = makeMockPi()
		registerReadOnlyToolProvider(pi, mcpReadOnlyProvider)

		apply("planning-adhoc", "adhoc", pi)

		const calledWith = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[]
		// Read-only tool is included
		expect(calledWith).toContain("server_get_record")
		// Write tools are NOT included
		expect(calledWith).not.toContain("server_create_record")
		expect(calledWith).not.toContain("server_delete_record")
	})

	it("implementation-ferment: includes ALL MCP tools (read and write)", () => {
		const pi = makeMockPi({
			allTools: [
				{ name: "read" },
				{ name: "bash" },
				{ name: "server_get_record" }, // read-only MCP
				{ name: "server_create_record" }, // write MCP
				{ name: "server_delete_record" }, // destructive MCP
			],
		})
		registerReadOnlyToolProvider(pi, mcpReadOnlyProvider)

		apply("implementation-ferment", "ferment", pi)

		const calledWith = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[]
		// All MCP tools are present — implementation phase has full access
		expect(calledWith).toContain("server_get_record")
		expect(calledWith).toContain("server_create_record")
		expect(calledWith).toContain("server_delete_record")
		// Core tools still present
		expect(calledWith).toContain("read")
		expect(calledWith).toContain("bash")
	})

	it("planning-ferment: write MCP tool is NOT added even if present in getAllTools", () => {
		// Edge case: the write tool is registered in pi.getAllTools() (so it would
		// appear under implementation-ferment), but planning-ferment must still
		// exclude it because it's not read-only-qualified and not in the catalog.
		const pi = makeMockPi({
			allTools: [
				{ name: "read" },
				{ name: "server_get_record" }, // read-only — should appear
				{ name: "server_create_record" }, // write — must NOT appear
			],
		})
		registerReadOnlyToolProvider(pi, mcpReadOnlyProvider)

		apply("planning-ferment", "ferment", pi)

		const calledWith = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[]
		expect(calledWith).toContain("server_get_record")
		expect(calledWith).not.toContain("server_create_record")
	})
})
