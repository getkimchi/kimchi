import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("./agent-runner.js", () => ({
	runAgent: vi.fn(),
	resumeAgent: vi.fn(),
	MIN_TOKEN_BUDGET: 1024,
	MIN_FINALIZE_TOKEN_BUDGET: 256,
}))

vi.mock("../../../config.js", () => ({
	loadConfig: vi.fn().mockReturnValue({ apiKey: "test-key" }),
	readGitToken: vi.fn().mockReturnValue(undefined),
	writeGitToken: vi.fn(),
}))

vi.mock("../../../sandbox/cloud/workspaces.js", () => ({
	listWorkspaces: vi.fn().mockResolvedValue([]),
}))

vi.mock("../../teleport/provisioning/clone-plan.js", () => ({
	resolveClonePlan: vi.fn(),
}))

vi.mock("../../teleport/provisioning/paths.js", () => ({
	repoBasename: vi.fn().mockReturnValue("repo"),
}))

vi.mock("./remote-agent-runner.js", () => ({
	runRemoteAgent: vi.fn(),
}))

vi.mock("../../teleport/ui/git-token-prompt.js", () => ({
	GitTokenPromptComponent: vi.fn(),
}))

vi.mock("../../teleport/provisioning/git-token.js", () => ({
	resolveGitToken: vi.fn(),
}))

import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { resolveClonePlan } from "../../teleport/provisioning/clone-plan.js"
import { resolveGitToken } from "../../teleport/provisioning/git-token.js"
import { AgentManager, buildAgentOutcome } from "./agent-manager.js"
import { resumeAgent, runAgent } from "./agent-runner.js"
import { runRemoteAgent } from "./remote-agent-runner.js"

const mockRunAgent = vi.mocked(runAgent)
const mockResumeAgent = vi.mocked(resumeAgent)
const mockResolveClonePlan = vi.mocked(resolveClonePlan)
const mockResolveGitToken = vi.mocked(resolveGitToken)
const mockRunRemoteAgent = vi.mocked(runRemoteAgent)

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

describe("AgentManager detachToBackground", () => {
	it("returns true and marks agent as background when detachResolver is set", () => {
		mockRunAgent.mockImplementationOnce(() => new Promise<never>(() => {}))
		const manager = new AgentManager()
		const id = manager.spawn(fakePi(), fakeCtx(), "Explore", "test", {
			description: "test",
			isBackground: false,
		})
		const record = manager.getRecord(id)
		expect(record).toBeDefined()
		if (!record) {
			manager.dispose()
			return
		}
		expect(record.isBackground).toBe(false)

		// Set detachResolver (as spawnRemoteAgentFn / Agent tool does)
		let detached = false
		record.detachResolver = () => {
			detached = true
		}

		const result = manager.detachToBackground(id)
		expect(result).toBe(true)
		expect(detached).toBe(true)
		expect(record.isBackground).toBe(true)
		expect(record.detachResolver).toBeUndefined()

		manager.dispose()
	})

	it("returns false when detachResolver is not set", () => {
		mockRunAgent.mockImplementationOnce(() => new Promise<never>(() => {}))
		const manager = new AgentManager()
		const id = manager.spawn(fakePi(), fakeCtx(), "Explore", "test", {
			description: "test",
			isBackground: false,
		})

		expect(manager.detachToBackground(id)).toBe(false)

		manager.dispose()
	})

	it("returns false for a non-running agent", async () => {
		mockRunAgent.mockResolvedValueOnce({
			responseText: "done",
			session: { dispose: vi.fn() } as unknown as AgentSession,
			aborted: false,
			steered: false,
		})
		const manager = new AgentManager()
		const record = await manager.spawnAndWait(fakePi(), fakeCtx(), "Explore", "test", {
			description: "test",
		})

		// Agent has completed — detach should fail
		expect(manager.detachToBackground(record.id)).toBe(false)
	})
})

