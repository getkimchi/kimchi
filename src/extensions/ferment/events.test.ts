import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Api, Model } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ModelRegistry } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../ferment/event-store.js"
import type { Ferment, Phase } from "../../ferment/types.js"
import { registerFermentEvents } from "./events.js"
import type { FermentRuntime } from "./runtime.js"
import { createDefaultFermentRuntime } from "./runtime.js"
import { clearActiveFermentId } from "./state.js"
import { FERMENT_TOOL_NAMES } from "./tool-names.js"
import { applyFermentToolProfile, profileForFerment } from "./tool-scope.js"

type EventHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown

function createPi() {
	const handlers = new Map<string, EventHandler>()
	let activeTools = ["read", "bash", "start_ferment_step"]
	const pi = {
		on: (event: string, handler: EventHandler) => {
			handlers.set(event, handler)
		},
		appendEntry: vi.fn(),
		registerFlag: vi.fn(),
		getFlag: vi.fn(),
		getActiveTools: vi.fn(() => activeTools),
		getAllTools: vi.fn(() => [
			{ name: "read" },
			{ name: "bash" },
			{ name: "list_ferments" },
			{ name: "scope_ferment" },
			{ name: "activate_ferment_phase" },
			{ name: "start_ferment_step" },
		]),
		setActiveTools: vi.fn((toolNames: string[]) => {
			activeTools = toolNames
		}),
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
		setModel: vi.fn(),
	} as unknown as ExtensionAPI
	return { handlers, pi }
}

afterEach(() => {
	vi.unstubAllEnvs()
	clearActiveFermentId()
	Reflect.deleteProperty(process.env, "KIMCHI_SUBAGENT")
})

