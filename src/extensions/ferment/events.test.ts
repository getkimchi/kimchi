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
})