describe("AgentManager remote git credential resolution", () => {
	let manager: AgentManager | undefined

	afterEach(() => {
		manager?.dispose()
		manager = undefined
		vi.clearAllMocks()
	})

	function fakeRemoteCtx(mode: "tui" | "rpc" = "tui"): ExtensionContext {
		return {
			cwd: "/work/myrepo",
			mode,
			ui: { custom: vi.fn() },
		} as unknown as ExtensionContext
	}

	beforeEach(() => {
		// Default mocks for remote path
		mockResolveClonePlan.mockResolvedValue({
			url: "git@gitlab.com:team/repo.git",
			httpsUrl: "https://gitlab.com/team/repo.git",
			branch: "main",
		})
		mockResolveGitToken.mockResolvedValue(undefined)
		mockRunRemoteAgent.mockResolvedValue({
			responseText: "done",
			stopReason: "end_turn",
			remoteSession: {
				workspaceId: "ws-1",
				sessionName: "acp-test",
				wsUrl: "wss://worker.example.com",
				host: "worker.example.com",
				cwd: "/home/sandbox/acp-test",
			},
		})
	})

	it("resolves git credential from cached token without prompting", async () => {
		mockResolveGitToken.mockResolvedValue("glpat-cached-token")
		manager = new AgentManager()

		const record = await manager.spawnAndWait(fakePi(), fakeRemoteCtx(), "Explore", "test", {
			description: "test",
			remote: true,
		})

		expect(record.status).toBe("completed")
		// resolveGitToken was called with the host extracted from httpsUrl
		expect(mockResolveGitToken).toHaveBeenCalledWith("gitlab.com", expect.any(Function), expect.any(Function))
		// gitCredential was forwarded to runRemoteAgent
		expect(mockRunRemoteAgent).toHaveBeenCalledWith(
			expect.anything(),
			expect.any(String),
			expect.objectContaining({
				gitCredential: { host: "gitlab.com", token: "glpat-cached-token" },
			}),
		)
	})

	it("passes undefined gitCredential when no token is resolved (non-interactive mode)", async () => {
		mockResolveGitToken.mockResolvedValue(undefined)
		manager = new AgentManager()

		await manager.spawnAndWait(fakePi(), fakeRemoteCtx("rpc"), "Explore", "test", {
			description: "test",
			remote: true,
		})

		// gitCredential should be undefined (no cached token, non-interactive)
		expect(mockRunRemoteAgent).toHaveBeenCalledWith(
			expect.anything(),
			expect.any(String),
			expect.objectContaining({
				gitCredential: undefined,
			}),
		)
	})

	it("proceeds without gitDetails when resolveClonePlan throws", async () => {
		mockResolveClonePlan.mockRejectedValue(new Error("not a git repo"))
		manager = new AgentManager()

		await manager.spawnAndWait(fakePi(), fakeRemoteCtx(), "Explore", "test", {
			description: "test",
			remote: true,
		})

		expect(mockResolveGitToken).not.toHaveBeenCalled()
		expect(mockRunRemoteAgent).toHaveBeenCalledWith(
			expect.anything(),
			expect.any(String),
			expect.objectContaining({
				gitDetails: undefined,
				gitCredential: undefined,
			}),
		)
	})

	it("preserves gitDetails but sets gitCredential undefined when resolveGitCredential throws", async () => {
		mockResolveGitToken.mockRejectedValue(new Error("prompt rejected"))
		manager = new AgentManager()

		await manager.spawnAndWait(fakePi(), fakeRemoteCtx(), "Explore", "test", {
			description: "test",
			remote: true,
		})

		// gitDetails is preserved — the clone plan is not lost
		expect(mockRunRemoteAgent).toHaveBeenCalledWith(
			expect.anything(),
			expect.any(String),
			expect.objectContaining({
				gitDetails: expect.objectContaining({ repo: "https://gitlab.com/team/repo.git" }),
				gitCredential: undefined,
			}),
		)
	})
})
