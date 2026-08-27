import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("./agent-runner.js", () => ({
	runAgent: vi.fn(),
	resumeAgent: vi.fn(),
	MIN_TOKEN_BUDGET: 1024,
	MIN_FINALIZE_TOKEN_BUDGET: 256,
}))

import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { AGENT_MESSAGE_LIMITS, createAgentMessage } from "../messages.js"
import { AgentManager, type AgentParentBridge, buildAgentOutcome } from "./agent-manager.js"
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
		expect(record.latestOutcome?.recovery_guidance).toContain("Do not assume that steps_completed is correct")
		expect(record.latestOutcome?.recovery_guidance).toContain("remaining_steps is necessary")
		expect(record.latestOutcome?.recovery_guidance).toContain("fresh, bounded budget")
		expect(record.latestOutcome?.recovery_guidance).toContain("explicit new instructions")
		expect(record.latestOutcome?.recovery_guidance).toContain("separate, narrower task")
		expect(record.latestOutcome?.recovery_guidance).toContain("going in the wrong direction")
		expect(record.latestOutcome?.recovery_guidance).toContain("resume_subagent with purpose finalize_report")
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
			expect.not.stringContaining("Report token:"),
			expect.anything(),
		)
		expect(mockRunAgent).toHaveBeenCalledWith(
			expect.anything(),
			"Explore",
			expect.stringContaining("Call submit_agent_report alone as your final action"),
			expect.anything(),
		)
		expect(mockRunAgent.mock.calls[0]?.[3].workerReport).toBeDefined()
	})

	it("enforces the selected worker tier on the initial linked run", async () => {
		mockRunAgent.mockResolvedValueOnce({
			responseText: "done",
			session: { dispose: vi.fn() } as unknown as AgentSession,
			aborted: false,
			steered: false,
		})
		manager = new AgentManager()

		const record = await manager.spawnAndWait(fakePi(), fakeCtx(), "Explore", "inspect", {
			description: "inspect",
			maxTurns: 999,
			maxDuration: 999,
			tokenBudget: 999_999,
			taskRef: {
				kind: "ferment_step",
				ferment_id: "f1",
				phase_id: "p1",
				step_id: "s1",
				budget_tier: "narrow",
			},
		})

		expect(record.maxTurns).toBe(10)
		expect(mockRunAgent).toHaveBeenCalledWith(
			expect.anything(),
			"Explore",
			expect.any(String),
			expect.objectContaining({ maxTurns: 10, maxDuration: 180, tokenBudget: 50_000 }),
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

	it("does not resume a worker whose current attempt has an accepted completed report", async () => {
		const session = { dispose: vi.fn() } as unknown as AgentSession
		mockRunAgent.mockResolvedValueOnce({ responseText: "done", session, aborted: false, steered: false })
		manager = new AgentManager()
		const record = await manager.spawnAndWait(fakePi(), fakeCtx(), "Explore", "inspect", {
			description: "inspect",
			taskRef: { kind: "ferment_step", ferment_id: "f1", phase_id: "p1", step_id: "s1" },
		})
		manager.submitReport(record.id, {
			status: "completed",
			summary: "implemented step",
			steps_completed: ["implemented"],
			remaining_steps: [],
		})
		const snapshot = structuredClone({
			status: record.status,
			result: record.result,
			error: record.error,
			completedAt: record.completedAt,
			currentAttemptId: record.currentAttemptId,
			agentReport: record.agentReport,
			latestOutcome: record.latestOutcome,
			resumeAttempts: record.resumeAttempts,
		})

		const resumed = await manager.resume(record.id, "continue", { maxTurns: 1 })

		expect(mockResumeAgent).not.toHaveBeenCalled()
		expect(resumed).toBe(record)
		expect({
			status: record.status,
			result: record.result,
			error: record.error,
			completedAt: record.completedAt,
			currentAttemptId: record.currentAttemptId,
			agentReport: record.agentReport,
			latestOutcome: record.latestOutcome,
			resumeAttempts: record.resumeAttempts,
		}).toEqual(snapshot)
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
		record.resumeAttempts = [
			{ attempt_id: 1, purpose: "continuation", startedAt: 1 },
			{ attempt_id: 2, purpose: "continuation", startedAt: 2 },
		]

		const resumed = await manager.resume(record.id, "continue", { maxTurns: 1 })

		expect(mockResumeAgent).toHaveBeenCalled()
		expect(resumed?.status).toBe("completed")
	})

	it("does not run report finalization for an ordinary agent", async () => {
		const session = { dispose: vi.fn() } as unknown as AgentSession
		mockRunAgent.mockResolvedValueOnce({ responseText: "done", session, aborted: false, steered: false })
		manager = new AgentManager()
		const record = await manager.spawnAndWait(fakePi(), fakeCtx(), "Explore", "inspect", {
			description: "inspect",
		})

		const result = await manager.resume(record.id, undefined, { purpose: "finalize_report" })

		expect(mockResumeAgent).not.toHaveBeenCalled()
		expect(result).toBe(record)
		expect(manager.getResumeBlockReason(record.id, "finalize_report")).toContain("not a Ferment-linked worker")
	})

	it("non-Ferment agent resumed 2+ times still has resumable === true in latestOutcome", async () => {
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
		mockResumeAgent
			.mockResolvedValueOnce({
				responseText: "partial-1",
				session,
				aborted: true,
				abortReason: "max_turns",
				steered: false,
				turnsUsed: 1,
				maxTurns: 1,
			})
			.mockResolvedValueOnce({
				responseText: "partial-2",
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

		await manager.resume(record.id, "continue-1", { maxTurns: 1 })
		const resumed = await manager.resume(record.id, "continue-2", { maxTurns: 1 })

		expect(resumed?.resumeAttempts).toHaveLength(2)
		expect(resumed?.latestOutcome?.resumable).toBe(true)
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
		record.resumeAttempts = [
			{ attempt_id: 1, purpose: "continuation", startedAt: 1 },
			{ attempt_id: 2, purpose: "continuation", startedAt: 2 },
		]
		const previousStatus = record.status
		const previousOutcome = record.latestOutcome
		const previousCompletedAt = record.completedAt

		const resumed = await manager.resume(record.id, "continue", { maxTurns: 1 })

		expect(mockResumeAgent).not.toHaveBeenCalled()
		expect(resumed?.status).toBe(previousStatus)
		expect(resumed?.latestOutcome).toBe(previousOutcome)
		expect(resumed?.completedAt).toBe(previousCompletedAt)
		expect(resumed?.error).toBeUndefined()
	})

	it("preserves worker state when its tier cumulative output budget rejects a resume", async () => {
		const session = { dispose: vi.fn() } as unknown as AgentSession
		mockRunAgent.mockResolvedValueOnce({ responseText: "checkpoint", session, aborted: false, steered: false })
		manager = new AgentManager()
		const record = await manager.spawnAndWait(fakePi(), fakeCtx(), "Explore", "inspect", {
			description: "inspect",
			taskRef: {
				kind: "ferment_step",
				ferment_id: "f1",
				phase_id: "p1",
				step_id: "s1",
				budget_tier: "narrow",
			},
		})
		record.lifetimeUsage.output = 100_000
		const previousOutcome = record.latestOutcome

		const resumed = await manager.resume(record.id, "continue", { maxTurns: 1 })

		expect(mockResumeAgent).not.toHaveBeenCalled()
		expect(resumed?.status).toBe("completed")
		expect(resumed?.latestOutcome).toBe(previousOutcome)
		expect(resumed?.error).toBeUndefined()
	})

	it("enforces the selected worker tier on continuation attempts", async () => {
		const session = { dispose: vi.fn() } as unknown as AgentSession
		mockRunAgent.mockResolvedValueOnce({ responseText: "checkpoint", session, aborted: false, steered: false })
		mockResumeAgent.mockResolvedValueOnce({
			responseText: "continued",
			session,
			aborted: false,
			steered: false,
			maxTurns: 10,
		})
		manager = new AgentManager()
		const record = await manager.spawnAndWait(fakePi(), fakeCtx(), "Explore", "inspect", {
			description: "inspect",
			taskRef: {
				kind: "ferment_step",
				ferment_id: "f1",
				phase_id: "p1",
				step_id: "s1",
				budget_tier: "narrow",
			},
		})

		await manager.resume(record.id, "continue", {
			maxTurns: 999,
			maxDuration: 999,
			tokenBudget: 999_999,
		})

		expect(mockResumeAgent).toHaveBeenCalledWith(
			session,
			expect.any(String),
			expect.objectContaining({ maxTurns: 10, maxDuration: 180, tokenBudget: 50_000 }),
		)
	})

	it("does not resume a Ferment worker when remaining cumulative budget is below the runner floor", async () => {
		const session = { dispose: vi.fn() } as unknown as AgentSession
		mockRunAgent.mockResolvedValueOnce({
			responseText: "checkpoint",
			session,
			aborted: true,
			abortReason: "token_budget",
			steered: false,
		})
		manager = new AgentManager()
		const record = await manager.spawnAndWait(fakePi(), fakeCtx(), "Explore", "inspect", {
			description: "inspect",
			taskRef: {
				kind: "ferment_step",
				ferment_id: "f1",
				phase_id: "p1",
				step_id: "s1",
				budget_tier: "narrow",
			},
		})
		record.lifetimeUsage.output = 99_500

		const resumed = await manager.resume(record.id, "continue", { tokenBudget: 999_999 })

		expect(resumed).toBe(record)
		expect(mockResumeAgent).not.toHaveBeenCalled()
		expect(record.resumeAttempts).toHaveLength(0)
	})

	it("allows finalize_report when remaining budget is below the continuation floor but above the finalize floor", async () => {
		const session = { dispose: vi.fn() } as unknown as AgentSession
		mockRunAgent.mockResolvedValueOnce({ responseText: "checkpoint", session, aborted: false, steered: false })
		mockResumeAgent.mockResolvedValueOnce({ responseText: "reported", session, aborted: false, steered: false })
		manager = new AgentManager()
		const record = await manager.spawnAndWait(fakePi(), fakeCtx(), "Explore", "inspect", {
			description: "inspect",
			taskRef: {
				kind: "ferment_step",
				ferment_id: "f1",
				phase_id: "p1",
				step_id: "s1",
				budget_tier: "narrow",
			},
		})
		// Narrow tier has a 100k cumulative budget. 99_700 used → 300 remaining:
		// below the continuation floor (1024) but above the finalize floor (256).
		record.lifetimeUsage.output = 99_700

		const resumed = await manager.resume(record.id, undefined, { purpose: "finalize_report" })

		expect(resumed).toBe(record)
		expect(mockResumeAgent).toHaveBeenCalledOnce()
		expect(mockResumeAgent.mock.calls[0]?.[2]).toEqual(
			expect.objectContaining({ minTokenBudget: 256, tokenBudget: 300 }),
		)
	})

	it("blocks finalize_report when remaining budget is below the finalize floor", async () => {
		const session = { dispose: vi.fn() } as unknown as AgentSession
		mockRunAgent.mockResolvedValueOnce({ responseText: "checkpoint", session, aborted: false, steered: false })
		manager = new AgentManager()
		const record = await manager.spawnAndWait(fakePi(), fakeCtx(), "Explore", "inspect", {
			description: "inspect",
			taskRef: {
				kind: "ferment_step",
				ferment_id: "f1",
				phase_id: "p1",
				step_id: "s1",
				budget_tier: "narrow",
			},
		})
		// 99_900 used → 100 remaining: below the finalize floor (256).
		record.lifetimeUsage.output = 99_900

		const resumed = await manager.resume(record.id, undefined, { purpose: "finalize_report" })

		expect(resumed).toBe(record)
		expect(mockResumeAgent).not.toHaveBeenCalled()
		expect(record.resumeAttempts).toHaveLength(0)
		expect(manager.getResumeBlockReason(record.id, "finalize_report")).toContain("report-finalization budget")
	})

	it("does not charge report finalization against the continuation resume quota", async () => {
		const session = { dispose: vi.fn() } as unknown as AgentSession
		mockRunAgent.mockResolvedValueOnce({ responseText: "done", session, aborted: false, steered: false })
		mockResumeAgent.mockResolvedValueOnce({ responseText: "reported", session, aborted: false, steered: false })
		manager = new AgentManager()
		const record = await manager.spawnAndWait(fakePi(), fakeCtx(), "Explore", "inspect", {
			description: "inspect",
			taskRef: { kind: "ferment_step", ferment_id: "f1", phase_id: "p1", step_id: "s1" },
		})
		record.resumeAttempts = [
			{ attempt_id: 1, purpose: "continuation", startedAt: 1 },
			{ attempt_id: 2, purpose: "continuation", startedAt: 2 },
		]

		const resumed = await manager.resume(record.id, undefined, { purpose: "finalize_report" })

		expect(mockResumeAgent).toHaveBeenCalledOnce()
		expect(mockResumeAgent).toHaveBeenCalledWith(
			session,
			expect.stringContaining("Do not perform more task work"),
			expect.objectContaining({ maxTurns: 2, maxDuration: 30, tokenBudget: 8192 }),
		)
		expect(resumed?.status).toBe("completed")
		expect(resumed?.resumeAttempts?.at(-1)?.purpose).toBe("finalize_report")
		expect(resumed?.resumeAttempts?.at(-1)).toMatchObject({ maxTurns: 2, tokenBudget: 8192 })
	})

	it("clears stale reports when a new execution attempt starts", async () => {
		const session = { dispose: vi.fn() } as unknown as AgentSession
		mockRunAgent.mockResolvedValueOnce({ responseText: "done", session, aborted: false, steered: false })
		mockResumeAgent.mockResolvedValueOnce({ responseText: "continued", session, aborted: false, steered: false })
		manager = new AgentManager()
		const record = await manager.spawnAndWait(fakePi(), fakeCtx(), "Explore", "inspect", {
			description: "inspect",
			taskRef: { kind: "ferment_step", ferment_id: "f1", phase_id: "p1", step_id: "s1" },
		})
		// NB: status must be "partial" (not "completed") so this report doesn't trigger
		// the "accepted completed report" resume guard added alongside tiered budgets.
		manager.submitReport(record.id, {
			status: "partial",
			summary: "old attempt",
			steps_completed: ["old work"],
			remaining_steps: [],
		})

		const resumed = await manager.resume(record.id, "continue", { maxTurns: 1, maxDuration: 30 })

		expect(resumed?.currentAttemptId).toBe(1)
		expect(resumed?.agentReport).toBeUndefined()
		expect(resumed?.latestOutcome?.report).toBeUndefined()
	})

	it("stops a resumed worker through its fresh attempt controller", async () => {
		const session = { dispose: vi.fn() } as unknown as AgentSession
		mockRunAgent.mockResolvedValueOnce({ responseText: "checkpoint", session, aborted: false, steered: false })
		mockResumeAgent.mockImplementationOnce(async (_session, _prompt, options) => {
			const attemptSignal = options?.signal
			if (!attemptSignal) throw new Error("expected resume abort signal")
			await new Promise<void>((resolve) => attemptSignal.addEventListener("abort", () => resolve(), { once: true }))
			return { responseText: "stopped", session, aborted: false, steered: false }
		})
		manager = new AgentManager()
		const record = await manager.spawnAndWait(fakePi(), fakeCtx(), "Explore", "inspect", { description: "inspect" })

		const resumePromise = manager.resume(record.id, "continue", { maxTurns: 2, maxDuration: 30 })
		await vi.waitFor(() => expect(mockResumeAgent).toHaveBeenCalledOnce())
		expect(manager.abort(record.id)).toBe(true)
		const resumed = await resumePromise

		expect(resumed?.status).toBe("stopped")
	})

	it("keeps a resumed worker stopped when the resume prompt rejects after manual abort", async () => {
		const session = { dispose: vi.fn() } as unknown as AgentSession
		mockRunAgent.mockResolvedValueOnce({ responseText: "checkpoint", session, aborted: false, steered: false })
		mockResumeAgent.mockImplementationOnce(async (_session, _prompt, options) => {
			const attemptSignal = options?.signal
			if (!attemptSignal) throw new Error("expected resume abort signal")
			await new Promise<void>((resolve) => attemptSignal.addEventListener("abort", () => resolve(), { once: true }))
			throw new Error("prompt aborted")
		})
		manager = new AgentManager()
		const record = await manager.spawnAndWait(fakePi(), fakeCtx(), "Explore", "inspect", { description: "inspect" })

		const resumePromise = manager.resume(record.id, "continue", { maxTurns: 2, maxDuration: 30 })
		await vi.waitFor(() => expect(mockResumeAgent).toHaveBeenCalledOnce())
		expect(manager.abort(record.id)).toBe(true)
		const resumed = await resumePromise

		expect(resumed?.status).toBe("stopped")
		expect(resumed?.error).toBeUndefined()
	})

	describe("submitReport", () => {
		it("returns undefined for unknown agent ID", async () => {
			manager = new AgentManager()

			const result = manager.submitReport("nonexistent-id", {
				status: "completed",
				summary: "done",
				steps_completed: ["step1"],
				remaining_steps: [],
			})

			expect(result).toBeUndefined()
		})

		it("returns undefined for system-visibility agents", async () => {
			mockRunAgent.mockResolvedValueOnce({
				responseText: "done",
				session: { dispose: vi.fn() } as unknown as AgentSession,
				aborted: false,
				steered: false,
			})
			manager = new AgentManager()
			const record = await manager.spawnAndWait(fakePi(), fakeCtx(), "Explore", "inspect", {
				description: "system agent",
				visibility: "system",
			})

			const result = manager.submitReport(record.id, {
				status: "completed",
				summary: "done",
				steps_completed: ["step1"],
				remaining_steps: [],
			})

			expect(result).toBeUndefined()
			expect(record.agentReport).toBeUndefined()
		})

		it("stores report on record and returns the record", async () => {
			mockRunAgent.mockResolvedValueOnce({
				responseText: "done",
				session: { dispose: vi.fn() } as unknown as AgentSession,
				aborted: false,
				steered: false,
			})
			manager = new AgentManager()
			const taskRef = { kind: "ferment_step" as const, ferment_id: "f1", phase_id: "p1", step_id: "s1" }
			const record = await manager.spawnAndWait(fakePi(), fakeCtx(), "Explore", "inspect", {
				description: "inspect",
				taskRef,
			})

			const report = {
				status: "completed" as const,
				summary: "implemented feature",
				steps_completed: ["wrote code", "ran tests"],
				remaining_steps: [],
			}
			const result = manager.submitReport(record.id, report)

			expect(result).toBe(record)
			expect(record.agentReport).toMatchObject({ ...report, attempt_id: 0 })
			expect(record.latestOutcome?.report).toMatchObject({ ...report, attempt_id: 0 })
			expect(record.latestOutcome?.summary).toBeUndefined()
		})

		it("second submission overwrites the first report", async () => {
			mockRunAgent.mockResolvedValueOnce({
				responseText: "done",
				session: { dispose: vi.fn() } as unknown as AgentSession,
				aborted: false,
				steered: false,
			})
			manager = new AgentManager()
			const taskRef = { kind: "ferment_step" as const, ferment_id: "f1", phase_id: "p1", step_id: "s1" }
			const record = await manager.spawnAndWait(fakePi(), fakeCtx(), "Explore", "inspect", {
				description: "inspect",
				taskRef,
			})

			const firstReport = {
				status: "partial" as const,
				summary: "halfway there",
				steps_completed: ["step1"],
				remaining_steps: ["step2"],
			}
			const secondReport = {
				status: "completed" as const,
				summary: "all done",
				steps_completed: ["step1", "step2"],
				remaining_steps: [],
			}

			manager.submitReport(record.id, firstReport)
			const result = manager.submitReport(record.id, secondReport)

			expect(result).toBe(record)
			expect(record.agentReport).toMatchObject({ ...secondReport, attempt_id: 0 })
			expect(record.latestOutcome?.report).toMatchObject({ ...secondReport, attempt_id: 0 })
			expect(record.agentReport?.status).toBe("completed")
			expect(record.agentReport?.summary).toBe("all done")
		})
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
			currentAttemptId: 0,
		})

		expect(outcome.outcome).toBe("failed")
		expect(outcome.reason).toBe("max_duration")
		expect(outcome.recovery_guidance).toContain("stalled operation")
		expect(outcome.recovery_guidance).toContain("narrower linked replacement")
	})

	it("waits for aborted subagent promises to settle so runner cleanup can run", async () => {
		const releaseRun = deferred<void>()
		const runnerCleanup = vi.fn()
		mockRunAgent.mockImplementationOnce((_ctx, _type, _prompt, options) => {
			const result = deferred<Awaited<ReturnType<typeof runAgent>>>()
			options.signal?.addEventListener(
				"abort",
				() => {
					// In the real runner, aborting the session does not clear timers by itself.
					// The inactivity interval is cleared only when runAgent reaches its finally block.
					void releaseRun.promise.then(() => {
						runnerCleanup()
						result.resolve({
							responseText: "partial",
							session: { dispose: vi.fn() } as unknown as AgentSession,
							aborted: true,
							abortReason: "token_budget",
							steered: false,
						})
					})
				},
				{ once: true },
			)
			return result.promise
		})
		manager = new AgentManager()
		manager.spawn(fakePi(), fakeCtx(), "Explore", "inspect", {
			description: "inspect",
			isBackground: true,
		})

		manager.abortAll()
		const wait = manager.waitForAll()

		try {
			// waitForAll must keep waiting for the aborted runAgent promise, because
			// that promise settling is what lets the runner's timer cleanup execute.
			await expectStillPending(wait)

			releaseRun.resolve()
			await wait

			expect(runnerCleanup).toHaveBeenCalledTimes(1)
		} finally {
			releaseRun.resolve()
			await wait.catch(() => {})
		}
	})

	it("waits for active resume promises to settle so resume runner cleanup can run", async () => {
		const session = { dispose: vi.fn() } as unknown as AgentSession
		mockRunAgent.mockResolvedValueOnce({
			responseText: "checkpoint",
			session,
			aborted: true,
			abortReason: "token_budget",
			steered: false,
		})
		const releaseResume = deferred<void>()
		const runnerCleanup = vi.fn()
		mockResumeAgent.mockImplementationOnce((_session, _prompt, options) => {
			const result = deferred<Awaited<ReturnType<typeof resumeAgent>>>()
			options?.signal?.addEventListener(
				"abort",
				() => {
					void releaseResume.promise.then(() => {
						runnerCleanup()
						result.resolve({
							responseText: "resumed partial",
							session,
							aborted: true,
							abortReason: "token_budget",
							steered: false,
						})
					})
				},
				{ once: true },
			)
			return result.promise
		})
		manager = new AgentManager()
		const record = await manager.spawnAndWait(fakePi(), fakeCtx(), "Explore", "inspect", {
			description: "inspect",
		})

		const resume = manager.resume(record.id, "continue", { tokenBudget: 2048 })
		await vi.waitFor(() => expect(mockResumeAgent).toHaveBeenCalledTimes(1))
		manager.abortAll()
		const wait = manager.waitForAll()

		try {
			await expectStillPending(wait)

			releaseResume.resolve()
			await wait
			await resume

			expect(runnerCleanup).toHaveBeenCalledTimes(1)
		} finally {
			releaseResume.resolve()
			await wait.catch(() => {})
			await resume.catch(() => {})
		}
	})

	it("clears registered runner inactivity cleanup during dispose as a hard fallback", () => {
		const runnerCleanup = vi.fn()
		mockRunAgent.mockImplementationOnce((_ctx, _type, _prompt, options) => {
			options.onRuntimeCleanupRegistered?.(runnerCleanup)
			return new Promise<never>(() => {})
		})
		manager = new AgentManager()
		manager.spawn(fakePi(), fakeCtx(), "Explore", "inspect", {
			description: "inspect",
			isBackground: true,
		})

		manager.dispose()

		expect(runnerCleanup).toHaveBeenCalledTimes(1)
		manager = undefined
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

describe("AgentManager communication broker", () => {
	it("creates host-issued scopes, keeps task_ref separate, and disables system communication", () => {
		const manager = new AgentManager(undefined, 0)
		try {
			const id = manager.spawn(fakePi(), fakeCtx(), "Explore", "inspect", {
				description: "inspect",
				isBackground: true,
				communication: "group",
				rootSessionId: "root-1",
				taskRef: { kind: "ferment_step", ferment_id: "f-1", phase_id: "p-1", step_id: "s-1" },
			})
			const systemId = manager.spawn(fakePi(), fakeCtx(), "Explore", "grade", {
				description: "grade",
				isBackground: true,
				visibility: "system",
				communication: "group",
				rootSessionId: "root-1",
			})

			expect(manager.getRecord(id)?.communicationScope).toEqual({
				rootSessionId: "root-1",
				sourceAgentId: id,
				taskId: `agent-task:${id}`,
			})
			expect(manager.getRecord(id)?.taskRef).toMatchObject({ ferment_id: "f-1" })
			expect(manager.getRecord(systemId)?.communication).toBeUndefined()
			expect(manager.getRecord(systemId)?.communicationScope).toBeUndefined()
			expect(() =>
				manager.spawn(fakePi(), fakeCtx(), "Explore", "isolated", {
					description: "isolated",
					communication: "parent",
					rootSessionId: "root-1",
					isolated: true,
				}),
			).toThrow("Communication requires extension tools")
		} finally {
			manager.dispose()
		}
	})

	it("derives group peers from live root and batch membership", () => {
		const manager = new AgentManager(undefined, 0)
		try {
			const source = manager.spawn(fakePi(), fakeCtx(), "Explore", "source", {
				description: "source",
				isBackground: true,
				communication: "group",
				rootSessionId: "root-1",
			})
			const peer = manager.spawn(fakePi(), fakeCtx(), "Explore", "peer", {
				description: "peer",
				isBackground: true,
				communication: "group",
				rootSessionId: "root-1",
			})
			const otherRoot = manager.spawn(fakePi(), fakeCtx(), "Explore", "other", {
				description: "other",
				isBackground: true,
				communication: "group",
				rootSessionId: "root-2",
			})
			const sourceRecord = manager.getRecord(source)
			const peerRecord = manager.getRecord(peer)
			const otherRootRecord = manager.getRecord(otherRoot)
			if (!sourceRecord || !peerRecord || !otherRootRecord) throw new Error("expected queued agent records")
			sourceRecord.groupId = "batch-1"
			peerRecord.groupId = "batch-1"
			otherRootRecord.groupId = "batch-1"

			expect(manager.listCommunicationPeers(source).map((record) => record.id)).toEqual([peer])
			expect(manager.isAuthorizedCommunicationPeer(source, peer)).toBe(true)
			expect(manager.isAuthorizedCommunicationPeer(source, otherRoot)).toBe(false)
		} finally {
			manager.dispose()
		}
	})

	it("delays live peer contacts and delivery until the host finalizes a same-root group", async () => {
		const manager = new AgentManager(undefined, 4)
		try {
			manager.bindCommunicationRoot("root-1")
			const sourceRun = deferred<Awaited<ReturnType<typeof runAgent>>>()
			const targetRun = deferred<Awaited<ReturnType<typeof runAgent>>>()
			const otherRootRun = deferred<Awaited<ReturnType<typeof runAgent>>>()
			let sourceCapability: NonNullable<Parameters<typeof runAgent>[3]>["agentMessage"]
			mockRunAgent.mockImplementationOnce((_ctx, _type, _prompt, options) => {
				sourceCapability = options.agentMessage
				return sourceRun.promise
			})
			mockRunAgent.mockImplementationOnce(() => targetRun.promise)
			mockRunAgent.mockImplementationOnce(() => otherRootRun.promise)
			const source = manager.spawn(fakePi(), fakeCtx(), "Explore", "source", {
				description: "source",
				communication: "group",
				rootSessionId: "root-1",
			})
			const target = manager.spawn(fakePi(), fakeCtx(), "Explore", "target", {
				description: "target",
				communication: "group",
				rootSessionId: "root-1",
			})
			const otherRoot = manager.spawn(fakePi(), fakeCtx(), "Explore", "other root", {
				description: "other root",
				communication: "group",
				rootSessionId: "root-2",
			})
			const sourceRecord = manager.getRecord(source)
			const targetRecord = manager.getRecord(target)
			const otherRootRecord = manager.getRecord(otherRoot)
			if (!sourceCapability || !sourceRecord || !targetRecord || !otherRootRecord) {
				throw new Error("expected live child capability and peer records")
			}

			expect(sourceCapability.listContacts().peers).toEqual([])
			await expect(
				sourceCapability.sendMessage("before-group-finalization", {
					recipient: { type: "agent", agentId: target },
					payload: { kind: "status", summary: "not yet grouped" },
				}),
			).resolves.toMatchObject({ status: "unavailable" })

			sourceRecord.groupId = "batch-1"
			targetRecord.groupId = "batch-1"
			otherRootRecord.groupId = "batch-1"
			expect(sourceCapability.listContacts().peers.map((peer) => peer.agent_id)).toEqual([target])
			await expect(
				sourceCapability.sendMessage("after-group-finalization", {
					recipient: { type: "agent", agentId: target },
					payload: { kind: "status", summary: "now grouped" },
				}),
			).resolves.toMatchObject({ status: "queued_before_session" })
		} finally {
			manager.dispose()
		}
	})

	it("atomically caches a tool call, partitions it by live attempt, and cleans broker state", async () => {
		const manager = new AgentManager(undefined, 0)
		try {
			const id = manager.spawn(fakePi(), fakeCtx(), "Explore", "inspect", {
				description: "inspect",
				isBackground: true,
				communication: "parent",
				rootSessionId: "root-1",
			})
			const pending = deferred<{ status: "queued_for_parent" }>()
			const operation = vi.fn(() => pending.promise)
			const first = manager.reserveChildMessage(id, "call-1", 1, operation)
			const duplicate = manager.reserveChildMessage(id, "call-1", 1, operation)

			expect(duplicate).toBe(first)
			expect(operation).toHaveBeenCalledTimes(1)
			pending.resolve({ status: "queued_for_parent" })
			await expect(first).resolves.toEqual({ status: "queued_for_parent" })
			expect(
				manager.registerMessageThread(
					createInitialMessage(manager, id, "cleanup-question", { type: "parent" }, "question"),
				),
			).toEqual({ accepted: true })

			const record = manager.getRecord(id)
			if (!record) throw new Error("expected queued agent record")
			record.currentAttemptId++
			await expect(
				manager.reserveChildMessage(id, "call-1", 1, () => ({ status: "queued_for_parent" })),
			).resolves.toEqual({
				status: "queued_for_parent",
			})
			expect(manager.getMessageBrokerStats().receipts).toBe(2)

			record.status = "completed"
			manager.clearCompleted()
			expect(manager.getMessageBrokerStats()).toEqual({
				receipts: 0,
				threads: 0,
				pendingMessages: 0,
				pendingPayloadBytes: 0,
			})
		} finally {
			manager.dispose()
		}
	})

	it("enforces attempt, pending, and atomic question-thread limits", async () => {
		const manager = new AgentManager(undefined, 0)
		try {
			const id = manager.spawn(fakePi(), fakeCtx(), "Explore", "inspect", {
				description: "inspect",
				isBackground: true,
				communication: "parent",
				rootSessionId: "root-1",
			})
			for (let index = 0; index < AGENT_MESSAGE_LIMITS.maxMessagesPerAttempt; index++) {
				await manager.reserveChildMessage(id, `call-${index}`, 1, () => ({ status: "queued_for_parent" }))
			}
			await expect(
				manager.reserveChildMessage(id, "overflow", 1, () => ({ status: "queued_for_parent" })),
			).resolves.toMatchObject({
				status: "saturated",
			})
			for (let index = 0; index < AGENT_MESSAGE_LIMITS.maxPendingMessagesPerTarget; index++) {
				expect(manager.tryReservePendingMessage(id, 1)).toBe(true)
			}
			expect(manager.tryReservePendingMessage(id, 1)).toBe(false)

			const message = createInitialMessage(manager, id, "question-1", { type: "parent" }, "question")
			expect(manager.registerMessageThread(message)).toEqual({ accepted: true })
			expect(manager.closeMessageThreadForTerminalState("question-1", "target_terminal")).toMatchObject({
				closed: true,
			})
			expect(manager.closeMessageThreadForTerminalState("question-1", "duplicate")).toEqual({
				closed: false,
				reason: "thread_closed",
			})
		} finally {
			manager.dispose()
		}
	})

	it("authorizes and atomically closes a parent or user question before the reply operation awaits", async () => {
		const manager = new AgentManager(undefined, 0)
		try {
			const source = spawnCommunicatingAgent(manager, "parent")
			const question = createInitialMessage(manager, source, "parent-question", { type: "user" }, "question")
			expect(manager.registerMessageThread(question)).toEqual({ accepted: true })

			const pending = deferred<{ status: "queued_for_running_session" }>()
			const operation = vi.fn(() => pending.promise)
			const first = manager.reserveParentReply("parent-question", "reply-1", "parent_answer", operation)
			const replay = manager.reserveParentReply("parent-question", "reply-1", "parent_answer", operation)
			const late = await manager.reserveParentReply("parent-question", "reply-2", "parent_answer", operation)

			expect(replay).toBe(first)
			expect(operation).toHaveBeenCalledOnce()
			expect(manager.getMessageThread("parent-question")).toMatchObject({ state: "closed", messageCount: 2 })
			expect(late).toEqual({ status: "rejected", reason: "thread_closed" })
			pending.resolve({ status: "queued_for_running_session" })
			await expect(first).resolves.toEqual({ status: "queued_for_running_session" })
		} finally {
			manager.dispose()
		}
	})

	it("permits a peer answer only from the addressed peer back to the source", async () => {
		const manager = new AgentManager(undefined, 0)
		try {
			manager.bindCommunicationRoot("root-1")
			const source = spawnCommunicatingAgent(manager, "group")
			const peer = spawnCommunicatingAgent(manager, "group")
			const otherPeer = spawnCommunicatingAgent(manager, "group")
			for (const id of [source, peer, otherPeer]) {
				const record = manager.getRecord(id)
				if (!record) throw new Error("expected queued agent record")
				record.groupId = "batch-1"
			}
			const question = createInitialMessage(
				manager,
				source,
				"peer-question",
				{ type: "agent", agentId: peer },
				"question",
			)
			expect(manager.registerMessageThread(question)).toEqual({ accepted: true })

			await expect(
				manager.reservePeerReply(otherPeer, "peer-question", source, "peer-reply-1", 1, "answer", () => ({
					status: "queued_for_running_session",
				})),
			).resolves.toEqual({ status: "rejected", reason: "Peer reply is not authorized." })
			await expect(
				manager.reservePeerReply(peer, "peer-question", "wrong-source", "peer-reply-2", 1, "answer", () => ({
					status: "queued_for_running_session",
				})),
			).resolves.toEqual({ status: "rejected", reason: "Peer reply is not authorized." })
			await expect(
				manager.reservePeerReply(otherPeer, "unknown-question", source, "peer-reply-unknown", 1, "answer", () => ({
					status: "queued_for_running_session",
				})),
			).resolves.toEqual({ status: "rejected", reason: "Peer reply is not authorized." })
			await expect(
				manager.reservePeerReply(peer, "peer-question", source, "peer-reply-3", 1, "answer", () => ({
					status: "queued_for_running_session",
				})),
			).resolves.toEqual({ status: "queued_for_running_session" })
			expect(manager.getMessageThread("peer-question")).toMatchObject({ state: "closed", messageCount: 2 })
			await expect(
				manager.reservePeerReply(peer, "peer-question", source, "peer-reply-late", 1, "answer", () => ({
					status: "queued_for_running_session",
				})),
			).resolves.toEqual({ status: "rejected", reason: "thread_closed" })
		} finally {
			manager.dispose()
		}
	})

	it("enforces open-question, per-thread, receipt, retention, and global metadata limits", async () => {
		const manager = new AgentManager(undefined, 0)
		try {
			const source = spawnCommunicatingAgent(manager, "parent")
			for (let index = 0; index < AGENT_MESSAGE_LIMITS.maxOpenQuestionsPerAgent; index++) {
				expect(
					manager.registerMessageThread(
						createInitialMessage(manager, source, `open-${index}`, { type: "parent" }, "question"),
					),
				).toEqual({ accepted: true })
			}
			expect(
				manager.registerMessageThread(
					createInitialMessage(manager, source, "open-overflow", { type: "parent" }, "question"),
				),
			).toEqual({ accepted: false, reason: "Agent has too many open message questions." })

			const threadId = "open-0"
			for (let index = 1; index < AGENT_MESSAGE_LIMITS.maxMessagesPerThread; index++) {
				expect(manager.tryReserveThreadMessage(threadId)).toBe(true)
			}
			expect(manager.tryReserveThreadMessage(threadId)).toBe(false)

			const receiptSource = spawnCommunicatingAgent(manager, "parent")
			for (let attempt = 0; attempt < 2; attempt++) {
				for (let index = 0; index < AGENT_MESSAGE_LIMITS.maxMessagesPerAttempt; index++) {
					await manager.reserveChildMessage(receiptSource, `receipt-${attempt}-${index}`, 1, () => ({
						status: "queued_for_parent",
					}))
				}
				const record = manager.getRecord(receiptSource)
				if (!record) throw new Error("expected queued agent record")
				record.currentAttemptId++
			}
			await expect(
				manager.reserveChildMessage(receiptSource, "receipt-overflow", 1, () => ({ status: "queued_for_parent" })),
			).resolves.toMatchObject({ status: "saturated" })
		} finally {
			manager.dispose()
		}

		const retentionManager = new AgentManager(undefined, 0)
		try {
			const source = spawnCommunicatingAgent(retentionManager, "parent")
			for (let index = 0; index < AGENT_MESSAGE_LIMITS.maxThreadsPerAgent; index++) {
				expect(
					retentionManager.registerMessageThread(
						createInitialMessage(retentionManager, source, `closed-${index}`, { type: "parent" }, "status", index),
					),
				).toEqual({ accepted: true })
			}
			expect(
				retentionManager.registerMessageThread(
					createInitialMessage(retentionManager, source, "closed-new", { type: "parent" }, "status", 99),
				),
			).toEqual({ accepted: true })
			expect(retentionManager.getMessageThread("closed-0")).toBeUndefined()
			expect(retentionManager.getMessageThread("closed-new")).toBeDefined()
			expect(retentionManager.getMessageBrokerStats().threads).toBe(AGENT_MESSAGE_LIMITS.maxThreadsPerAgent)
		} finally {
			retentionManager.dispose()
		}

		const metadataManager = new AgentManager(undefined, 0)
		try {
			for (
				let agentIndex = 0;
				agentIndex < AGENT_MESSAGE_LIMITS.maxMetadataRecords / AGENT_MESSAGE_LIMITS.maxMessagesPerAttempt;
				agentIndex++
			) {
				const agentId = spawnCommunicatingAgent(metadataManager, "parent")
				for (let messageIndex = 0; messageIndex < AGENT_MESSAGE_LIMITS.maxMessagesPerAttempt; messageIndex++) {
					await metadataManager.reserveChildMessage(agentId, `metadata-${agentIndex}-${messageIndex}`, 1, () => ({
						status: "queued_for_parent",
					}))
				}
			}
			const overflowAgent = spawnCommunicatingAgent(metadataManager, "parent")
			await expect(
				metadataManager.reserveChildMessage(overflowAgent, "metadata-overflow", 1, () => ({
					status: "queued_for_parent",
				})),
			).resolves.toMatchObject({ status: "saturated" })
			expect(metadataManager.getMessageBrokerStats().receipts).toBe(AGENT_MESSAGE_LIMITS.maxMetadataRecords)
		} finally {
			metadataManager.dispose()
		}
	})

	it("enforces global pending bytes and clears all broker state on dispose", () => {
		const manager = new AgentManager(undefined, 0)
		const source = spawnCommunicatingAgent(manager, "parent")
		void manager.reserveChildMessage(source, "dispose-receipt", 1, () => ({ status: "queued_for_parent" }))
		expect(
			manager.registerMessageThread(
				createInitialMessage(manager, source, "dispose-question", { type: "parent" }, "question"),
			),
		).toEqual({ accepted: true })
		for (let target = 0; target < 4; target++) {
			for (let message = 0; message < AGENT_MESSAGE_LIMITS.maxPendingMessagesPerTarget; message++) {
				expect(manager.tryReservePendingMessage(`target-${target}`, AGENT_MESSAGE_LIMITS.maxPayloadBytes)).toBe(true)
			}
		}
		expect(manager.tryReservePendingMessage("overflow", 1)).toBe(false)
		expect(manager.getMessageBrokerStats().pendingPayloadBytes).toBe(AGENT_MESSAGE_LIMITS.maxPendingPayloadBytes)
		manager.dispose()
		expect(manager.getMessageBrokerStats()).toEqual({
			receipts: 0,
			threads: 0,
			pendingMessages: 0,
			pendingPayloadBytes: 0,
		})
	})

	it("caps mixed receipts, threads, and pending-delivery failure keys in one metadata pool", async () => {
		const manager = new AgentManager(undefined, 0)
		try {
			const source = spawnCommunicatingAgent(manager, "parent")
			const target = spawnCommunicatingAgent(manager, "parent")
			const broker = manager as unknown as {
				deliveryFailureKeys: Map<string, string>
				failPendingMessage: (
					message: {
						messageId: string
						threadId: string
						sourceAgentId: string
						sourceTaskId: string
						targetAgentId: string
						rootSessionId: string
						kind: "status"
						prompt: string
						bytes: number
					},
					reason: string,
					notifyParent: boolean,
					releasePending: boolean,
				) => void
			}
			const retainedMetadataRecords = () => {
				const stats = manager.getMessageBrokerStats()
				return stats.receipts + stats.threads + stats.pendingMessages + broker.deliveryFailureKeys.size
			}

			for (let index = 0; index < 8; index++) {
				expect(manager.tryReservePendingMessage(target, 1)).toBe(true)
				broker.failPendingMessage(
					{
						messageId: `failure-${index}`,
						threadId: `failure-${index}`,
						sourceAgentId: source,
						sourceTaskId: `agent-task:${source}`,
						targetAgentId: target,
						rootSessionId: "root-1",
						kind: "status",
						prompt: "",
						bytes: 1,
					},
					"steer_failed",
					false,
					true,
				)
			}
			expect(broker.deliveryFailureKeys.size).toBe(8)

			for (let index = 0; index < 8; index++) {
				expect(
					manager.registerMessageThread(
						createInitialMessage(manager, source, `mixed-thread-${index}`, { type: "parent" }, "question"),
					),
				).toEqual({ accepted: true })
			}
			const inFlightReceipt = deferred<{ status: "queued_for_parent" }>()
			const inFlightOperation = vi.fn(() => inFlightReceipt.promise)
			const firstInFlightCall = manager.reserveChildMessage(source, "mixed-in-flight", 1, inFlightOperation)
			expect(inFlightOperation).toHaveBeenCalledOnce()

			while (retainedMetadataRecords() < AGENT_MESSAGE_LIMITS.maxMetadataRecords) {
				const receiptSource = spawnCommunicatingAgent(manager, "parent")
				const receiptCount = Math.min(
					AGENT_MESSAGE_LIMITS.maxMessagesPerAttempt,
					AGENT_MESSAGE_LIMITS.maxMetadataRecords - retainedMetadataRecords(),
				)
				for (let index = 0; index < receiptCount; index++) {
					await manager.reserveChildMessage(receiptSource, `mixed-receipt-${receiptSource}-${index}`, 1, () => ({
						status: "queued_for_parent",
					}))
				}
			}

			expect(retainedMetadataRecords()).toBe(AGENT_MESSAGE_LIMITS.maxMetadataRecords)
			broker.failPendingMessage(
				{
					messageId: "mixed-failure-overflow",
					threadId: "mixed-failure-overflow",
					sourceAgentId: source,
					sourceTaskId: `agent-task:${source}`,
					targetAgentId: target,
					rootSessionId: "root-1",
					kind: "status",
					prompt: "",
					bytes: 1,
				},
				"steer_failed",
				false,
				false,
			)
			expect(broker.deliveryFailureKeys.size).toBe(8)
			expect(retainedMetadataRecords()).toBe(AGENT_MESSAGE_LIMITS.maxMetadataRecords)
			const replay = manager.reserveChildMessage(source, "mixed-in-flight", 1, inFlightOperation)
			expect(replay).toBe(firstInFlightCall)
			expect(inFlightOperation).toHaveBeenCalledOnce()
			inFlightReceipt.resolve({ status: "queued_for_parent" })
			await expect(firstInFlightCall).resolves.toEqual({ status: "queued_for_parent" })
			const overflowSource = spawnCommunicatingAgent(manager, "parent")
			await expect(
				manager.reserveChildMessage(overflowSource, "mixed-metadata-overflow", 1, () => ({
					status: "queued_for_parent",
				})),
			).resolves.toMatchObject({ status: "saturated" })
			expect(retainedMetadataRecords()).toBeLessThanOrEqual(AGENT_MESSAGE_LIMITS.maxMetadataRecords)
		} finally {
			manager.dispose()
		}
	})

	it("keeps contacts live and routes accepted parent messages through one replaceable bridge", async () => {
		const manager = new AgentManager(undefined, 0)
		const firstBridge = vi.fn<AgentParentBridge>(() => true)
		const activeBridge = vi.fn<AgentParentBridge>(() => true)
		const events =
			vi.fn<
				(event: {
					sourceAgentId?: string
					sourceTaskId?: string
					state?: string
					payload?: unknown
					body?: unknown
				}) => void
			>()
		try {
			const source = manager.spawn(fakePi(), fakeCtx(), "Explore", "source", {
				description: "source",
				communication: "group",
				rootSessionId: "root-1",
				isBackground: true,
			})
			const peer = manager.spawn(fakePi(), fakeCtx(), "Explore", "peer", {
				description: "peer",
				communication: "group",
				rootSessionId: "root-1",
				isBackground: true,
			})
			const sourceRecord = manager.getRecord(source)
			const peerRecord = manager.getRecord(peer)
			if (!sourceRecord || !peerRecord) throw new Error("expected communication records")
			sourceRecord.groupId = "batch-1"
			peerRecord.groupId = "batch-1"

			manager.bindCommunicationRoot("root-1")
			manager.registerParentBridge("root-1", firstBridge)
			manager.registerParentBridge("root-1", activeBridge)
			manager.setUserContactResolver("root-1", () => ({ reachable: true, route: "ferment_judge", ferment_id: "f-1" }))
			manager.setMessageEventHandler(events)
			expect(manager.getCommunicationContacts(source)).toMatchObject({
				parent: { reachable: true, route: "parent" },
				user_via_parent: { reachable: true, route: "ferment_judge", ferment_id: "f-1" },
				peers: [{ agent_id: peer, status: "initializing" }],
			})

			let capability: NonNullable<Parameters<typeof runAgent>[3]>["agentMessage"]
			mockRunAgent.mockImplementationOnce(async (_ctx, _type, _prompt, options) => {
				capability = options.agentMessage
				if (!capability) throw new Error("expected child communication capability")
				const input = {
					recipient: { type: "parent" } as const,
					payload: { kind: "status" as const, summary: "progress" },
				}
				const first = capability.sendMessage("call-1", input)
				const duplicate = capability.sendMessage("call-1", input)
				expect(duplicate).toBe(first)
				expect(await first).toMatchObject({ status: "queued_for_parent" })
				return {
					responseText: "done",
					session: { dispose: vi.fn() } as unknown as AgentSession,
					aborted: false,
					steered: false,
				}
			})
			await manager.spawnAndWait(fakePi(), fakeCtx(), "Explore", "source", {
				description: "source",
				communication: "group",
				rootSessionId: "root-1",
			})

			expect(firstBridge).not.toHaveBeenCalled()
			expect(activeBridge).toHaveBeenCalledOnce()
			const receipt = await capability?.sendMessage("call-1", {
				recipient: { type: "parent" },
				payload: { kind: "status", summary: "progress after bridge swap" },
			})
			expect(receipt).toMatchObject({ status: "queued_for_parent" })
			const sent = activeBridge.mock.calls[0]?.[0]
			if (sent?.kind !== "message") throw new Error("expected parent message notification")
			expect(sent.message.payload).toEqual({ kind: "status", summary: "progress" })
			const event = events.mock.calls[0]?.[0]
			const actualSource = event?.sourceAgentId
			if (!actualSource) throw new Error("expected accepted message source")
			expect(event).toMatchObject({
				state: "queued_for_parent",
				sourceAgentId: actualSource,
				sourceTaskId: `agent-task:${actualSource}`,
			})
			expect(event).not.toHaveProperty("payload")
			expect(event).not.toHaveProperty("body")
			expect(manager.getMessageThread(receipt?.messageId ?? "")).toBeDefined()

			const record = manager.getRecord(actualSource)
			if (!record?.communicationScope || !capability) throw new Error("expected source capability")
			record.communicationScope.rootSessionId = "root-2"
			await expect(
				capability.sendMessage("wrong-root", {
					recipient: { type: "parent" },
					payload: { kind: "status", summary: "wrong root" },
				}),
			).resolves.toMatchObject({ status: "unavailable" })
			record.communicationScope.rootSessionId = "root-1"
			await expect(
				capability.sendMessage("unauthorized-user", {
					recipient: { type: "user" },
					payload: { kind: "status", summary: "not a question" } as never,
				}),
			).resolves.toMatchObject({ status: "rejected" })
			await expect(
				capability.sendMessage("unauthorized-peer", {
					recipient: { type: "agent", agentId: "absent" },
					payload: { kind: "status", summary: "not authorized" },
				}),
			).resolves.toMatchObject({ status: "unavailable" })
			expect(activeBridge).toHaveBeenCalledOnce()

			manager.disableCommunication("root-1")
			await expect(
				capability.sendMessage("post-shutdown", {
					recipient: { type: "parent" },
					payload: { kind: "status", summary: "late" },
				}),
			).resolves.toMatchObject({ status: "unavailable" })
			expect(activeBridge).toHaveBeenCalledOnce()
		} finally {
			manager.dispose()
		}
	})

	it("does not retain thread or event metadata when the synchronous bridge rejects", async () => {
		const manager = new AgentManager(undefined, 0)
		const bridge = vi.fn(() => false)
		const events = vi.fn()
		try {
			manager.bindCommunicationRoot("root-1")
			manager.registerParentBridge("root-1", bridge)
			manager.setMessageEventHandler(events)
			const source = spawnCommunicatingAgent(manager, "parent")
			let capability: NonNullable<Parameters<typeof runAgent>[3]>["agentMessage"]
			mockRunAgent.mockImplementationOnce(async (_ctx, _type, _prompt, options) => {
				capability = options.agentMessage
				return {
					responseText: "done",
					session: { dispose: vi.fn() } as unknown as AgentSession,
					aborted: false,
					steered: false,
				}
			})
			await manager.spawnAndWait(fakePi(), fakeCtx(), "Explore", "source", {
				description: "source",
				communication: "parent",
				rootSessionId: "root-1",
			})
			const receipt = await capability?.sendMessage("rejected", {
				recipient: { type: "parent" },
				payload: { kind: "question", question: "Proceed?", impact: "Blocks", canContinue: false },
			})
			expect(receipt).toMatchObject({ status: "unavailable" })
			expect(bridge).toHaveBeenCalledOnce()
			expect(events).not.toHaveBeenCalled()
			expect(manager.getMessageBrokerStats().threads).toBe(0)
			expect(manager.getRecord(source)).toBeDefined()
		} finally {
			manager.dispose()
		}
	})

	it("does not notify the parent when an open-question limit cannot store a child question", async () => {
		const manager = new AgentManager(undefined, 4)
		try {
			manager.bindCommunicationRoot("root-1")
			const bridge = vi.fn<AgentParentBridge>(() => true)
			const events = vi.fn()
			manager.registerParentBridge("root-1", bridge)
			manager.setMessageEventHandler(events)
			const run = deferred<Awaited<ReturnType<typeof runAgent>>>()
			let capability: NonNullable<Parameters<typeof runAgent>[3]>["agentMessage"]
			mockRunAgent.mockImplementationOnce((_ctx, _type, _prompt, options) => {
				capability = options.agentMessage
				return run.promise
			})
			const source = manager.spawn(fakePi(), fakeCtx(), "Explore", "source", {
				description: "source",
				communication: "parent",
				rootSessionId: "root-1",
			})
			if (!capability) throw new Error("expected child communication capability")
			for (let index = 0; index < AGENT_MESSAGE_LIMITS.maxOpenQuestionsPerAgent; index++) {
				expect(
					manager.registerMessageThread(
						createInitialMessage(manager, source, `open-question-${index}`, { type: "parent" }, "question"),
					),
				).toEqual({ accepted: true })
			}

			await expect(
				capability.sendMessage("open-question-overflow", {
					recipient: { type: "parent" },
					payload: { kind: "question", question: "Proceed?", impact: "Blocks", canContinue: false },
				}),
			).resolves.toMatchObject({ status: "unavailable" })
			expect(bridge).not.toHaveBeenCalled()
			expect(events).not.toHaveBeenCalled()
		} finally {
			manager.dispose()
		}
	})

	it("drops duplicate identical payloads inside the loop-guard window", async () => {
		vi.useFakeTimers()
		const manager = new AgentManager(undefined, 4)
		try {
			manager.bindCommunicationRoot("root-1")
			manager.registerParentBridge("root-1", () => true)
			let capability: NonNullable<Parameters<typeof runAgent>[3]>["agentMessage"]
			mockRunAgent.mockImplementationOnce((_ctx, _type, _prompt, options) => {
				capability = options.agentMessage
				return new Promise(() => {})
			})
			manager.spawn(fakePi(), fakeCtx(), "Explore", "source", {
				description: "source",
				communication: "group",
				rootSessionId: "root-1",
			})
			if (!capability) throw new Error("expected communication capability")
			const cap = capability
			let call = 0
			const sendQuestion = () =>
				cap.sendMessage(`call-${call++}`, {
					recipient: { type: "parent" },
					payload: { kind: "question", question: "Proceed?", impact: "Blocks", canContinue: true },
				})

			const first = await sendQuestion()
			expect(first.reason ?? "").not.toContain("Duplicate")
			const duplicate = await sendQuestion()
			expect(duplicate).toMatchObject({
				status: "rejected",
				reason: expect.stringContaining("Duplicate message dropped"),
			})

			const different = await cap.sendMessage(`call-${call++}`, {
				recipient: { type: "parent" },
				payload: { kind: "question", question: "Different?", impact: "Blocks", canContinue: true },
			})
			expect(different.reason ?? "").not.toContain("Duplicate")

			vi.setSystemTime(Date.now() + AGENT_MESSAGE_LIMITS.duplicateMessageWindowMs + 1_000)
			const afterWindow = await sendQuestion()
			expect(afterWindow.reason ?? "").not.toContain("Duplicate")
		} finally {
			manager.dispose()
			vi.useRealTimers()
		}
	})

	it("closes the question thread when the recipient declines", async () => {
		const manager = new AgentManager(undefined, 4)
		try {
			manager.bindCommunicationRoot("root-1")
			const sourceRun = deferred<Awaited<ReturnType<typeof runAgent>>>()
			const targetRun = deferred<Awaited<ReturnType<typeof runAgent>>>()
			let sourceCapability: NonNullable<Parameters<typeof runAgent>[3]>["agentMessage"]
			let targetCapability: NonNullable<Parameters<typeof runAgent>[3]>["agentMessage"]
			mockRunAgent.mockImplementationOnce((_ctx, _type, _prompt, options) => {
				sourceCapability = options.agentMessage
				return sourceRun.promise
			})
			mockRunAgent.mockImplementationOnce((_ctx, _type, _prompt, options) => {
				targetCapability = options.agentMessage
				return targetRun.promise
			})
			const source = manager.spawn(fakePi(), fakeCtx(), "Explore", "source", {
				description: "source",
				communication: "group",
				rootSessionId: "root-1",
			})
			const target = manager.spawn(fakePi(), fakeCtx(), "Explore", "target", {
				description: "target",
				communication: "group",
				rootSessionId: "root-1",
			})
			const sourceRecord = manager.getRecord(source)
			const targetRecord = manager.getRecord(target)
			if (!sourceCapability || !targetCapability || !sourceRecord || !targetRecord) {
				throw new Error("expected live communication capabilities")
			}
			sourceRecord.groupId = "batch-1"
			targetRecord.groupId = "batch-1"
			const sourceSteer = vi.fn().mockResolvedValue(undefined)
			sourceRecord.status = "running"
			sourceRecord.session = { steer: sourceSteer, dispose: vi.fn() } as unknown as AgentSession
			const targetSteer = vi.fn().mockResolvedValue(undefined)
			targetRecord.status = "running"
			targetRecord.session = { steer: targetSteer, dispose: vi.fn() } as unknown as AgentSession

			const pending = await sourceCapability.sendMessage("peer-question", {
				recipient: { type: "agent", agentId: target },
				payload: { kind: "question", question: "Proceed?", impact: "Blocks", canContinue: true },
			})
			expect(pending).toMatchObject({ status: "queued_for_running_session" })
			await vi.waitFor(() => expect(targetSteer).toHaveBeenCalled())

			await expect(
				targetCapability.sendMessage("peer-decline", {
					recipient: { type: "agent", agentId: source },
					payload: { kind: "decline", reason: "Out of my scope" },
					reply_to: pending.messageId ?? "",
				}),
			).resolves.toMatchObject({ status: "queued_for_running_session" })
			expect(sourceSteer).toHaveBeenCalledWith(expect.stringContaining("Out of my scope"))

			const afterClose = await targetCapability.sendMessage("peer-decline-2", {
				recipient: { type: "agent", agentId: source },
				payload: { kind: "decline", reason: "still out of scope" },
				reply_to: pending.messageId ?? "",
			})
			expect(afterClose).toMatchObject({ status: "rejected", reason: "thread_closed" })
		} finally {
			manager.dispose()
		}
	})

	it("closes the thread with a parent decline that frees the child to continue", async () => {
		const manager = new AgentManager(undefined, 0)
		try {
			manager.bindCommunicationRoot("root-1")
			const source = spawnCommunicatingAgent(manager, "parent")
			const record = manager.getRecord(source)
			if (!record) throw new Error("expected source record")
			const steer = vi.fn().mockResolvedValue(undefined)
			record.status = "running"
			record.session = { steer, dispose: vi.fn() } as unknown as AgentSession
			const question = createInitialMessage(manager, source, "decline-question", { type: "parent" }, "question")
			expect(manager.registerMessageThread(question)).toEqual({ accepted: true })

			await expect(
				manager.replyToAgentMessage("root-1", "decline-question", "decline-reply", "Out of scope", {
					maxTurns: 1,
					maxDuration: 30,
					answerKind: "decline",
				}),
			).resolves.toMatchObject({ status: "queued_for_running_session" })
			expect(steer).toHaveBeenCalledWith(expect.stringContaining("Host-mediated decline"))
			expect(steer).toHaveBeenCalledWith(expect.stringContaining("canContinue"))

			const afterClose = await manager.replyToAgentMessage("root-1", "decline-question", "decline-reply-2", "later", {
				maxTurns: 1,
				maxDuration: 30,
			})
			expect(afterClose).toMatchObject({ status: "rejected", reason: "thread_closed" })
		} finally {
			manager.dispose()
		}
	})

	it("rejects wrong-root replies before thread lookup and queues one correlated parent answer", async () => {
		const manager = new AgentManager(undefined, 0)
		try {
			manager.bindCommunicationRoot("root-1")
			const source = spawnCommunicatingAgent(manager, "parent")
			const record = manager.getRecord(source)
			if (!record) throw new Error("expected source record")
			const steer = vi.fn().mockResolvedValue(undefined)
			const session = { steer, dispose: vi.fn() } as unknown as AgentSession
			record.status = "running"
			record.session = session
			const runningQuestion = createInitialMessage(manager, source, "running-question", { type: "parent" }, "question")
			expect(manager.registerMessageThread(runningQuestion)).toEqual({ accepted: true })

			const wrongKnown = await manager.replyToAgentMessage("wrong-root", "running-question", "wrong-1", "answer", {
				maxTurns: 1,
				maxDuration: 30,
			})
			const wrongUnknown = await manager.replyToAgentMessage("wrong-root", "unknown", "wrong-2", "answer", {
				maxTurns: 1,
				maxDuration: 30,
			})
			expect(wrongKnown).toEqual(wrongUnknown)

			await expect(
				manager.replyToAgentMessage("root-1", "running-question", "running-reply", "continue", {
					maxTurns: 2,
					maxDuration: 30,
					tokenBudget: 2048,
				}),
			).resolves.toMatchObject({ status: "queued_for_running_session" })
			expect(steer).toHaveBeenCalledWith(expect.stringContaining("continue"))

			const boundaryQuestion = createInitialMessage(
				manager,
				source,
				"boundary-question",
				{ type: "parent" },
				"question",
			)
			expect(manager.registerMessageThread(boundaryQuestion)).toEqual({ accepted: true })
			await expect(
				manager.replyToAgentMessage(
					"root-1",
					"boundary-question",
					"boundary-reply",
					"a".repeat(AGENT_MESSAGE_LIMITS.maxPayloadBytes),
					{ maxTurns: 1, maxDuration: 30 },
				),
			).resolves.toMatchObject({ status: "queued_for_running_session" })

			const oversizedQuestion = createInitialMessage(
				manager,
				source,
				"oversized-question",
				{ type: "parent" },
				"question",
			)
			expect(manager.registerMessageThread(oversizedQuestion)).toEqual({ accepted: true })
			const steersBeforeOversizedReply = steer.mock.calls.length
			await expect(
				manager.replyToAgentMessage(
					"root-1",
					"oversized-question",
					"oversized-reply",
					"a".repeat(AGENT_MESSAGE_LIMITS.maxPayloadBytes + 1),
					{ maxTurns: 1, maxDuration: 30 },
				),
			).resolves.toMatchObject({ status: "rejected" })
			expect(manager.getMessageThread("oversized-question")).toMatchObject({ state: "open" })
			expect(steer).toHaveBeenCalledTimes(steersBeforeOversizedReply)

			const queuedQuestion = createInitialMessage(manager, source, "queued-question", { type: "parent" }, "question")
			expect(manager.registerMessageThread(queuedQuestion)).toEqual({ accepted: true })
			record.status = "queued"
			record.session = undefined
			await expect(
				manager.replyToAgentMessage("root-1", "queued-question", "queued-reply", "wait", {
					maxTurns: 1,
					maxDuration: 30,
				}),
			).resolves.toMatchObject({ status: "queued_before_session" })

			await expect(
				manager.replyToAgentMessage("root-1", "queued-question", "bad-bounds", "wait", {
					maxTurns: 0,
					maxDuration: 30,
				}),
			).resolves.toMatchObject({ status: "rejected" })
			await expect(
				manager.replyToAgentMessage("root-1", "queued-question", "bad-duration", "wait", {
					maxTurns: 1,
					maxDuration: 0,
				}),
			).resolves.toMatchObject({ status: "rejected" })
			await expect(
				manager.replyToAgentMessage("root-1", "queued-question", "bad-budget", "wait", {
					maxTurns: 1,
					maxDuration: 30,
					tokenBudget: 1023,
				}),
			).resolves.toMatchObject({ status: "rejected" })
			const minimumBudgetQuestion = createInitialMessage(
				manager,
				source,
				"minimum-budget-question",
				{ type: "parent" },
				"question",
			)
			expect(manager.registerMessageThread(minimumBudgetQuestion)).toEqual({ accepted: true })
			await expect(
				manager.replyToAgentMessage("root-1", "minimum-budget-question", "minimum-budget", "wait", {
					maxTurns: 1,
					maxDuration: 30,
					tokenBudget: 1024,
				}),
			).resolves.toMatchObject({ status: "queued_before_session" })
		} finally {
			manager.dispose()
		}
	})

	it("closes the first concurrent parent answer, replays it, and rejects late replies", async () => {
		const manager = new AgentManager(undefined, 0)
		try {
			manager.bindCommunicationRoot("root-1")
			const source = spawnCommunicatingAgent(manager, "parent")
			const record = manager.getRecord(source)
			if (!record) throw new Error("expected source record")
			const steer = deferred<void>()
			record.status = "running"
			record.session = { steer: vi.fn(() => steer.promise), dispose: vi.fn() } as unknown as AgentSession
			const question = createInitialMessage(manager, source, "race-question", { type: "parent" }, "question")
			expect(manager.registerMessageThread(question)).toEqual({ accepted: true })

			const first = manager.replyToAgentMessage("root-1", "race-question", "reply-1", "first", {
				maxTurns: 1,
				maxDuration: 30,
			})
			const replay = manager.replyToAgentMessage("root-1", "race-question", "reply-1", "first", {
				maxTurns: 1,
				maxDuration: 30,
			})
			await expect(
				manager.replyToAgentMessage("root-1", "race-question", "reply-2", "late", {
					maxTurns: 1,
					maxDuration: 30,
				}),
			).resolves.toEqual({ status: "rejected", reason: "thread_closed" })
			expect(manager.getMessageThread("race-question")).toMatchObject({ state: "closed" })
			steer.resolve()
			await expect(first).resolves.toMatchObject({ status: "queued_for_running_session" })
			await expect(replay).resolves.toMatchObject({ status: "queued_for_running_session" })
		} finally {
			manager.dispose()
		}
	})

	it("uses the existing continuation gate for settled parent reply targets", async () => {
		const manager = new AgentManager(undefined, 0)
		try {
			manager.bindCommunicationRoot("root-1")
			const source = spawnCommunicatingAgent(manager, "parent")
			const record = manager.getRecord(source)
			if (!record) throw new Error("expected source record")
			const steer = vi.fn().mockResolvedValue(undefined)
			const session = { steer, dispose: vi.fn() } as unknown as AgentSession
			record.session = session
			mockResumeAgent.mockResolvedValueOnce({ responseText: "continued", session, aborted: false, steered: false })
			for (const [messageId, status] of [
				["completed-reply", "completed"],
				["error-reply", "error"],
			] as const) {
				record.status = status
				const question = createInitialMessage(manager, source, messageId, { type: "parent" }, "question")
				expect(manager.registerMessageThread(question)).toEqual({ accepted: true })
				if (messageId === "error-reply") {
					mockResumeAgent.mockResolvedValueOnce({ responseText: "recovered", session, aborted: false, steered: false })
				}
				await expect(
					manager.replyToAgentMessage("root-1", messageId, `${messageId}-call`, "continue", {
						maxTurns: 2,
						maxDuration: 30,
						tokenBudget: 2048,
					}),
				).resolves.toMatchObject({ status: "resume_attempt_completed", agentOutcome: { status: "completed" } })
			}

			record.status = "stopped"
			const stopped = createInitialMessage(manager, source, "stopped-reply", { type: "parent" }, "question")
			expect(manager.registerMessageThread(stopped)).toEqual({ accepted: true })
			await expect(
				manager.replyToAgentMessage("root-1", "stopped-reply", "stopped-call", "continue", {
					maxTurns: 1,
					maxDuration: 30,
				}),
			).resolves.toMatchObject({ status: "unavailable" })

			record.status = "completed"
			record.session = undefined
			const sessionless = createInitialMessage(manager, source, "sessionless-reply", { type: "parent" }, "question")
			expect(manager.registerMessageThread(sessionless)).toEqual({ accepted: true })
			await expect(
				manager.replyToAgentMessage("root-1", "sessionless-reply", "sessionless-call", "continue", {
					maxTurns: 1,
					maxDuration: 30,
				}),
			).resolves.toMatchObject({ status: "unavailable" })

			record.session = session
			record.taskRef = {
				kind: "ferment_step",
				ferment_id: "f-1",
				phase_id: "p-1",
				step_id: "s-1",
				budget_tier: "narrow",
			}
			manager.submitReport(source, {
				status: "completed",
				summary: "done",
				steps_completed: ["done"],
				remaining_steps: [],
			})
			record.status = "running"
			const reported = createInitialMessage(manager, source, "reported-reply", { type: "parent" }, "question")
			expect(manager.registerMessageThread(reported)).toEqual({ accepted: true })
			await expect(
				manager.replyToAgentMessage("root-1", "reported-reply", "reported-call", "continue", {
					maxTurns: 1,
					maxDuration: 30,
				}),
			).resolves.toMatchObject({ status: "unavailable" })
			expect(steer).not.toHaveBeenCalled()

			record.status = "completed"
			record.agentReport = undefined
			record.lifetimeUsage.output = 100_000
			const exhausted = createInitialMessage(manager, source, "exhausted-reply", { type: "parent" }, "question")
			expect(manager.registerMessageThread(exhausted)).toEqual({ accepted: true })
			await expect(
				manager.replyToAgentMessage("root-1", "exhausted-reply", "exhausted-call", "continue", {
					maxTurns: 1,
					maxDuration: 30,
				}),
			).resolves.toMatchObject({ status: "unavailable" })

			record.lifetimeUsage.output = 0
			record.resumeAttempts = [
				{ attempt_id: 1, purpose: "continuation", startedAt: 1 },
				{ attempt_id: 2, purpose: "continuation", startedAt: 2 },
			]
			const capped = createInitialMessage(manager, source, "capped-reply", { type: "parent" }, "question")
			expect(manager.registerMessageThread(capped)).toEqual({ accepted: true })
			await expect(
				manager.replyToAgentMessage("root-1", "capped-reply", "capped-call", "continue", {
					maxTurns: 1,
					maxDuration: 30,
				}),
			).resolves.toMatchObject({ status: "unavailable" })
			expect(mockResumeAgent).toHaveBeenCalledTimes(2)
		} finally {
			manager.dispose()
		}
	})

	it("keeps parent questions replyable after retained-session completed or error transitions", async () => {
		for (const terminalStatus of ["completed", "error"] as const) {
			const manager = new AgentManager(undefined, 4)
			try {
				manager.bindCommunicationRoot("root-1")
				const session = { dispose: vi.fn() } as unknown as AgentSession
				if (terminalStatus === "completed") {
					mockRunAgent.mockResolvedValueOnce({ responseText: "done", session, aborted: false, steered: false })
				} else {
					mockRunAgent.mockImplementationOnce((_ctx, _type, _prompt, options) => {
						options.onSessionCreated?.(session)
						return Promise.reject(new Error("failed"))
					})
				}
				const source = manager.spawn(fakePi(), fakeCtx(), "Explore", terminalStatus, {
					description: terminalStatus,
					communication: "parent",
					rootSessionId: "root-1",
				})
				const questionId = `${terminalStatus}-retained-question`
				expect(
					manager.registerMessageThread(
						createInitialMessage(manager, source, questionId, { type: "parent" }, "question"),
					),
				).toEqual({ accepted: true })
				await vi.waitFor(() => expect(manager.getRecord(source)?.status).toBe(terminalStatus))
				expect(manager.getMessageThread(questionId)).toMatchObject({ state: "open" })

				mockResumeAgent.mockResolvedValueOnce({ responseText: "continued", session, aborted: false, steered: false })
				await expect(
					manager.replyToAgentMessage("root-1", questionId, `${terminalStatus}-reply`, "continue", {
						maxTurns: 1,
						maxDuration: 30,
					}),
				).resolves.toMatchObject({ status: "resume_attempt_completed", agentOutcome: { status: "completed" } })
			} finally {
				manager.dispose()
			}
		}
	})

	it("keeps a pre-aborted reply open and aborts an in-flight settled resume", async () => {
		const manager = new AgentManager(undefined, 0)
		try {
			manager.bindCommunicationRoot("root-1")
			const source = spawnCommunicatingAgent(manager, "parent")
			const record = manager.getRecord(source)
			if (!record) throw new Error("expected source record")
			const session = { dispose: vi.fn() } as unknown as AgentSession
			record.status = "completed"
			record.session = session
			const resumeCallsBefore = mockResumeAgent.mock.calls.length

			const preAbortedQuestion = createInitialMessage(
				manager,
				source,
				"pre-aborted-question",
				{ type: "parent" },
				"question",
			)
			expect(manager.registerMessageThread(preAbortedQuestion)).toEqual({ accepted: true })
			const preAborted = new AbortController()
			preAborted.abort()
			await expect(
				manager.replyToAgentMessage(
					"root-1",
					"pre-aborted-question",
					"pre-aborted-reply",
					"continue",
					{ maxTurns: 1, maxDuration: 30, tokenBudget: 1024 },
					preAborted.signal,
				),
			).resolves.toEqual({ status: "rejected", reason: "Message reply was aborted." })
			expect(manager.getMessageThread("pre-aborted-question")).toMatchObject({ state: "open" })
			expect(mockResumeAgent).toHaveBeenCalledTimes(resumeCallsBefore)

			const inFlightQuestion = createInitialMessage(
				manager,
				source,
				"in-flight-question",
				{ type: "parent" },
				"question",
			)
			expect(manager.registerMessageThread(inFlightQuestion)).toEqual({ accepted: true })
			const inFlight = new AbortController()
			mockResumeAgent.mockImplementationOnce((_session, _prompt, options) => {
				const result = deferred<Awaited<ReturnType<typeof resumeAgent>>>()
				options?.signal?.addEventListener(
					"abort",
					() =>
						result.resolve({
							responseText: "cancelled",
							session,
							aborted: true,
							abortReason: "max_duration",
							steered: false,
						}),
					{ once: true },
				)
				return result.promise
			})
			const reply = manager.replyToAgentMessage(
				"root-1",
				"in-flight-question",
				"in-flight-reply",
				"continue",
				{ maxTurns: 1, maxDuration: 30, tokenBudget: 1024 },
				inFlight.signal,
			)
			await vi.waitFor(() => expect(mockResumeAgent).toHaveBeenCalledTimes(resumeCallsBefore + 1))
			const runnerSignal = mockResumeAgent.mock.calls.at(-1)?.[2]?.signal
			expect(runnerSignal?.aborted).toBe(false)
			inFlight.abort()
			expect(runnerSignal?.aborted).toBe(true)
			await expect(reply).resolves.toMatchObject({
				status: "resume_attempt_completed",
				agentOutcome: { status: "aborted" },
			})
			expect(manager.getRecord(source)?.status).toBe("aborted")
			expect(manager.getMessageThread("in-flight-question")).toMatchObject({ state: "closed" })
		} finally {
			manager.dispose()
		}
	})

	it("routes only same-root group peers through live sessions or pending delivery", async () => {
		const manager = new AgentManager(undefined, 4)
		try {
			mockResumeAgent.mockClear()
			manager.bindCommunicationRoot("root-1")
			const sourceRun = deferred<Awaited<ReturnType<typeof runAgent>>>()
			const targetRun = deferred<Awaited<ReturnType<typeof runAgent>>>()
			let sourceCapability: NonNullable<Parameters<typeof runAgent>[3]>["agentMessage"]
			let targetCapability: NonNullable<Parameters<typeof runAgent>[3]>["agentMessage"]
			let targetOptions: Parameters<typeof runAgent>[3] | undefined
			mockRunAgent.mockImplementationOnce((_ctx, _type, _prompt, options) => {
				sourceCapability = options.agentMessage
				return sourceRun.promise
			})
			mockRunAgent.mockImplementationOnce((_ctx, _type, _prompt, options) => {
				targetCapability = options.agentMessage
				targetOptions = options
				return targetRun.promise
			})
			const source = manager.spawn(fakePi(), fakeCtx(), "Explore", "source", {
				description: "source",
				communication: "group",
				rootSessionId: "root-1",
			})
			const target = manager.spawn(fakePi(), fakeCtx(), "Explore", "target", {
				description: "target",
				communication: "group",
				rootSessionId: "root-1",
			})
			const sourceRecord = manager.getRecord(source)
			const targetRecord = manager.getRecord(target)
			if (!sourceCapability || !targetCapability || !targetOptions || !sourceRecord || !targetRecord) {
				throw new Error("expected live communication capabilities")
			}
			sourceRecord.groupId = "batch-1"
			targetRecord.groupId = "batch-1"
			const sourceSteer = vi.fn().mockResolvedValue(undefined)
			sourceRecord.session = { steer: sourceSteer, dispose: vi.fn() } as unknown as AgentSession

			expect(sourceCapability.listContacts()).toMatchObject({ peers: [{ agent_id: target, status: "initializing" }] })
			const pending = await sourceCapability.sendMessage("peer-pending", {
				recipient: { type: "agent", agentId: target },
				payload: { kind: "question", question: "Proceed?", impact: "Blocks", canContinue: false },
			})
			expect(pending).toMatchObject({ status: "queued_before_session" })
			const targetSteer = vi.fn().mockResolvedValue(undefined)
			targetOptions.onSessionCreated?.({ steer: targetSteer, dispose: vi.fn() } as unknown as AgentSession)
			await vi.waitFor(() => expect(targetSteer).toHaveBeenCalledOnce())

			await expect(
				sourceCapability.sendMessage("peer-live", {
					recipient: { type: "agent", agentId: target },
					payload: { kind: "status", summary: "still working" },
				}),
			).resolves.toMatchObject({ status: "queued_for_running_session" })
			expect(targetSteer).toHaveBeenCalledTimes(2)

			await expect(
				targetCapability.sendMessage("peer-answer", {
					recipient: { type: "agent", agentId: source },
					payload: { kind: "answer", answer: "yes" },
					reply_to: pending.messageId ?? "",
				}),
			).resolves.toMatchObject({ status: "queued_for_running_session" })
			expect(sourceSteer).toHaveBeenCalledWith(expect.stringContaining("yes"))

			targetRecord.groupId = "other-batch"
			await expect(
				sourceCapability.sendMessage("out-of-group", {
					recipient: { type: "agent", agentId: target },
					payload: { kind: "status", summary: "hidden" },
				}),
			).resolves.toMatchObject({ status: "unavailable" })
			targetRecord.groupId = "batch-1"
			targetRecord.status = "completed"
			await expect(
				sourceCapability.sendMessage("terminal-peer", {
					recipient: { type: "agent", agentId: target },
					payload: { kind: "status", summary: "hidden" },
				}),
			).resolves.toMatchObject({ status: "unavailable" })
			expect(mockResumeAgent).not.toHaveBeenCalled()
		} finally {
			manager.dispose()
		}
	})

	it("drains accepted one-way peer status and handoff messages after the sender completes", async () => {
		const manager = new AgentManager(undefined, 4)
		try {
			manager.bindCommunicationRoot("root-1")
			const sourceRun = deferred<Awaited<ReturnType<typeof runAgent>>>()
			const targetRun = deferred<Awaited<ReturnType<typeof runAgent>>>()
			let sourceCapability: NonNullable<Parameters<typeof runAgent>[3]>["agentMessage"]
			let targetOptions: Parameters<typeof runAgent>[3] | undefined
			mockRunAgent.mockImplementationOnce((_ctx, _type, _prompt, options) => {
				sourceCapability = options.agentMessage
				return sourceRun.promise
			})
			mockRunAgent.mockImplementationOnce((_ctx, _type, _prompt, options) => {
				targetOptions = options
				return targetRun.promise
			})
			const source = manager.spawn(fakePi(), fakeCtx(), "Explore", "source", {
				description: "source",
				communication: "group",
				rootSessionId: "root-1",
			})
			const target = manager.spawn(fakePi(), fakeCtx(), "Explore", "target", {
				description: "target",
				communication: "group",
				rootSessionId: "root-1",
			})
			const sourceRecord = manager.getRecord(source)
			const targetRecord = manager.getRecord(target)
			if (!sourceCapability || !targetOptions || !sourceRecord || !targetRecord) {
				throw new Error("expected live peer records")
			}
			sourceRecord.groupId = "batch-1"
			targetRecord.groupId = "batch-1"

			await expect(
				sourceCapability.sendMessage("status-before-completion", {
					recipient: { type: "agent", agentId: target },
					payload: { kind: "status", summary: "handoff ready" },
				}),
			).resolves.toMatchObject({ status: "queued_before_session" })
			await expect(
				sourceCapability.sendMessage("handoff-before-completion", {
					recipient: { type: "agent", agentId: target },
					payload: {
						kind: "handoff",
						action: "continue",
						state: "ready",
						evidence: [{ label: "result", reference: "agent output" }],
						nextAction: "inspect output",
					},
				}),
			).resolves.toMatchObject({ status: "queued_before_session" })

			sourceRun.resolve({
				responseText: "done",
				session: { dispose: vi.fn() } as unknown as AgentSession,
				aborted: false,
				steered: false,
			})
			await vi.waitFor(() => expect(sourceRecord.status).toBe("completed"))

			const targetSteer = vi.fn().mockResolvedValue(undefined)
			targetOptions.onSessionCreated?.({ steer: targetSteer, dispose: vi.fn() } as unknown as AgentSession)
			await vi.waitFor(() => expect(targetSteer).toHaveBeenCalledTimes(2))
		} finally {
			manager.dispose()
		}
	})

	it("closes accepted peer questions before either participant becomes terminal", async () => {
		for (const status of ["completed", "steered", "aborted", "stopped", "error"] as const) {
			for (const terminalParticipant of ["source", "target"] as const) {
				const manager = new AgentManager(undefined, 4)
				try {
					manager.bindCommunicationRoot("root-1")
					const sourceRun = deferred<Awaited<ReturnType<typeof runAgent>>>()
					const targetRun = deferred<Awaited<ReturnType<typeof runAgent>>>()
					mockRunAgent.mockImplementationOnce(() => sourceRun.promise)
					mockRunAgent.mockImplementationOnce(() => targetRun.promise)
					const source = manager.spawn(fakePi(), fakeCtx(), "Explore", "source", {
						description: "source",
						communication: "group",
						rootSessionId: "root-1",
					})
					const target = manager.spawn(fakePi(), fakeCtx(), "Explore", "target", {
						description: "target",
						communication: "group",
						rootSessionId: "root-1",
					})
					const sourceRecord = manager.getRecord(source)
					const targetRecord = manager.getRecord(target)
					if (!sourceRecord || !targetRecord) throw new Error("expected peer records")
					sourceRecord.groupId = "batch-1"
					targetRecord.groupId = "batch-1"
					const questionId = `${status}-${terminalParticipant}`
					expect(
						manager.registerMessageThread(
							createInitialMessage(manager, source, questionId, { type: "agent", agentId: target }, "question"),
						),
					).toEqual({ accepted: true })

					const terminalRun = terminalParticipant === "source" ? sourceRun : targetRun
					const terminalId = terminalParticipant === "source" ? source : target
					if (status === "stopped") {
						expect(manager.abort(terminalId)).toBe(true)
					} else if (status === "error") {
						terminalRun.reject(new Error("failed"))
					} else {
						terminalRun.resolve({
							responseText: "done",
							session: { dispose: vi.fn() } as unknown as AgentSession,
							aborted: status === "aborted",
							steered: status === "steered",
						})
					}
					await vi.waitFor(() => expect(manager.getMessageThread(questionId)).toMatchObject({ state: "closed" }))
					await expect(
						manager.reservePeerReply(target, questionId, source, `late-${questionId}`, 1, "answer", () => ({
							status: "queued_for_running_session",
						})),
					).resolves.toEqual({ status: "rejected", reason: "thread_closed" })
				} finally {
					manager.dispose()
				}
			}
		}
	})

	it("terminalizes pending replies when a queued run fails to start", async () => {
		const manager = new AgentManager(undefined, 1)
		try {
			manager.bindCommunicationRoot("root-1")
			const bridge = vi.fn<AgentParentBridge>(() => true)
			const events = vi.fn()
			manager.registerParentBridge("root-1", bridge)
			manager.setMessageEventHandler(events)
			const blockerRun = deferred<Awaited<ReturnType<typeof runAgent>>>()
			mockRunAgent.mockImplementationOnce(() => blockerRun.promise)
			manager.spawn(fakePi(), fakeCtx(), "Explore", "blocker", {
				description: "blocker",
				isBackground: true,
			})
			mockRunAgent.mockImplementationOnce(() => {
				throw new Error("session creation failed")
			})
			const source = spawnCommunicatingAgent(manager, "parent")
			await queuePendingParentReply(manager, source, "start-failure-question")

			blockerRun.resolve({
				responseText: "done",
				session: { dispose: vi.fn() } as unknown as AgentSession,
				aborted: false,
				steered: false,
			})
			await vi.waitFor(() => expect(manager.getRecord(source)?.status).toBe("error"))
			expectPendingDeliveryFailure(manager, "start-failure-question", bridge, events)
		} finally {
			manager.dispose()
		}
	})

	it("terminalizes pending replies on sessionless completion", async () => {
		const manager = new AgentManager(undefined, 0)
		try {
			manager.bindCommunicationRoot("root-1")
			const bridge = vi.fn<AgentParentBridge>(() => true)
			const events = vi.fn()
			manager.registerParentBridge("root-1", bridge)
			manager.setMessageEventHandler(events)
			const source = spawnCommunicatingAgent(manager, "parent")
			await queuePendingParentReply(manager, source, "sessionless-completion-question")

			manager.completeTransient(source)
			expect(manager.getRecord(source)?.status).toBe("completed")
			expectPendingDeliveryFailure(manager, "sessionless-completion-question", bridge, events)
		} finally {
			manager.dispose()
		}
	})

	it("terminalizes pending replies when a run errors before its session exists", async () => {
		const manager = new AgentManager(undefined, 4)
		try {
			manager.bindCommunicationRoot("root-1")
			const bridge = vi.fn<AgentParentBridge>(() => true)
			const events = vi.fn()
			manager.registerParentBridge("root-1", bridge)
			manager.setMessageEventHandler(events)
			const run = deferred<Awaited<ReturnType<typeof runAgent>>>()
			mockRunAgent.mockImplementationOnce(() => run.promise)
			const source = manager.spawn(fakePi(), fakeCtx(), "Explore", "source", {
				description: "source",
				communication: "parent",
				rootSessionId: "root-1",
			})
			await queuePendingParentReply(manager, source, "sessionless-error-question")

			run.reject(new Error("session failed"))
			await vi.waitFor(() => expect(manager.getRecord(source)?.status).toBe("error"))
			expectPendingDeliveryFailure(manager, "sessionless-error-question", bridge, events)
		} finally {
			manager.dispose()
		}
	})

	it("terminalizes pending replies when a completed record is removed", async () => {
		const manager = new AgentManager(undefined, 0)
		try {
			manager.bindCommunicationRoot("root-1")
			const bridge = vi.fn<AgentParentBridge>(() => true)
			const events = vi.fn()
			manager.registerParentBridge("root-1", bridge)
			manager.setMessageEventHandler(events)
			const source = spawnCommunicatingAgent(manager, "parent")
			await queuePendingParentReply(manager, source, "record-removal-question")
			const record = manager.getRecord(source)
			if (!record) throw new Error("expected queued source")
			record.status = "completed"

			manager.clearCompleted()
			expect(manager.getRecord(source)).toBeUndefined()
			expectPendingDeliveryFailure(manager, "record-removal-question", bridge, events, "removed")
		} finally {
			manager.dispose()
		}
	})

	it("awaits pending delivery drain before terminal completion and reports one body-free failure", async () => {
		const manager = new AgentManager(undefined, 4)
		try {
			manager.bindCommunicationRoot("root-1")
			const bridge = vi.fn<AgentParentBridge>(() => true)
			manager.registerParentBridge("root-1", bridge)
			const run = deferred<Awaited<ReturnType<typeof runAgent>>>()
			let startOptions: Parameters<typeof runAgent>[3] | undefined
			mockRunAgent.mockImplementationOnce((_ctx, _type, _prompt, options) => {
				startOptions = options
				return run.promise
			})
			const source = manager.spawn(fakePi(), fakeCtx(), "Explore", "source", {
				description: "source",
				communication: "parent",
				rootSessionId: "root-1",
			})
			const record = manager.getRecord(source)
			if (!record || !startOptions) throw new Error("expected running source")
			const question = createInitialMessage(manager, source, "drain-question", { type: "parent" }, "question")
			expect(manager.registerMessageThread(question)).toEqual({ accepted: true })
			await expect(
				manager.replyToAgentMessage("root-1", "drain-question", "drain-reply", "continue", {
					maxTurns: 1,
					maxDuration: 30,
				}),
			).resolves.toMatchObject({ status: "queued_before_session" })

			const steer = deferred<void>()
			const session = { steer: vi.fn(() => steer.promise), dispose: vi.fn() } as unknown as AgentSession
			startOptions.onSessionCreated?.(session)
			run.resolve({ responseText: "done", session, aborted: false, steered: false })
			await expectStillPending(record.promise ?? Promise.resolve())
			steer.reject(new Error("steer failed"))
			await record.promise

			expect(record.status).toBe("completed")
			expect(bridge).toHaveBeenCalledOnce()
			const notification = bridge.mock.calls[0]?.[0]
			expect(notification).toMatchObject({ kind: "delivery_failure", messageId: "drain-question" })
			expect(notification).not.toHaveProperty("message")
			manager.abort(source)
			expect(bridge).toHaveBeenCalledOnce()
		} finally {
			manager.dispose()
		}
	})

	it("terminalizes queued replies once and clears shutdown queues without claiming parent visibility", async () => {
		const manager = new AgentManager(undefined, 0)
		try {
			manager.bindCommunicationRoot("root-1")
			const bridge = vi.fn<AgentParentBridge>(() => true)
			manager.registerParentBridge("root-1", bridge)
			const source = spawnCommunicatingAgent(manager, "parent")
			const question = createInitialMessage(manager, source, "abort-question", { type: "parent" }, "question")
			expect(manager.registerMessageThread(question)).toEqual({ accepted: true })
			await manager.replyToAgentMessage("root-1", "abort-question", "abort-reply", "wait", {
				maxTurns: 1,
				maxDuration: 30,
			})
			expect(manager.abort(source)).toBe(true)
			expect(bridge).toHaveBeenCalledOnce()
			expect(bridge.mock.calls[0]?.[0]).toMatchObject({ kind: "delivery_failure", messageId: "abort-question" })
			expect(manager.abort(source)).toBe(false)
			expect(bridge).toHaveBeenCalledOnce()
		} finally {
			manager.dispose()
		}

		const shutdownManager = new AgentManager(undefined, 0)
		try {
			shutdownManager.bindCommunicationRoot("root-1")
			const bridge = vi.fn<AgentParentBridge>(() => true)
			shutdownManager.registerParentBridge("root-1", bridge)
			const source = spawnCommunicatingAgent(shutdownManager, "parent")
			const question = createInitialMessage(
				shutdownManager,
				source,
				"shutdown-question",
				{ type: "parent" },
				"question",
			)
			expect(shutdownManager.registerMessageThread(question)).toEqual({ accepted: true })
			await shutdownManager.replyToAgentMessage("root-1", "shutdown-question", "shutdown-reply", "wait", {
				maxTurns: 1,
				maxDuration: 30,
			})
			shutdownManager.disableCommunication("root-1")
			expect(bridge).not.toHaveBeenCalled()
			expect(shutdownManager.getMessageBrokerStats().pendingMessages).toBe(0)
		} finally {
			shutdownManager.dispose()
		}
	})
})

function spawnCommunicatingAgent(manager: AgentManager, communication: "parent" | "group"): string {
	return manager.spawn(fakePi(), fakeCtx(), "Explore", "inspect", {
		description: "inspect",
		isBackground: true,
		communication,
		rootSessionId: "root-1",
	})
}

function createInitialMessage(
	manager: AgentManager,
	sourceAgentId: string,
	id: string,
	recipient: { type: "parent" } | { type: "user" } | { type: "agent"; agentId: string },
	kind: "question" | "status",
	createdAt?: number,
) {
	const scope = manager.getCommunicationScope(sourceAgentId)
	const record = manager.getRecord(sourceAgentId)
	if (!scope || !record) throw new Error("expected communication source")
	return createAgentMessage(
		{ idempotencyKey: `key:${id}`, scope, sourceAttemptId: record.currentAttemptId },
		id,
		recipient,
		kind === "question"
			? { kind, question: "Proceed?", impact: "Blocks", canContinue: false }
			: { kind, summary: "Checkpoint" },
		{ createdAt },
	)
}

async function queuePendingParentReply(manager: AgentManager, sourceAgentId: string, messageId: string): Promise<void> {
	const question = createInitialMessage(manager, sourceAgentId, messageId, { type: "parent" }, "question")
	expect(manager.registerMessageThread(question)).toEqual({ accepted: true })
	await expect(
		manager.replyToAgentMessage("root-1", messageId, `${messageId}-reply`, "wait", {
			maxTurns: 1,
			maxDuration: 30,
		}),
	).resolves.toMatchObject({ status: "queued_before_session" })
}

function expectPendingDeliveryFailure(
	manager: AgentManager,
	messageId: string,
	bridge: ReturnType<typeof vi.fn<AgentParentBridge>>,
	events: ReturnType<typeof vi.fn>,
	threadState: "closed" | "removed" = "closed",
): void {
	expect(manager.getMessageBrokerStats()).toMatchObject({ pendingMessages: 0, pendingPayloadBytes: 0 })
	if (threadState === "closed") expect(manager.getMessageThread(messageId)).toMatchObject({ state: "closed" })
	else expect(manager.getMessageThread(messageId)).toBeUndefined()
	expect(bridge).toHaveBeenCalledOnce()
	const notification = bridge.mock.calls[0]?.[0]
	expect(notification).toMatchObject({ kind: "delivery_failure", messageId })
	expect(notification).not.toHaveProperty("message")

	const failureEvents = events.mock.calls
		.map(([event]) => event)
		.filter((event) => event?.messageId === messageId && event.state === "unavailable")
	expect(failureEvents).toHaveLength(1)
	const failureEvent = failureEvents[0]
	expect(failureEvent).toMatchObject({ messageId, state: "unavailable", bytes: expect.any(Number) })
	expect(Object.keys(failureEvent).sort()).toEqual(
		[
			"bytes",
			"kind",
			"messageId",
			"sourceAgentId",
			"sourceTaskId",
			"state",
			"targetAgentId",
			"targetType",
			"threadId",
		].sort(),
	)
	for (const field of ["body", "payload", "prompt", "answer", "options", "evidence"]) {
		expect(failureEvent).not.toHaveProperty(field)
	}
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
	let resolve!: (value: T) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

async function expectStillPending(promise: Promise<unknown>): Promise<void> {
	let settled = false
	promise.then(() => {
		settled = true
	})
	await Promise.resolve()
	expect(settled).toBe(false)
}
