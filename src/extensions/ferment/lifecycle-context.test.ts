import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { Ferment, FermentStatus } from "../../ferment/types.js"
import { createContext } from "../__mocks__/context.js"
import { runAsAgentWorker } from "../agent-worker-context.js"
import { registerFermentLifecycleContext } from "./lifecycle-context.js"
import { createDefaultFermentRuntime, type FermentRuntime } from "./runtime.js"
import type { ContinuationPolicy } from "./state.js"

const getMultiModelEnabledMock = vi.fn(() => true)
vi.mock("../multi-model.js", (importOriginal) => {
	return importOriginal<typeof import("../multi-model.js")>().then((mod) => ({
		...mod,
		getMultiModelEnabled: () => getMultiModelEnabledMock(),
	}))
})

type ExtensionHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>

const TEST_SESSION_ID = "test-session"

function makeMockCtx(): ExtensionContext {
	return createContext({ sessionManager: { getSessionId: () => TEST_SESSION_ID } })
}

function makeFerment(overrides: Partial<Ferment> = {}): Ferment {
	return {
		id: "ferment-1",
		name: "Test Ferment",
		status: "running",
		worktree: { path: "/repo" },
		scoping: {},
		phases: [
			{
				id: "phase-1",
				index: 1,
				name: "Build the feature",
				goal: "Ship it",
				status: "active",
				steps: [
					{ id: "step-1", index: 1, description: "Do thing one", status: "done" },
					{ id: "step-2", index: 2, description: "Do thing two", status: "pending" },
				],
			},
		],
		decisions: [],
		memories: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	}
}

function makeRuntime(fermentOverrides: Partial<Ferment> = {}, policy: ContinuationPolicy = "manual"): FermentRuntime {
	const ferment = makeFerment(fermentOverrides)
	return {
		...createDefaultFermentRuntime(),
		getActive: () => ferment,
		getContinuationPolicy: () => policy,
	}
}

function makeNoActiveRuntime(): FermentRuntime {
	return {
		...createDefaultFermentRuntime(),
		getActive: () => undefined,
	}
}

type ContextResult = { messages: Array<{ role?: string; customType?: string; content?: unknown }> } | undefined

function createHarness() {
	const handlers = new Map<string, ExtensionHandler[]>()
	const pi = {
		on: vi.fn((event: string, handler: ExtensionHandler) => {
			const list = handlers.get(event) ?? []
			list.push(handler)
			handlers.set(event, list)
		}),
	} as unknown as ExtensionAPI

	const ctx = makeMockCtx()

	async function fireContext(
		messages: Array<{ role?: string; customType?: string; content?: unknown }> = [],
	): Promise<ContextResult> {
		let result: ContextResult
		for (const handler of handlers.get("context") ?? []) {
			result = (await handler({ messages }, ctx)) as ContextResult
		}
		return result
	}

	return { pi, ctx, fireContext }
}

function extractLifecycleMessage(result: ContextResult): { content?: string } | undefined {
	const message = result?.messages?.find((m) => m.role === "custom" && m.customType === "ferment-lifecycle")
	if (!message) return undefined
	return { content: typeof message.content === "string" ? message.content : undefined }
}

