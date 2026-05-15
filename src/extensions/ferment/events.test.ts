import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { FermentEventStore } from "../../ferment/event-store.js"
import type { Ferment } from "../../ferment/types.js"
import { registerFermentEvents } from "./events.js"
import type { FermentRuntime } from "./runtime.js"
import { createDefaultFermentRuntime } from "./runtime.js"

type EventHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown

function createPi() {
	const handlers = new Map<string, EventHandler>()
	const pi = {
		on: (event: string, handler: EventHandler) => {
			handlers.set(event, handler)
		},
		appendEntry: vi.fn(),
		registerFlag: vi.fn(),
		getFlag: vi.fn(),
		getActiveTools: vi.fn(() => ["read", "bash", "create_ferment", "start_step"]),
		getAllTools: vi.fn(() => [{ name: "read" }, { name: "bash" }, { name: "create_ferment" }, { name: "start_step" }]),
		setActiveTools: vi.fn(),
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
		setModel: vi.fn(),
	} as unknown as ExtensionAPI
	return { handlers, pi }
}

afterEach(() => {
	Reflect.deleteProperty(process.env, "KIMCHI_ACTIVE_FERMENT")
	Reflect.deleteProperty(process.env, "KIMCHI_SUBAGENT")
})

describe("registerFermentEvents", () => {
	it("clears injected runtime state and active cache when env resume id is missing", async () => {
		process.env.KIMCHI_ACTIVE_FERMENT = "missing-ferment-id"
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

	it("builds before_agent_start planner supplement from the injected runtime active ferment", async () => {
		const now = "2026-01-01T00:00:00.000Z"
		const active: Ferment = {
			id: "ferment-1",
			name: "Injected Runtime Plan",
			status: "running",
			mode: "plan",
			worktree: { path: "/repo" },
			scoping: {},
			phases: [],
			decisions: [],
			memories: [],
			createdAt: now,
			updatedAt: now,
		}
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getActive: () => active,
		}
		const { handlers, pi } = createPi()

		registerFermentEvents(pi, runtime)
		const beforeAgentStart = handlers.get("before_agent_start")
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		const result = await beforeAgentStart({ systemPrompt: "base prompt" }, {})

		expect(result).toEqual(
			expect.objectContaining({
				systemPrompt: expect.stringContaining("Ferment Planner Role"),
			}),
		)
		expect((result as { systemPrompt: string }).systemPrompt).toContain("Injected Runtime Plan")
	})

	it("restricts planner tools to the oneshot allowlist on before_agent_start when flag is set", async () => {
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
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
			{ name: "start_step" },
		])

		registerFermentEvents(pi, runtime)
		const beforeAgentStart = handlers.get("before_agent_start")
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		await beforeAgentStart({ systemPrompt: "base" }, {})

		const setActive = pi.setActiveTools as ReturnType<typeof vi.fn>
		const lastCall = setActive.mock.calls[setActive.mock.calls.length - 1][0] as string[]
		expect(lastCall).not.toContain("bash")
		expect(lastCall).not.toContain("edit")
		expect(lastCall).not.toContain("web_search")
		expect(lastCall).toContain("read")
		expect(lastCall).toContain("Agent")
		expect(lastCall).toContain("get_subagent_result")
		expect(lastCall).toContain("scope_ferment")
		expect(lastCall).toContain("start_step")
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
			{ name: "start_step" },
		])

		registerFermentEvents(pi, runtime)
		const beforeAgentStart = handlers.get("before_agent_start")
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		const result = (await beforeAgentStart({ systemPrompt: "base prompt" }, {})) as
			| { systemPrompt?: string }
			| undefined
		expect(result?.systemPrompt).toBeUndefined()
	})

	it("does not restrict planner tools on before_agent_start when flag is unset", async () => {
		const runtime: FermentRuntime = { ...createDefaultFermentRuntime() }
		const { handlers, pi } = createPi()
		;(pi.getFlag as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
		;(pi.getAllTools as ReturnType<typeof vi.fn>).mockReturnValue([
			{ name: "bash" },
			{ name: "edit" },
			{ name: "read" },
			{ name: "Agent" },
			{ name: "scope_ferment" },
		])

		registerFermentEvents(pi, runtime)
		const beforeAgentStart = handlers.get("before_agent_start")
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		await beforeAgentStart({ systemPrompt: "base" }, {})

		expect(pi.setActiveTools).not.toHaveBeenCalled()
	})

	it("does not restrict planner tools in subagent processes (KIMCHI_SUBAGENT=1)", async () => {
		const runtime: FermentRuntime = { ...createDefaultFermentRuntime() }
		const { handlers, pi } = createPi()
		;(pi.getFlag as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
			name === "ferment-oneshot" ? true : undefined,
		)
		;(pi.getAllTools as ReturnType<typeof vi.fn>).mockReturnValue([
			{ name: "bash" },
			{ name: "read" },
			{ name: "Agent" },
		])
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

	it("keeps planner supplement active while a ferment is planned between phases", async () => {
		const now = "2026-01-01T00:00:00.000Z"
		const active: Ferment = {
			id: "ferment-1",
			name: "Between Phases",
			status: "planned",
			mode: "plan",
			worktree: { path: "/repo" },
			scoping: {},
			phases: [
				{ id: "phase-1", index: 1, name: "Done", goal: "G1", status: "completed", steps: [] },
				{ id: "phase-2", index: 2, name: "Next", goal: "G2", status: "planned", steps: [] },
			],
			decisions: [],
			memories: [],
			createdAt: now,
			updatedAt: now,
		}
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getActive: () => active,
		}
		const { handlers, pi } = createPi()

		registerFermentEvents(pi, runtime)
		const beforeAgentStart = handlers.get("before_agent_start")
		if (!beforeAgentStart) throw new Error("before_agent_start handler was not registered")

		const result = await beforeAgentStart({ systemPrompt: "base prompt" }, {})

		expect((result as { systemPrompt: string }).systemPrompt).toContain("Ferment Planner Role")
		expect((result as { systemPrompt: string }).systemPrompt).toContain("Between Phases")
	})

	describe("before_provider_request planner prompt override", () => {
		const ANTHROPIC_BASE = `You are an expert coding assistant. Do NOT spawn a subagent for work you can do in a single tool call.\n\n# Environment\n\n- OS: linux\n- Working directory: "/repo"\n\n## Orchestrate the work\n\nstuff`

		function setupOneshotPlannerPi() {
			const runtime: FermentRuntime = { ...createDefaultFermentRuntime() }
			const { handlers, pi } = createPi()
			;(pi.getFlag as ReturnType<typeof vi.fn>).mockImplementation((name: string) =>
				name === "ferment-oneshot" ? true : undefined,
			)
			registerFermentEvents(pi, runtime)
			const handler = handlers.get("before_provider_request")
			if (!handler) throw new Error("before_provider_request handler was not registered")
			return { handler, pi }
		}

		it("rewrites Anthropic-style string payload.system to the planner-only prompt", async () => {
			const { handler } = setupOneshotPlannerPi()
			const payload = { system: ANTHROPIC_BASE, messages: [] }

			const result = (await handler({ payload }, {})) as { system: string }

			expect(result.system).toContain("PLANNER")
			expect(result.system).toContain("# Environment")
			expect(result.system).toContain(`Working directory: "/repo"`)
			expect(result.system).not.toContain("Do NOT spawn a subagent for work you can do in a single tool call")
			expect(result.system).not.toContain("Orchestrate the work")
		})

		it("rewrites Anthropic array payload.system preserving cache_control on the text block", async () => {
			const { handler } = setupOneshotPlannerPi()
			const payload = {
				system: [{ type: "text", text: ANTHROPIC_BASE, cache_control: { type: "ephemeral" } }],
				messages: [],
			}

			const result = (await handler({ payload }, {})) as {
				system: Array<{ type: string; text: string; cache_control?: { type: string } }>
			}

			expect(result.system).toHaveLength(1)
			expect(result.system[0].type).toBe("text")
			expect(result.system[0].text).toContain("PLANNER")
			expect(result.system[0].text).toContain(`Working directory: "/repo"`)
			expect(result.system[0].cache_control).toEqual({ type: "ephemeral" })
		})

		it("rewrites OpenAI-compatible messages[0] system content", async () => {
			const { handler } = setupOneshotPlannerPi()
			const payload = {
				messages: [
					{ role: "system", content: ANTHROPIC_BASE },
					{ role: "user", content: "hi" },
				],
			}

			const result = (await handler({ payload }, {})) as {
				messages: Array<{ role: string; content: string }>
			}

			expect(result.messages[0].role).toBe("system")
			expect(result.messages[0].content).toContain("PLANNER")
			expect(result.messages[0].content).toContain(`Working directory: "/repo"`)
			expect(result.messages[1]).toEqual({ role: "user", content: "hi" })
		})

		// Regression for the first bench verification run: reasoning models on
		// kimchi-dev's gateway (kimi-k2.6) are emitted with role "developer",
		// not "system". The first run had this path missing and rewrote
		// nothing, so Action 2 (the planner-only frame) was effectively a no-op
		// for every trial.
		it("rewrites OpenAI-compatible messages[0] when role is 'developer' (reasoning models)", async () => {
			const { handler } = setupOneshotPlannerPi()
			const payload = {
				messages: [
					{ role: "developer", content: ANTHROPIC_BASE },
					{ role: "user", content: "hi" },
				],
			}

			const result = (await handler({ payload }, {})) as {
				messages: Array<{ role: string; content: string }>
			}

			expect(result.messages[0].role).toBe("developer")
			expect(result.messages[0].content).toContain("PLANNER")
			expect(result.messages[0].content).toContain(`Working directory: "/repo"`)
			expect(result.messages[0].content).not.toContain(
				"Do NOT spawn a subagent for work you can do in a single tool call",
			)
		})

		it("is a no-op in subagent processes (KIMCHI_SUBAGENT=1)", async () => {
			process.env.KIMCHI_SUBAGENT = "1"
			try {
				const { handler, pi } = setupOneshotPlannerPi()
				const original = ANTHROPIC_BASE
				const payload = { system: original, messages: [] }

				const result = await handler({ payload }, {})

				expect(result).toBeUndefined()
				expect(payload.system).toBe(original)
				expect(pi.appendEntry).not.toHaveBeenCalled()
			} finally {
				Reflect.deleteProperty(process.env, "KIMCHI_SUBAGENT")
			}
		})

		it("is a no-op when ferment-oneshot flag is unset", async () => {
			const runtime: FermentRuntime = { ...createDefaultFermentRuntime() }
			const { handlers, pi } = createPi()
			;(pi.getFlag as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
			registerFermentEvents(pi, runtime)
			const handler = handlers.get("before_provider_request")
			if (!handler) throw new Error("before_provider_request handler was not registered")

			const payload = { system: ANTHROPIC_BASE, messages: [] }
			const result = await handler({ payload }, {})

			expect(result).toBeUndefined()
			expect(payload.system).toBe(ANTHROPIC_BASE)
			expect(pi.appendEntry).not.toHaveBeenCalled()
		})

		it("returns undefined and emits a diagnostic when payload shape is unrecognized", async () => {
			const { handler, pi } = setupOneshotPlannerPi()
			const payload = { weird: "shape" }

			const result = await handler({ payload }, {})

			expect(result).toBeUndefined()
			expect(pi.appendEntry).toHaveBeenCalledWith(
				"ferment_oneshot_prompt_rewrite_skipped",
				expect.objectContaining({ text: expect.stringContaining("unrecognized provider payload shape") }),
			)
		})

		it("logs the unrecognized-shape diagnostic only once per session", async () => {
			const { handler, pi } = setupOneshotPlannerPi()
			const payload = { weird: "shape" }

			await handler({ payload }, {})
			await handler({ payload }, {})
			await handler({ payload }, {})

			const skipCalls = (pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls.filter(
				(call) => call[0] === "ferment_oneshot_prompt_rewrite_skipped",
			)
			expect(skipCalls).toHaveLength(1)
		})

		it("drops trailing text blocks so orchestrator base prompt cannot leak through", async () => {
			const { handler } = setupOneshotPlannerPi()
			const payload = {
				system: [
					{ type: "text", text: ANTHROPIC_BASE, cache_control: { type: "ephemeral" } },
					{ type: "text", text: "Do NOT spawn a subagent for work you can do in a single tool call." },
					{ type: "text", text: "If a step matches your strengths, do it yourself." },
				],
				messages: [],
			}

			const result = (await handler({ payload }, {})) as {
				system: Array<{ type: string; text: string; cache_control?: { type: string } }>
			}

			expect(result.system).toHaveLength(1)
			expect(result.system[0].type).toBe("text")
			expect(result.system[0].text).toContain("PLANNER")
			expect(result.system[0].cache_control).toEqual({ type: "ephemeral" })
			const joined = result.system.map((b) => b.text).join("\n")
			expect(joined).not.toContain("Do NOT spawn a subagent for work you can do in a single tool call")
			expect(joined).not.toContain("do it yourself")
		})
	})
})
