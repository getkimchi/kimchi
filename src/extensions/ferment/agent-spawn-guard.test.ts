import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Ferment } from "../../ferment/types.js"
import * as agentWorkerContext from "../agent-worker-context.js"
import { registerAgentSpawnGuard } from "./agent-spawn-guard.js"
import { createDefaultFermentRuntime } from "./runtime.js"
import { setActive } from "./state.js"

type StepStub = { id: string; index: number; description: string; status: "pending" | "running" }

function makeFerment(status: Ferment["status"], steps: StepStub[]): Ferment {
	// A non-running ferment has no active phase. Only set activePhaseId when the
	// ferment is actually running so the fixture reflects a state the engine
	// could reach in production.
	const activePhaseId = status === "running" ? "phase-1" : undefined
	const phaseStatus = status === "running" ? "active" : "planned"
	return {
		id: "019ea6ea-e768-717f-a8f3-63cd6755637b",
		name: "Fix cluster advisor",
		status,
		worktree: { path: "/tmp/project" },
		scoping: {},
		activePhaseId,
		phases: [
			{
				id: "phase-1",
				index: 1,
				name: "Signals",
				goal: "propagate VariantType through the workflow",
				status: phaseStatus,
				steps,
			},
		],
		decisions: [],
		memories: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
	}
}

function makePi() {
	const handlers = new Map<string, ((event: unknown, ctx?: unknown) => unknown)[]>()
	return {
		on: (event: string, handler: (event: unknown, ctx?: unknown) => unknown) => {
			const list = handlers.get(event) ?? []
			list.push(handler)
			handlers.set(event, list)
		},
		handlers,
		// Broadcast to every handler, returning the first explicit { block: true }.
		fireAll: async (event: string, eventPayload: unknown, ctx?: unknown) => {
			for (const handler of handlers.get(event) ?? []) {
				const result = await handler(eventPayload, ctx)
				if (result && typeof result === "object" && "block" in result && result.block === true) {
					return result
				}
			}
			return { block: false }
		},
	}
}

afterEach(() => {
	setActive(undefined)
	vi.restoreAllMocks()
})

describe("registerAgentSpawnGuard", () => {
	it("allows Agent spawn when no ferment is active", async () => {
		const pi = makePi()
		registerAgentSpawnGuard(pi as unknown as ExtensionAPI, createDefaultFermentRuntime())

		const result = await pi.fireAll("tool_call", { toolName: "Agent" })
		expect(result).toEqual({ block: false })
	})

	it("allows Agent spawn when active ferment is not running", async () => {
		const pi = makePi()
		const runtime = createDefaultFermentRuntime()
		runtime.setActive(makeFerment("planned", [{ id: "step-1", index: 1, description: "x", status: "pending" }]))
		registerAgentSpawnGuard(pi as unknown as ExtensionAPI, runtime)

		const result = await pi.fireAll("tool_call", { toolName: "Agent" })
		expect(result).toEqual({ block: false })
	})

	it("blocks Agent spawn when engine's next action is start_step", async () => {
		const pi = makePi()
		const runtime = createDefaultFermentRuntime()
		runtime.setActive(
			makeFerment("running", [
				{ id: "step-1", index: 1, description: "Add VariantType to signal structs", status: "pending" },
			]),
		)
		registerAgentSpawnGuard(pi as unknown as ExtensionAPI, runtime)

		const result = (await pi.fireAll("tool_call", { toolName: "Agent" })) as {
			block: boolean
			reason: string
		}
		expect(result.block).toBe(true)
		// Assert on the guard-specific phrasing so a future regression that
		// re-routes the block through another handler with a different reason
		// cannot silently pass this test.
		expect(result.reason).toContain("Add VariantType to signal structs")
		expect(result.reason).toContain("has a pending step that has not been started")
		expect(result.reason).toContain("start_ferment_step")
	})

	it("allows Agent spawn when a step is already running (engine returns complete_step)", async () => {
		const pi = makePi()
		const runtime = createDefaultFermentRuntime()
		runtime.setActive(makeFerment("running", [{ id: "step-1", index: 1, description: "x", status: "running" }]))
		registerAgentSpawnGuard(pi as unknown as ExtensionAPI, runtime)

		const result = await pi.fireAll("tool_call", { toolName: "Agent" })
		expect(result).toEqual({ block: false })
	})

	it("allows Agent spawn when active ferment state is malformed", async () => {
		const pi = makePi()
		const runtime = createDefaultFermentRuntime()
		runtime.setActive({
			...makeFerment("running", [{ id: "step-1", index: 1, description: "x", status: "pending" }]),
			phases: undefined,
		} as unknown as Ferment)
		registerAgentSpawnGuard(pi as unknown as ExtensionAPI, runtime)

		const result = await pi.fireAll("tool_call", { toolName: "Agent" })
		expect(result).toEqual({ block: false })
	})

	it("ignores non-Agent tool calls", async () => {
		const pi = makePi()
		const runtime = createDefaultFermentRuntime()
		runtime.setActive(makeFerment("running", [{ id: "step-1", index: 1, description: "x", status: "pending" }]))
		registerAgentSpawnGuard(pi as unknown as ExtensionAPI, runtime)

		const result = await pi.fireAll("tool_call", { toolName: "bash" })
		expect(result).toEqual({ block: false })
	})

	it("allows Agent spawn inside a subagent worker even when a step is pending", async () => {
		vi.spyOn(agentWorkerContext, "isAgentWorker").mockReturnValue(true)
		const pi = makePi()
		const runtime = createDefaultFermentRuntime()
		runtime.setActive(makeFerment("running", [{ id: "step-1", index: 1, description: "x", status: "pending" }]))
		registerAgentSpawnGuard(pi as unknown as ExtensionAPI, runtime)

		const result = await pi.fireAll("tool_call", { toolName: "Agent" })
		expect(result).toEqual({ block: false })
	})
})