describe("registerFermentLifecycleContext", () => {
	beforeEach(() => {
		getMultiModelEnabledMock.mockReturnValue(true)
	})

	it("injects volatile lifecycle state for a running ferment with an active phase", async () => {
		const { pi, fireContext } = createHarness()
		registerFermentLifecycleContext(pi, makeRuntime())

		const result = await fireContext([])
		const lifecycle = extractLifecycleMessage(result)
		expect(lifecycle).toBeDefined()
		expect(lifecycle?.content).toContain("## Current lifecycle state")
		expect(lifecycle?.content).toContain('Scoping is COMPLETE (ferment status "running"')
		expect(lifecycle?.content).toContain(
			'active phase "phase-1" ("Build the feature"), 1/2 steps terminal in phase "phase-1"',
		)
		expect(lifecycle?.content).toContain("Next action:")
	})

	it("injects the next-action hint for a planned ferment", async () => {
		const { pi, fireContext } = createHarness()
		const phase = makeFerment().phases[0]
		if (!phase) throw new Error("expected phase fixture")
		registerFermentLifecycleContext(
			pi,
			makeRuntime({
				status: "planned",
				phases: [{ ...phase, status: "planned" }],
			}),
		)

		const result = await fireContext([])
		const lifecycle = extractLifecycleMessage(result)
		expect(lifecycle).toBeDefined()
		expect(lifecycle?.content).toContain('ferment status "planned"')
		expect(lifecycle?.content).toContain("Next action: call `activate_ferment_phase`")
		expect(lifecycle?.content).toContain('phase_id "phase-1"')
	})

	it("counts failed steps as terminal in active-phase progress", async () => {
		const { pi, fireContext } = createHarness()
		const phase = makeFerment().phases[0]
		if (!phase) throw new Error("expected phase fixture")
		registerFermentLifecycleContext(
			pi,
			makeRuntime({
				phases: [
					{
						...phase,
						steps: [{ id: "step-1", index: 1, description: "Broken step", status: "failed" }],
					},
				],
			}),
		)

		const result = await fireContext([])
		const lifecycle = extractLifecycleMessage(result)
		expect(lifecycle?.content).toContain('1/1 steps terminal in phase "phase-1"')
	})

	it("reports progress for every active phase in a parallel group", async () => {
		const { pi, fireContext } = createHarness()
		const phase = makeFerment().phases[0]
		if (!phase) throw new Error("expected phase fixture")
		registerFermentLifecycleContext(
			pi,
			makeRuntime({
				phases: [
					{ ...phase, parallel: true, groupIndex: 1 },
					{
						...phase,
						id: "phase-2",
						index: 2,
						name: "Test the feature",
						parallel: true,
						groupIndex: 1,
						steps: [{ id: "step-3", index: 1, description: "Test it", status: "pending" }],
					},
				],
			}),
		)

		const result = await fireContext([])
		const lifecycle = extractLifecycleMessage(result)
		expect(lifecycle?.content).toContain('1/2 steps terminal in phase "phase-1"')
		expect(lifecycle?.content).toContain('0/1 steps terminal in phase "phase-2"')
	})

	for (const status of ["draft", "paused", "complete", "abandoned"] as FermentStatus[]) {
		it(`does not inject for a ${status} ferment`, async () => {
			const { pi, fireContext } = createHarness()
			registerFermentLifecycleContext(pi, makeRuntime({ status }))

			const result = await fireContext([])
			expect(extractLifecycleMessage(result)).toBeUndefined()
		})
	}

	it("does not inject when no ferment is active", async () => {
		const { pi, fireContext } = createHarness()
		registerFermentLifecycleContext(pi, makeNoActiveRuntime())

		const result = await fireContext([])
		expect(extractLifecycleMessage(result)).toBeUndefined()
	})

	it("does not inject for agent workers", async () => {
		const { pi, fireContext } = createHarness()
		registerFermentLifecycleContext(pi, makeRuntime())

		await runAsAgentWorker(async () => {
			const result = await fireContext([])
			expect(extractLifecycleMessage(result)).toBeUndefined()
		})
	})

	it("strips prior lifecycle messages so they do not stack", async () => {
		const { pi, fireContext } = createHarness()
		registerFermentLifecycleContext(pi, makeRuntime())

		const first = await fireContext([])
		const firstMessage = extractLifecycleMessage(first)
		expect(firstMessage).toBeDefined()

		const second = await fireContext(first?.messages ?? [])
		const lifecycleMessages = second?.messages?.filter(
			(m) => m.role === "custom" && m.customType === "ferment-lifecycle",
		)
		expect(lifecycleMessages).toHaveLength(1)
		expect(second?.messages?.at(-1)?.content).toBe(firstMessage?.content)
	})

	it("uses the multi-model flag to shape delegation hints", async () => {
		const { pi, fireContext } = createHarness()
		getMultiModelEnabledMock.mockReturnValue(false)
		registerFermentLifecycleContext(pi, makeRuntime())

		const result = await fireContext([])
		const lifecycle = extractLifecycleMessage(result)
		// In single-model mode, the next-action suffix tells the planner it may
		// execute the step directly instead of always spawning a subagent.
		expect(lifecycle?.content).toContain("or execute the step directly")
	})
})