describe("registerFermentEvents", () => {
	it("clears injected runtime state and active cache when env resume id is missing", async () => {
		vi.stubEnv("KIMCHI_ACTIVE_FERMENT", "missing-ferment-id")
		const storage = { get: vi.fn(() => undefined) } as unknown as FermentEventStore
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
			setActive: vi.fn(),
			clearAllStepStarts: vi.fn(),
			clearAllScopingGates: vi.fn(),
			clearAllPendingScopes: vi.fn(),
		}
		const { handlers, pi } = createPi()

		registerFermentEvents(pi, runtime)
		const sessionStart = handlers.get("session_start")
		if (!sessionStart) throw new Error("session_start handler was not registered")

		await sessionStart({}, { hasUI: false })

		expect(runtime.clearAllStepStarts).toHaveBeenCalled()
		expect(runtime.clearAllScopingGates).toHaveBeenCalled()
		expect(runtime.clearAllPendingScopes).toHaveBeenCalled()
		expect(storage.get).toHaveBeenCalledWith("missing-ferment-id")
		expect(runtime.setActive).toHaveBeenCalledWith(undefined)
		expect(pi.appendEntry).not.toHaveBeenCalled()
	})

	it("stages one-shot mode during session_start and applies runtime-derived idle profile before first agent run", async () => {
		const storage = { list: vi.fn(() => []) } as unknown as FermentEventStore
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
			setActive: vi.fn(),
		}
		const { handlers, pi } = createPi()
		;(pi.getFlag as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
			name === "ferment-oneshot" ? true : undefined,
		)
		;(pi.getAllTools as ReturnType<typeof vi.fn>).mockReturnValue([
			{ name: "bash" },
			{ name: "read" },
			{ name: "Agent" },
			{ name: "get_subagent_result" },
			{ name: "set_phase" },
			{ name: "list_ferments" },
			{ name: "scope_ferment" },
			{ name: "activate_ferment_phase" },
			{ name: "start_ferment_step" },
		])

		registerFermentEvents(pi, runtime)
		const sessionStart = handlers.get("session_start")
		if (!sessionStart) throw new Error("session_start handler was not registered")

		await sessionStart({}, { hasUI: false })

		expect(runtime.setActive).toHaveBeenCalledWith(undefined)
		expect(pi.getAllTools).not.toHaveBeenCalled()
		// In one-shot mode, confirm_ferment_completion_criteria is hidden via the
		// cooperative visibility layer — this calls pi.setActiveTools once to remove it.
		const setActiveToolsAfterSessionStart = vi.mocked(pi.setActiveTools).mock.calls
		if (setActiveToolsAfterSessionStart.length > 0) {
			// The only permitted call is from disabling confirm_ferment_completion_criteria.
			const lastCall = setActiveToolsAfterSessionStart.at(-1)?.[0] as string[] | undefined
			expect(lastCall).not.toContain("confirm_ferment_completion_criteria")
		}

		const beforeAgentStart = handlers.get("before_agent_start")
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		// Clear spy so we can assert before_agent_start behaviour independently.
		vi.mocked(pi.setActiveTools).mockClear()

		await beforeAgentStart({ systemPrompt: "base" }, {})

		// With no active ferment, before_agent_start must NOT call setActiveTools.
		// Normal chat mode is unrestricted — the toolset stays as-is.
		expect(pi.setActiveTools).not.toHaveBeenCalled()
	})

	it("applies runtime-derived implementation profile on before_agent_start in one-shot mode when ferment has activated phase", async () => {
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getActive: vi.fn(
				() =>
					({
						id: "ferment-oneshot-1",
						status: "running",
						phases: [{ id: "phase-1", status: "active", steps: [] }],
					}) as never,
			),
		}
		const { handlers, pi } = createPi()
		;(pi.getFlag as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
			name === "ferment-oneshot" ? true : undefined,
		)
		;(pi.getAllTools as ReturnType<typeof vi.fn>).mockReturnValue([
			{ name: "bash" },
			{ name: "edit" },
			{ name: "web_search" },
			{ name: "read" },
			{ name: "Agent" },
			{ name: "get_subagent_result" },
			{ name: "scope_ferment" },
			{ name: "start_ferment_step" },
		])

		registerFermentEvents(pi, runtime)
		const beforeAgentStart = handlers.get("before_agent_start")
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		await beforeAgentStart({ systemPrompt: "base" }, {})

		// Unified profile model: the ferment-oneshot flag does NOT trigger a
		// separate allowlist. The runtime's active ferment with an activated
		// phase drives the implementation profile, which includes bash, edit,
		// Agent, and the ferment lifecycle tools.
		const setActive = pi.setActiveTools as ReturnType<typeof vi.fn>
		const lastCall = setActive.mock.calls[setActive.mock.calls.length - 1][0] as string[]
		expect(lastCall).toContain("bash")
		expect(lastCall).toContain("edit")
		expect(lastCall).toContain("web_search")
		expect(lastCall).toContain("read")
		expect(lastCall).toContain("Agent")
		expect(lastCall).toContain("get_subagent_result")
		expect(lastCall).toContain("scope_ferment")
		expect(lastCall).toContain("start_ferment_step")
	})

	it("does not set systemPrompt from before_agent_start in oneshot planner mode", async () => {
		const runtime: FermentRuntime = { ...createDefaultFermentRuntime() }
		const { handlers, pi } = createPi()
		;(pi.getFlag as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
			name === "ferment-oneshot" ? true : undefined,
		)
		;(pi.getAllTools as ReturnType<typeof vi.fn>).mockReturnValue([
			{ name: "Agent" },
			{ name: "read" },
			{ name: "start_ferment_step" },
		])

		registerFermentEvents(pi, runtime)
		const beforeAgentStart = handlers.get("before_agent_start")
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		const result = (await beforeAgentStart({ systemPrompt: "base prompt" }, {})) as
			| { systemPrompt?: string }
			| undefined
		expect(result?.systemPrompt).toBeUndefined()
	})

	it("does not call setActiveTools in normal chat mode (no active ferment)", async () => {
		// When no ferment is active, before_agent_start must leave the toolset
		// untouched so the user gets the full unrestricted tool set.
		const runtime: FermentRuntime = { ...createDefaultFermentRuntime() }
		const { handlers, pi } = createPi()
		;(pi.getFlag as ReturnType<typeof vi.fn>).mockReturnValue(undefined)

		registerFermentEvents(pi, runtime)
		const beforeAgentStart = handlers.get("before_agent_start")
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		await beforeAgentStart({ systemPrompt: "base" }, {})

		expect(pi.setActiveTools).not.toHaveBeenCalled()
	})

	it("active planner first snapshot includes existing-ferment lifecycle tools", async () => {
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getActive: vi.fn(
				() =>
					({
						id: "ferment-1",
						status: "active",
						phases: [{ id: "phase-1", status: "active", steps: [] }],
					}) as never,
			),
		}
		const { handlers, pi } = createPi()
		;(pi.getFlag as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
		;(pi.getAllTools as ReturnType<typeof vi.fn>).mockReturnValue([
			{ name: "read" },
			{ name: "bash" },
			...FERMENT_TOOL_NAMES.map((name) => ({ name })),
		])

		registerFermentEvents(pi, runtime)
		const beforeAgentStart = handlers.get("before_agent_start")
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		await beforeAgentStart({ systemPrompt: "base" }, {})

		const lastCall = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.lastCall?.[0] as string[]
		// Active ferment with an activated phase is in implementation profile:
		// every ferment tool (and any registered user tool like "bash") must be present.
		for (const name of FERMENT_TOOL_NAMES) {
			expect(lastCall).toContain(name)
		}
		expect(lastCall).toContain("bash")
	})

	it("does not call setActiveTools in subagent processes (KIMCHI_SUBAGENT=1)", async () => {
		// Ferment tool exclusion for subagents is handled at session init by
		// agent-runner.ts (EXCLUDED_TOOL_NAMES includes all FERMENT_TOOL_NAMES).
		// before_agent_start must be a no-op for workers so it doesn't override
		// the tool set established by the agents manager.
		const runtime: FermentRuntime = { ...createDefaultFermentRuntime() }
		const { handlers, pi } = createPi()
		process.env.KIMCHI_SUBAGENT = "1"

		registerFermentEvents(pi, runtime)
		const beforeAgentStart = handlers.get("before_agent_start")
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		try {
			await beforeAgentStart({ systemPrompt: "base" }, {})
			expect(pi.setActiveTools).not.toHaveBeenCalled()
		} finally {
			Reflect.deleteProperty(process.env, "KIMCHI_SUBAGENT")
		}
	})

	it("uses the buffered proposal title when draft confirmation happens at turn end", async () => {
		const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-events-title-test-")))
		const draft = storage.create("Draft Raw Intent")
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
		}
		runtime.setActive(draft)
		runtime.setPendingScope(draft.id, {
			title: "Google OAuth Login",
			goal: "Users can sign in with Google OAuth",
			successCriteria: ["OAuth login works"],
			constraints: [],
			phases: [{ name: "Build", goal: "Implement OAuth", steps: [{ description: "Add login flow" }] }],
		})
		const { handlers, pi } = createPi()
		registerFermentEvents(pi, runtime)
		const turnEnd = handlers.get("turn_end")
		if (!turnEnd) throw new Error("turn_end handler was not registered")
		const select = vi.fn().mockResolvedValueOnce("Yes, this looks right").mockResolvedValueOnce("✓ Confirm and start")
		const ctx = {
			ui: {
				select,
				input: vi.fn(),
				notify: vi.fn(),
			},
		}

		await turnEnd(
			{
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Does this look right?" }],
				},
			},
			ctx,
		)

		expect(storage.get(draft.id)?.name).toBe("Google OAuth Login")
		expect(storage.get(draft.id)?.status).toBe("planned")
		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "ferment_ack",
				details: expect.objectContaining({
					text: 'Named ferment "Google OAuth Login" (was "Draft Raw Intent").',
				}),
			}),
			{ triggerTurn: false },
		)
		expect(ctx.ui.notify).toHaveBeenCalledWith('Plan saved for "Google OAuth Login". 1 phase(s) ready.')
	})

	it("model_select captures the newly-selected model in the judge context", () => {
		const captureJudgeContext = vi.fn()
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			captureJudgeContext,
		}
		const { handlers, pi } = createPi()
		registerFermentEvents(pi, runtime)

		const handler = handlers.get("model_select")
		if (!handler) throw new Error("model_select handler was not registered")

		const newModel = { id: "new-model" } as unknown as Model<Api>
		const previousModel = { id: "previous-model" } as unknown as Model<Api>
		const modelRegistry = {} as ModelRegistry
		const ctx = { modelRegistry }

		handler({ model: newModel, previousModel }, ctx)

		expect(captureJudgeContext).toHaveBeenCalledWith(newModel, modelRegistry)
	})

	it("transitions profile from planning to implementation when activate_ferment_phase succeeds", async () => {
		// Build a Ferment with all phases in "planned" status.
		const basePhase: Phase = {
			id: "phase-1",
			index: 1,
			name: "Build",
			goal: "Implement feature",
			status: "planned",
			steps: [],
		}
		const plannedFerment: Ferment = {
			id: "ferment-1",
			name: "Test Ferment",
			status: "planned",
			worktree: { path: "/tmp" },
			scoping: {},
			phases: [basePhase],
			decisions: [],
			memories: [],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		}

		// After scope_ferment, phases are still all "planned" → profile should be "planning".
		// We simulate this by checking profileForFerment directly.
		expect(profileForFerment(plannedFerment)).toBe("planning")

		// Simulate "scoped" ferment: still all planned (scope_ferment doesn't change phase status).
		const scopedFerment: Ferment = {
			...plannedFerment,
			phases: [{ ...basePhase }],
		}
		expect(profileForFerment(scopedFerment)).toBe("planning")

		// Simulate "activated" ferment: one phase has status "active" → profile should be "implementation".
		const activatedFerment: Ferment = {
			...plannedFerment,
			phases: [{ ...basePhase, status: "active" }],
		}
		expect(profileForFerment(activatedFerment)).toBe("implementation")

		// Create runtime with the activated ferment as active.
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getActive: vi.fn(() => activatedFerment),
		}

		const { handlers, pi } = createPi()
		;(pi.getFlag as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
		;(pi.getAllTools as ReturnType<typeof vi.fn>).mockReturnValue([
			{ name: "read" },
			{ name: "bash" },
			{ name: "edit" },
			{ name: "write" },
			{ name: "Agent" },
			{ name: "get_subagent_result" },
			{ name: "list_ferments" },
			{ name: "scope_ferment" },
			{ name: "activate_ferment_phase" },
			{ name: "start_ferment_step" },
		])

		registerFermentEvents(pi, runtime)

		// Simulate before_agent_start: this is where the implicit transition happens.
		const beforeAgentStart = handlers.get("before_agent_start")
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		await beforeAgentStart({ systemPrompt: "base" }, {})

		// With an activated ferment (implementation phase), pi.setActiveTools should have
		// been called with the full toolset (implementation profile).
		const lastCall = (pi.setActiveTools as ReturnType<typeof vi.fn>).mock.lastCall?.[0] as string[]
		expect(lastCall).toContain("bash")
		expect(lastCall).toContain("edit")
		expect(lastCall).toContain("write")
		expect(lastCall).toContain("Agent")
		expect(lastCall).toContain("activate_ferment_phase")
	})
})
