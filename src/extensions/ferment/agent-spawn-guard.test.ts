import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { Ferment } from "../../ferment/types.js"
import * as agentWorkerContext from "../agent-worker-context.js"
import { registerAgentSpawnGuard } from "./agent-spawn-guard.js"
import { createDefaultFermentRuntime } from "./runtime.js"
import { setActive } from "./state.js"

type StepStub = {
	id: string
	index: number
	description: string
	status: "pending" | "running" | "done" | "skipped" | "verified" | "failed"
}

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

	// ─── Argument-aware path (task_ref present) ────────────────────────────

	it("allows Agent spawn when task_ref points at a running step", async () => {
		const pi = makePi()
		const runtime = createDefaultFermentRuntime()
		runtime.setActive(
			makeFerment("running", [
				{ id: "step-1", index: 1, description: "active work", status: "running" },
				{ id: "step-2", index: 2, description: "queued work", status: "pending" },
			]),
		)
		registerAgentSpawnGuard(pi as unknown as ExtensionAPI, runtime)

		const result = await pi.fireAll("tool_call", {
			toolName: "Agent",
			input: {
				task_ref: {
					kind: "ferment_step",
					ferment_id: "019ea6ea-e768-717f-a8f3-63cd6755637b",
					phase_id: "phase-1",
					step_id: "step-1",
				},
			},
		})
		expect(result).toEqual({ block: false })
	})

	it("blocks Agent spawn when task_ref.ferment_id does not match the active ferment", async () => {
		// Regression: phase/step IDs like "phase-1" / "step-1" are reused across
		// ferments. Without checking ferment_id, a stale task_ref from a previous
		// ferment would silently match the active ferment's step-1 and be allowed
		// or blocked based on the wrong ferment's step state.
		const pi = makePi()
		const runtime = createDefaultFermentRuntime()
		runtime.setActive(
			makeFerment("running", [{ id: "step-1", index: 1, description: "active work", status: "running" }]),
		)
		registerAgentSpawnGuard(pi as unknown as ExtensionAPI, runtime)

		const result = (await pi.fireAll("tool_call", {
			toolName: "Agent",
			input: {
				task_ref: {
					kind: "ferment_step",
					ferment_id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
					phase_id: "phase-1",
					step_id: "step-1",
				},
			},
		})) as { block: boolean; reason: string }
		expect(result.block).toBe(true)
		expect(result.reason).toContain("stale or belongs to a different ferment")
		expect(result.reason).toContain("start_ferment_step")
	})

	it("blocks Agent spawn when task_ref points at a pending step", async () => {
		const pi = makePi()
		const runtime = createDefaultFermentRuntime()
		runtime.setActive(
			makeFerment("running", [
				{ id: "step-1", index: 1, description: "active work", status: "running" },
				{ id: "step-2", index: 2, description: "queued work", status: "pending" },
			]),
		)
		registerAgentSpawnGuard(pi as unknown as ExtensionAPI, runtime)

		const result = (await pi.fireAll("tool_call", {
			toolName: "Agent",
			input: {
				task_ref: {
					kind: "ferment_step",
					ferment_id: "019ea6ea-e768-717f-a8f3-63cd6755637b",
					phase_id: "phase-1",
					step_id: "step-2",
				},
			},
		})) as { block: boolean; reason: string }
		expect(result.block).toBe(true)
		expect(result.reason).toContain("step 2")
		expect(result.reason).toContain("queued work")
		expect(result.reason).toContain("start_ferment_step")
	})

	it("allows Agent spawn when task_ref points at a terminal step", async () => {
		const pi = makePi()
		const runtime = createDefaultFermentRuntime()
		runtime.setActive(
			makeFerment("running", [{ id: "step-1", index: 1, description: "finished work", status: "done" }]),
		)
		registerAgentSpawnGuard(pi as unknown as ExtensionAPI, runtime)

		const result = await pi.fireAll("tool_call", {
			toolName: "Agent",
			input: {
				task_ref: {
					kind: "ferment_step",
					ferment_id: "019ea6ea-e768-717f-a8f3-63cd6755637b",
					phase_id: "phase-1",
					step_id: "step-1",
				},
			},
		})
		expect(result).toEqual({ block: false })
	})

	it("allows Agent spawn when task_ref points at a step in a drifted/unknown phase", async () => {
		const pi = makePi()
		const runtime = createDefaultFermentRuntime()
		runtime.setActive(makeFerment("running", [{ id: "step-1", index: 1, description: "x", status: "running" }]))
		registerAgentSpawnGuard(pi as unknown as ExtensionAPI, runtime)

		const result = await pi.fireAll("tool_call", {
			toolName: "Agent",
			input: {
				task_ref: {
					kind: "ferment_step",
					ferment_id: "019ea6ea-e768-717f-a8f3-63cd6755637b",
					phase_id: "phase-missing",
					step_id: "step-1",
				},
			},
		})
		expect(result).toEqual({ block: false })
	})

	// ─── Fallback path (no task_ref — helper agents like Explore, Reviewer) ─

	it("allows helper Agent (no task_ref) when a step is running and a sibling is pending", async () => {
		// Regression for the delegation deadlock: before the fix, the engine
		// returned start_step for the pending sibling, which blocked all Agent
		// dispatch — including legitimate helpers. Now the engine returns
		// complete_step for the running step, so the fallback allows dispatch.
		const pi = makePi()
		const runtime = createDefaultFermentRuntime()
		runtime.setActive(
			makeFerment("running", [
				{ id: "step-1", index: 1, description: "active work", status: "running" },
				{ id: "step-2", index: 2, description: "queued work", status: "pending" },
			]),
		)
		registerAgentSpawnGuard(pi as unknown as ExtensionAPI, runtime)

		const result = await pi.fireAll("tool_call", { toolName: "Agent" })
		expect(result).toEqual({ block: false })
	})

	it("allows malformed task_ref to fall through to engine check", async () => {
		const pi = makePi()
		const runtime = createDefaultFermentRuntime()
		runtime.setActive(makeFerment("running", [{ id: "step-1", index: 1, description: "x", status: "pending" }]))
		registerAgentSpawnGuard(pi as unknown as ExtensionAPI, runtime)

		// task_ref with wrong shape is ignored; falls back to engine check.
		const result = (await pi.fireAll("tool_call", {
			toolName: "Agent",
			input: { task_ref: { kind: "not_ferment_step" } },
		})) as { block: boolean; reason: string }
		expect(result.block).toBe(true)
		expect(result.reason).toContain("start_ferment_step")
	})
})
