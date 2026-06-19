import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("./agent-runner.js", () => ({
	runAgent: vi.fn(),
	resumeAgent: vi.fn(),
}))

import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { AgentManager, buildAgentOutcome } from "./agent-manager.js"
import { resumeAgent, runAgent } from "./agent-runner.js"

const mockRunAgent = vi.mocked(runAgent)
const mockResumeAgent = vi.mocked(resumeAgent)

function fakePi(): ExtensionAPI {
	return {} as ExtensionAPI
}

function fakeCtx(): ExtensionContext {
	return {} as ExtensionContext
}

describe("AgentManager", () => {
	let manager: AgentManager | undefined

	afterEach(() => {
		manager?.dispose()
		manager = undefined
		vi.clearAllMocks()
	})

	it("marks a run as aborted when runAgent reports an abort", async () => {
		mockRunAgent.mockResolvedValueOnce({
			responseText: "partial output",
			session: { dispose: vi.fn() } as unknown as AgentSession,
			aborted: true,
			abortReason: "token_budget",
			steered: false,
		})
		manager = new AgentManager()

		const record = await manager.spawnAndWait(fakePi(), fakeCtx(), "Explore", "inspect", {
			description: "inspect",
		})

		expect(record.status).toBe("aborted")
		expect(record.abortReason).toBe("token_budget")
		expect(record.result).toBe("partial output")
		expect(record.latestOutcome).toMatchObject({
			agent_id: record.id,
			status: "aborted",
			outcome: "budget_exhausted",
			reason: "token_budget",
			resumable: true,
		})
		expect(record.latestOutcome?.recovery_guidance).toContain("direct continuation")
		expect(record.latestOutcome?.recovery_guidance).toContain("clean narrower task boundary")
	})

	it("threads task_ref and max_turns into the structured outcome", async () => {
		mockRunAgent.mockResolvedValueOnce({
			responseText: "done",
			session: { dispose: vi.fn() } as unknown as AgentSession,
			aborted: false,
			steered: false,
			turnsUsed: 3,
			maxTurns: 5,
		})
		manager = new AgentManager()

		const taskRef = { kind: "ferment_step" as const, ferment_id: "f1", phase_id: "phase-1", step_id: "step-1" }
		const record = await manager.spawnAndWait(fakePi(), fakeCtx(), "Explore", "inspect", {
			description: "inspect",
			maxTurns: 5,
			taskRef,
		})

		expect(record.latestOutcome).toMatchObject({
			outcome: "completed",
			turns_used: 3,
			max_turns: 5,
			task_ref: taskRef,
		})
		expect(mockRunAgent).toHaveBeenCalledWith(
			expect.anything(),
			"Explore",
			expect.stringContaining(`Agent ID: ${record.id}`),
			expect.anything(),
		)
	})

	it("stores submitted reports on the structured outcome", async () => {
		mockRunAgent.mockResolvedValueOnce({
			responseText: "done",
			session: { dispose: vi.fn() } as unknown as AgentSession,
			aborted: false,
			steered: false,
		})
		manager = new AgentManager()
		const taskRef = { kind: "ferment_step" as const, ferment_id: "f1", phase_id: "phase-1", step_id: "step-1" }
		const record = await manager.spawnAndWait(fakePi(), fakeCtx(), "Explore", "inspect", {
			description: "inspect",
			taskRef,
		})

		manager.submitReport(record.id, {
			status: "completed",
			summary: "implemented step",
			steps_completed: ["implemented"],
			remaining_steps: [],
			submitted_at: 10,
		})

		expect(record.latestOutcome).toMatchObject({
			report: {
				status: "completed",
				summary: "implemented step",
				remaining_steps: [],
			},
		})
		expect(record.latestOutcome?.summary).toBeUndefined()
	})

	it("resumes the same session with a fresh max_turns window and records budget exhaustion", async () => {
		const session = { dispose: vi.fn() } as unknown as AgentSession
		mockRunAgent.mockResolvedValueOnce({
			responseText: "checkpoint",
			session,
			aborted: true,
			abortReason: "max_turns",
			steered: false,
			turnsUsed: 2,
			maxTurns: 2,
		})
		mockResumeAgent.mockResolvedValueOnce({
			responseText: "still partial",
			session,
			aborted: true,
			abortReason: "max_turns",
			steered: false,
			turnsUsed: 1,
			maxTurns: 1,
		})
		manager = new AgentManager()
		const record = await manager.spawnAndWait(fakePi(), fakeCtx(), "Explore", "inspect", {
			description: "inspect",
			maxTurns: 2,
		})

		const resumed = await manager.resume(record.id, "finish", { maxTurns: 1, tokenBudget: 2048 })

		expect(resumed?.session).toBe(session)
		expect(mockResumeAgent).toHaveBeenCalledWith(session, "finish", expect.objectContaining({ maxTurns: 1 }))
		expect(resumed?.resumeAttempts).toHaveLength(1)
		expect(resumed?.latestOutcome).toMatchObject({
			outcome: "budget_exhausted",
			reason: "max_turns",
			turns_used: 1,
			max_turns: 1,
		})
	})

	it("does not apply the Ferment resume cap to ordinary agents", async () => {
		const session = { dispose: vi.fn() } as unknown as AgentSession
		mockRunAgent.mockResolvedValueOnce({
			responseText: "checkpoint",
			session,
			aborted: false,
			steered: false,
		})
		mockResumeAgent.mockResolvedValueOnce({
			responseText: "continued",
			session,
			aborted: false,
			steered: false,
			turnsUsed: 1,
			maxTurns: 1,
		})
		manager = new AgentManager()
		const record = await manager.spawnAndWait(fakePi(), fakeCtx(), "Explore", "inspect", {
			description: "inspect",
		})
		record.resumeAttempts = [{ startedAt: 1 }, { startedAt: 2 }]

		const resumed = await manager.resume(record.id, "continue", { maxTurns: 1 })

		expect(mockResumeAgent).toHaveBeenCalled()
		expect(resumed?.status).toBe("completed")
	})

	it("caps Ferment-linked worker resumes", async () => {
		const session = { dispose: vi.fn() } as unknown as AgentSession
		mockRunAgent.mockResolvedValueOnce({
			responseText: "checkpoint",
			session,
			aborted: false,
			steered: false,
		})
		manager = new AgentManager()
		const taskRef = { kind: "ferment_step" as const, ferment_id: "f1", phase_id: "phase-1", step_id: "step-1" }
		const record = await manager.spawnAndWait(fakePi(), fakeCtx(), "Explore", "inspect", {
			description: "inspect",
			taskRef,
		})
		record.resumeAttempts = [{ startedAt: 1 }, { startedAt: 2 }]

		const resumed = await manager.resume(record.id, "continue", { maxTurns: 1 })

		expect(mockResumeAgent).not.toHaveBeenCalled()
		expect(resumed?.status).toBe("error")
		expect(resumed?.error).toContain("Ferment worker resume limit")
	})

	it("describes max_duration failures as stalled work instead of budget exhaustion", () => {
		const outcome = buildAgentOutcome({
			id: "agent-1",
			type: "Explore",
			description: "inspect",
			visibility: "user",
			status: "aborted",
			abortReason: "max_duration",
			startedAt: 1,
			completedAt: 2,
			result: "partial checkpoint",
			toolUses: 0,
			lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			compactionCount: 0,
			resumeAttempts: [],
		})

		expect(outcome.outcome).toBe("failed")
		expect(outcome.reason).toBe("max_duration")
		expect(outcome.recovery_guidance).toContain("stalled operation")
		expect(outcome.recovery_guidance).toContain("narrower linked replacement")
	})
})

describe("AgentManager visibility", () => {
	it("stores system visibility on queued records", () => {
		const manager = new AgentManager(undefined, 0)
		try {
			const first = manager.spawn({} as never, {} as never, "General-Purpose", "one", {
				description: "visible agent",
				isBackground: true,
			})
			const second = manager.spawn({} as never, {} as never, "General-Purpose", "two", {
				description: "system agent",
				isBackground: true,
				visibility: "system",
			})

			expect(manager.getRecord(first)?.visibility).toBe("user")
			expect(manager.getRecord(second)?.visibility).toBe("system")
			expect(manager.getRecord(second)?.status).toBe("queued")
		} finally {
			manager.dispose()
		}
	})
})
