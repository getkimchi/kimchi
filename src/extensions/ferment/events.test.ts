import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { FermentEventStore } from "../../ferment/event-store.js"
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
		getActiveTools: vi.fn(() => ["read", "bash", "create_ferment", "start_ferment_step"]),
		getAllTools: vi.fn(() => [
			{ name: "read" },
			{ name: "bash" },
			{ name: "create_ferment" },
			{ name: "start_ferment_step" },
		]),
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
			{ name: "start_ferment_step" },
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
})
