import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { createMiniEventBus } from "../../extensions/__mocks__/mini-event-bus.js"
import { createToolVisibility } from "../../extensions/prompt-construction/tool-visibility.js"
import { getToolsForProfile } from "./tool-catalog.js"
import {
	apply,
	applyCooperativeTweak,
	isProviderReadOnlyTool,
	isSnapshotAppliedThisTurn,
	reapplyCurrentProfile,
	registerReadOnlyToolProvider,
	resetAll,
} from "./tool-profile-manager.js"

const FERMENT_V2_TOOL_NAMES = ["get_ferment_v2", "update_ferment_v2"]

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

const mockIsDefaultToolEnabled = vi.fn((_name: string) => true)
vi.mock("../../settings-watcher.js", () => ({
	isDefaultToolEnabled: (name: string) => mockIsDefaultToolEnabled(name),
}))

// Reset module-level state before every test so runs are fully independent
// even though the ESM module is evaluated once per VM.
beforeEach(() => {
	resetAll()
	mockIsDefaultToolEnabled.mockReset().mockReturnValue(true)
})

describe("apply", () => {
	it("(a) calls setActiveTools with the correct tool names and sets the snapshot flag", () => {
		const pi = makeMockPi()
		const profile = "planning-adhoc"
		const expectedTools = getToolsForProfile(profile).map((t) => t.name)

		apply(profile, "adhoc", pi)

		expect(pi.setActiveTools).toHaveBeenCalledOnce()
		expect(pi.setActiveTools).toHaveBeenCalledWith(expectedTools)
		expect(isSnapshotAppliedThisTurn(pi)).toBe(true)
	})

	it("planning profiles admit read-only-qualified provider names", () => {
		const pi = makeMockPi()
		const unregister = registerReadOnlyToolProvider(pi, () => ["srv_get_issue"])

		apply("planning-adhoc", "adhoc", pi)
		expect(vi.mocked(pi.setActiveTools).mock.calls[0][0]).toContain("srv_get_issue")

		// once the provider is gone the catalog-only surface returns
		unregister()
		reapplyCurrentProfile(pi)
		expect(vi.mocked(pi.setActiveTools).mock.calls[1][0]).not.toContain("srv_get_issue")
	})

	it("provider errors never break the planning snapshot, and non-planning profiles ignore providers", () => {
		const pi = makeMockPi()
		registerReadOnlyToolProvider(pi, () => {
			throw new Error("provider blew up")
		})
		registerReadOnlyToolProvider(pi, () => ["srv_get_issue"])

		expect(() => apply("planning-ferment", "ferment", pi)).not.toThrow()
		expect(vi.mocked(pi.setActiveTools).mock.calls[0][0]).toContain("srv_get_issue")

		// idle is not a planning profile: providers are only honoured while planning
		apply("idle", "adhoc", pi)
		expect(vi.mocked(pi.setActiveTools).mock.calls[1][0]).not.toContain("srv_get_issue")
	})

	it("respects defaultTools: `-write` keeps write out of registry-derived snapshots", () => {
		// defaultTools:["-write"] deactivates write at session construction; a
		// profile snapshot unioning getAllTools() must not re-activate it.
		mockIsDefaultToolEnabled.mockImplementation((name) => name !== "write")
		const pi = makeMockPi({ allTools: [{ name: "read" }, { name: "bash" }, { name: "write" }] })

		apply("idle", "adhoc", pi)
		expect(vi.mocked(pi.setActiveTools).mock.calls[0][0]).not.toContain("write")

		apply("implementation-ferment", "ferment", pi)
		// implementation merges the ferment catalog (which includes write) into
		// the registry set; the defaultTools filter must win over both.
		expect(vi.mocked(pi.setActiveTools).mock.calls[1][0]).not.toContain("write")
	})

	it("a provider registered on one pi never surfaces in another pi's snapshot", () => {
		const dapPi = makeMockPi()
		const fermentPi = makeMockPi()
		registerReadOnlyToolProvider(dapPi, () => ["srv_get_issue"])

		apply("planning-adhoc", "adhoc", fermentPi)
		expect(vi.mocked(fermentPi.setActiveTools).mock.calls[0][0]).not.toContain("srv_get_issue")
		expect(isProviderReadOnlyTool(fermentPi, "srv_get_issue")).toBe(false)
	})

	it("shares exact read-only names between extension wrappers in the same session", () => {
		const { events } = createMiniEventBus()
		const mcpPi = makeMockPi({ events })
		const permissionsPi = makeMockPi({ events })
		const unregister = registerReadOnlyToolProvider(mcpPi, () => ["atlassian_getJiraIssue"])
		expect(isProviderReadOnlyTool(permissionsPi, "atlassian_getJiraIssue")).toBe(true)
		expect(isProviderReadOnlyTool(permissionsPi, "atlassian_getjiraissue")).toBe(false)
		unregister()
		expect(isProviderReadOnlyTool(permissionsPi, "atlassian_getJiraIssue")).toBe(false)
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

	it("idle profile filters tools hidden by a cooperative-visibility vote (the powershell-gate regression)", () => {
		// Regression: the powershell gate used to vote only when the tool was
		// already active (it never is), so the idle profile's full-registered-
		// toolset base resurrected it mid-session after the first
		// before_agent_start. With a vote cast (as the fixed gate does at
		// session_start on non-Windows), the idle snapshot must exclude it.
		const pi = makeMockPi({
			allTools: [{ name: "read" }, { name: "bash" }, { name: "powershell" }],
		})
		createToolVisibility(pi).disable(["powershell"])
		// Clear the disable's own setActiveTools call so the assertion observes
		// the apply() snapshot only.
		vi.mocked(pi.setActiveTools).mockClear()

		apply("idle", "ferment", pi)

		expect(pi.setActiveTools).toHaveBeenCalledWith(["read", "bash"])
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

	it("planning-adhoc profile includes Ferment V2 state tools and excludes legacy Ferment/write tools", () => {
		const pi = makeMockPi()

		apply("planning-adhoc", "adhoc", pi)

		const calledWith = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.calls[0][0] as string[]
		for (const name of FERMENT_V2_TOOL_NAMES) {
			expect(calledWith).toContain(name)
		}
		for (const name of ["propose_ferment_scoping", "start_ferment_step", "edit", "write"]) {
			expect(calledWith).not.toContain(name)
		}
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
		expect(isSnapshotAppliedThisTurn(pi)).toBe(false)

		// Apply a snapshot (calls installTurnBoundaryReset internally).
		apply("planning-adhoc", "adhoc", pi)
		expect(isSnapshotAppliedThisTurn(pi)).toBe(true)

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
		expect(isSnapshotAppliedThisTurn(pi)).toBe(false)
	})
})

describe("per-session snapshot flag", () => {
	it("a snapshot in one session does not suppress another session's cooperative tweaks", () => {
		const piA = makeMockPi()
		const piB = makeMockPi()

		apply("planning-adhoc", "adhoc", piA)

		expect(isSnapshotAppliedThisTurn(piA)).toBe(true)
		expect(isSnapshotAppliedThisTurn(piB)).toBe(false)
		// Regression: the flag used to be process-global, so a deferred
		// resnapshot in one session dropped another session's cooperative tweaks.
		expect(applyCooperativeTweak(piB, ["b_tool"])).toBe(true)
	})

	it("turn_start resets only the session whose turn started", () => {
		const piA = makeMockPi()
		const piB = makeMockPi()
		apply("planning-adhoc", "adhoc", piA)
		apply("planning-adhoc", "adhoc", piB)

		const lastTurnStartHandler = (pi: ExtensionAPI) => {
			const mockOn = pi.on as unknown as { mock: { calls: Array<[string, () => void]> } }
			const found = mockOn.mock.calls.filter((call) => call[0] === "turn_start").at(-1)
			if (!found) throw new Error("pi.on was not called with 'turn_start'")
			return found[1]
		}
		lastTurnStartHandler(piA)()

		expect(isSnapshotAppliedThisTurn(piA)).toBe(false)
		expect(isSnapshotAppliedThisTurn(piB)).toBe(true)
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

describe("registry churn resnapshot", () => {
	// A resnapshot fired while the registry is mid-rebuild must not replace the
	// active set with the partial getAllTools() sample: dropped tools stay
	// uncallable for the rest of the turn.
	const FULL_TOOLS = [
		"read",
		"bash",
		"edit",
		"write",
		"grep",
		"find",
		"ls",
		"skill_view",
		"bash_control",
		"mcp",
		"mcp___mcpns_Cast_20_Data_20_Mesh",
		"mcp___mcpns_Cloud_20_Graph",
		"mcp____kimchi_studio_connector__atlassian",
		"mcp__castai",
		"mcp__context7",
		"mcp__npm_search",
		"mcp__sequential_thinking",
		"list_ferments",
		"questionnaire",
		"submit_plan",
		"create_todos",
		"update_todos",
		"add_todo",
		"mark_todo",
		"clear_todos",
		"Agent",
		"set_phase",
		"dispatch_to_cloud_agent",
		"web_fetch",
		"web_search",
		"set_model",
		"list_models",
	]
	const PARTIAL_TOOLS_28 = FULL_TOOLS.filter(
		(n) => !["skill_view", "list_ferments", "set_phase", "list_models"].includes(n),
	)
	const PARTIAL_TOOLS_14 = PARTIAL_TOOLS_28.filter(
		(n) =>
			!["edit", "write", "bash_control", "mcp", "Agent", "dispatch_to_cloud_agent", "set_model"].includes(n) &&
			!n.startsWith("mcp__"),
	)

	const asTools = (names: string[]) => names.map((name) => ({ name }))
	const lastActiveCall = (pi: ExtensionAPI): string[] => vi.mocked(pi.setActiveTools).mock.calls.at(-1)?.[0] ?? []

	it("a reapply against a mid-rebuild registry preserves the previously active tools", () => {
		const pi = makeMockPi({ allTools: asTools(FULL_TOOLS) })
		apply("idle", "adhoc", pi)
		expect(pi.getActiveTools()).toHaveLength(32)

		// Registry shows 28 of 32.
		;(pi.getAllTools as ReturnType<typeof vi.fn>).mockReturnValue(asTools(PARTIAL_TOOLS_28))
		expect(reapplyCurrentProfile(pi)).toBe(true)
		expect(lastActiveCall(pi)).toEqual(expect.arrayContaining(FULL_TOOLS))
		expect(pi.getActiveTools()).toHaveLength(32)

		// Registry down to 14: the narrowing must not stack.
		;(pi.getAllTools as ReturnType<typeof vi.fn>).mockReturnValue(asTools(PARTIAL_TOOLS_14))
		expect(reapplyCurrentProfile(pi)).toBe(true)
		expect(lastActiveCall(pi)).toEqual(expect.arrayContaining(FULL_TOOLS))
		expect(pi.getActiveTools()).toHaveLength(32)

		// Registry rebuilt; the next reapply converges.
		;(pi.getAllTools as ReturnType<typeof vi.fn>).mockReturnValue(asTools(FULL_TOOLS))
		expect(reapplyCurrentProfile(pi)).toBe(true)
		expect(pi.getActiveTools()).toHaveLength(32)
	})

	it("implementation-ferment preserves previously active tools through a partial rebuild", () => {
		const pi = makeMockPi({ allTools: asTools(["read", "bash", "questionnaire"]) })
		apply("implementation-ferment", "ferment", pi)
		expect(pi.getActiveTools()).toEqual(expect.arrayContaining(["read", "bash"]))
		expect(pi.getActiveTools()).not.toContain("questionnaire")

		// Mid-rebuild: only `read` re-registered. reapplyCurrentProfile passes
		// the "resnapshot" trigger, so the active set is unioned back in.
		;(pi.getAllTools as ReturnType<typeof vi.fn>).mockReturnValue(asTools(["read"]))
		expect(reapplyCurrentProfile(pi)).toBe(true)

		const active = lastActiveCall(pi)
		expect(active).toEqual(expect.arrayContaining(["read", "bash"]))
		// Deliberate profile constraints still win: adhoc-only tools stay out.
		expect(active).not.toContain("questionnaire")
	})

	it("a deliberate profile switch replaces instead of carrying the previous profile over", () => {
		// Leaving planning for idle must drop planning's read-only provider
		// admissions rather than carry them through the active set.
		const pi = makeMockPi({ allTools: asTools(["read", "bash", "edit"]) })
		registerReadOnlyToolProvider(pi, () => ["srv_get_issue"])
		apply("planning-adhoc", "adhoc", pi)
		expect(pi.getActiveTools()).toContain("srv_get_issue")

		apply("idle", "adhoc", pi)
		expect(lastActiveCall(pi)).not.toContain("srv_get_issue")
	})
})

describe("tool-surface debug logging", () => {
	it("stays silent unless KIMCHI_DEBUG_TOOL_SURFACE=1, then logs the applied diff", () => {
		const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {})
		try {
			// Flag off: no logging.
			delete process.env.KIMCHI_DEBUG_TOOL_SURFACE
			apply("idle", "adhoc", makeMockPi({ allTools: [{ name: "read" }, { name: "bash" }] }))
			expect(debugSpy).not.toHaveBeenCalled()

			// Flag on: first apply logs the addition.
			process.env.KIMCHI_DEBUG_TOOL_SURFACE = "1"
			const pi = makeMockPi({ allTools: [{ name: "read" }, { name: "bash" }] })
			apply("idle", "adhoc", pi)
			expect(debugSpy).toHaveBeenCalledTimes(1)
			const line = debugSpy.mock.calls[0]?.[0] as string
			expect(line).toContain("[tool-surface] apply profile=idle")
			expect(line).toContain("trigger=apply")
			expect(line).toContain("added=[read,bash]")

			// Same-profile re-apply: nothing new added.
			apply("idle", "adhoc", pi)
			const second = debugSpy.mock.calls[1]?.[0] as string
			expect(second).not.toContain("added=[")
		} finally {
			delete process.env.KIMCHI_DEBUG_TOOL_SURFACE
			debugSpy.mockRestore()
		}
	})
})
