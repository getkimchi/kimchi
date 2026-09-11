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

const { loadWorkspaceFileMock } = vi.hoisted(() => ({ loadWorkspaceFileMock: vi.fn() }))

// resources.js stays real (pure validator); the loader is stubbed, but the
// real WorkspaceFileError class stays (importOriginal) so behavior matches reality.
vi.mock("../../../sandbox/cloud/workspace-file.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../sandbox/cloud/workspace-file.js")>()),
	loadWorkspaceFile: loadWorkspaceFileMock,
}))

vi.mock("../../teleport/provisioning/clone-plan.js", () => ({
	resolveClonePlan: vi.fn(),
}))

vi.mock("../../teleport/provisioning/paths.js", () => ({
	repoBasename: vi.fn().mockReturnValue("repo"),
}))

vi.mock("./remote-agent-runner.js", () => ({
	runRemoteAgent: vi.fn(),
	attachRemoteAgent: vi.fn(),
	isRemoteSessionConnected: vi.fn(),
}))

vi.mock("../../teleport/ui/git-token-prompt.js", () => ({
	GitTokenPromptComponent: vi.fn(),
}))

vi.mock("../../teleport/provisioning/git-token.js", () => ({
	resolveGitToken: vi.fn(),
}))

import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { loadWorkspaceFile, WorkspaceFileError } from "../../../sandbox/cloud/workspace-file.js"
import { listWorkspaces } from "../../../sandbox/cloud/workspaces.js"
import { resolveClonePlan } from "../../teleport/provisioning/clone-plan.js"
import { resolveGitToken } from "../../teleport/provisioning/git-token.js"
import type { AgentRecord } from "../personas/types.js"
import type { RemoteRunState } from "../remote-run-persistence.js"
import { AgentManager, buildAgentOutcome } from "./agent-manager.js"
import { resumeAgent, runAgent } from "./agent-runner.js"
import { attachRemoteAgent, isRemoteSessionConnected, runRemoteAgent } from "./remote-agent-runner.js"

const mockRunAgent = vi.mocked(runAgent)
const mockResumeAgent = vi.mocked(resumeAgent)
const mockResolveClonePlan = vi.mocked(resolveClonePlan)
const mockResolveGitToken = vi.mocked(resolveGitToken)
const mockRunRemoteAgent = vi.mocked(runRemoteAgent)
const mockAttachRemoteAgent = vi.mocked(attachRemoteAgent)
const mockIsRemoteSessionConnected = vi.mocked(isRemoteSessionConnected)
const mockListWorkspaces = vi.mocked(listWorkspaces)
const mockLoadWorkspaceFile = vi.mocked(loadWorkspaceFile)

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
		mockListWorkspaces.mockResolvedValue([])
		mockLoadWorkspaceFile.mockReturnValue(undefined)
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

	it("forwards kimchi_workspace.yaml resources to runRemoteAgent when minting a workspace", async () => {
		mockLoadWorkspaceFile.mockReturnValue({ resources: { cpu: " 500m ", pvcSize: "20Gi" } })
		manager = new AgentManager()

		await manager.spawnAndWait(fakePi(), fakeRemoteCtx(), "Explore", "test", {
			description: "test",
			remote: true,
		})

		// No name-matched workspace (listWorkspaces → []) → mint → resources ride.
		// Outer whitespace trimmed by the real validator.
		expect(mockRunRemoteAgent).toHaveBeenCalledWith(
			expect.anything(),
			expect.any(String),
			expect.objectContaining({ resources: { cpu: "500m", pvcSize: "20Gi" } }),
		)
	})

	it("broken kimchi_workspace.yaml surfaces as an agent error and never starts a remote run", async () => {
		mockLoadWorkspaceFile.mockImplementation(() => {
			throw new WorkspaceFileError(
				"Could not parse /work/myrepo/kimchi_workspace.yaml: bad indentation",
				"/work/myrepo/kimchi_workspace.yaml",
			)
		})
		manager = new AgentManager()

		const record = await manager.spawnAndWait(fakePi(), fakeRemoteCtx(), "Explore", "test", {
			description: "test",
			remote: true,
		})

		expect(record.status).toBe("error")
		expect(record.error).toContain("Could not parse /work/myrepo/kimchi_workspace.yaml")
		expect(mockRunRemoteAgent).not.toHaveBeenCalled()
	})

	it("does not forward resources when a name-matched workspace is reused", async () => {
		mockLoadWorkspaceFile.mockReturnValue({ resources: { cpu: "500m" } })
		mockListWorkspaces.mockResolvedValue([
			{ id: "ws-existing", name: "myrepo", createdAt: new Date(), lastActivityAt: new Date(), status: "active" },
		])
		manager = new AgentManager()

		const record = await manager.spawnAndWait(fakePi(), fakeRemoteCtx(), "Explore", "test", {
			description: "test",
			remote: true,
		})

		expect(record.status).toBe("completed")
		expect(mockLoadWorkspaceFile).not.toHaveBeenCalled()
		expect(mockRunRemoteAgent.mock.calls[0][2]).not.toHaveProperty("resources")
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

describe("AgentManager remote stopReason mapping", () => {
	let manager: AgentManager | undefined

	afterEach(() => {
		manager?.dispose()
		manager = undefined
		vi.clearAllMocks()
	})

	function fakeRemoteCtx(): ExtensionContext {
		return {
			cwd: "/work/myrepo",
			mode: "tui",
			ui: { custom: vi.fn() },
		} as unknown as ExtensionContext
	}

	const remoteSession = {
		workspaceId: "ws-1",
		sessionName: "acp-test",
		wsUrl: "wss://worker.example.com",
		host: "worker.example.com",
		cwd: "/home/sandbox/acp-test",
	}

	beforeEach(() => {
		// Skip git clone planning — not relevant to stopReason mapping.
		mockResolveClonePlan.mockRejectedValue(new Error("not a git repo"))
	})

	it("marks a failed recovery as an error — no completion dropdown on an unknown result", async () => {
		// Regression: the run finished during a disconnect and the replay could
		// not recover the result. Previously "recovery_failed" read as
		// "completed", showing the Review/Sync dropdown on an unknown result.
		mockRunRemoteAgent.mockResolvedValue({
			responseText: "(remote agent completed during disconnect; the result could not be recovered — …)",
			stopReason: "recovery_failed",
			remoteSession,
			recoveryNote: "Recovery failed: the replayed session contained no final assistant message.",
		})
		manager = new AgentManager()

		const record = await manager.spawnAndWait(fakePi(), fakeRemoteCtx(), "Explore", "test", {
			description: "test",
			remote: true,
		})

		expect(record.status).toBe("error")
		expect(record.error).toContain("could not be recovered")
		// The recovery note is preserved for the failure UX / steer message.
		expect(record.recoveryNote).toContain("Recovery failed")
	})

	it("marks non-whitelisted stop reasons as errors, not completions", async () => {
		// ACP can resolve a prompt with "refusal", "max_tokens",
		// "max_turn_requests", or a custom "error" — none of these mean the
		// plan was executed. Previously anything but "cancelled" read as
		// "completed" and triggered the completion dropdown.
		for (const stopReason of ["refusal", "max_tokens", "max_turn_requests", "error"]) {
			mockRunRemoteAgent.mockResolvedValue({
				responseText: "irrelevant",
				stopReason,
				remoteSession,
			})
			manager?.dispose()
			manager = new AgentManager()

			const record = await manager.spawnAndWait(fakePi(), fakeRemoteCtx(), "Explore", "test", {
				description: "test",
				remote: true,
			})

			expect(record.status, `stopReason ${stopReason}`).toBe("error")
			expect(record.error, `stopReason ${stopReason}`).toContain(stopReason)
		}
	})

	it("still treats end_turn and recovered as completed (reconnect flow unaffected)", async () => {
		for (const stopReason of ["end_turn", "recovered"]) {
			mockRunRemoteAgent.mockResolvedValue({
				responseText: "the result",
				stopReason,
				remoteSession,
			})
			manager?.dispose()
			manager = new AgentManager()

			const record = await manager.spawnAndWait(fakePi(), fakeRemoteCtx(), "Explore", "test", {
				description: "test",
				remote: true,
			})

			expect(record.status, `stopReason ${stopReason}`).toBe("completed")
			expect(record.result).toBe("the result")
		}
	})

	it("maps a cancelled remote turn to aborted", async () => {
		mockRunRemoteAgent.mockResolvedValue({
			responseText: "",
			stopReason: "cancelled",
			remoteSession,
		})
		manager = new AgentManager()

		const record = await manager.spawnAndWait(fakePi(), fakeRemoteCtx(), "Explore", "test", {
			description: "test",
			remote: true,
		})

		expect(record.status).toBe("aborted")
	})
})

describe("AgentManager reconnecting lifecycle", () => {
	let manager: AgentManager | undefined

	afterEach(() => {
		manager?.dispose()
		manager = undefined
		vi.clearAllMocks()
	})

	function fakeRemoteCtx(): ExtensionContext {
		return {
			cwd: "/work/myrepo",
			mode: "tui",
			ui: { custom: vi.fn() },
		} as unknown as ExtensionContext
	}

	const remoteResult = {
		responseText: "done",
		stopReason: "end_turn",
		remoteSession: {
			workspaceId: "ws-1",
			sessionName: "acp-test",
			wsUrl: "wss://worker.example.com",
			host: "worker.example.com",
			cwd: "/home/sandbox/acp-test",
		},
	} satisfies Awaited<ReturnType<typeof runRemoteAgent>>

	/** Spawn a remote agent whose runner is parked until resolveRun fires; options captured for reconnecting signals. */
	async function spawnParkedRemote() {
		type RemoteOpts = Parameters<typeof runRemoteAgent>[2]
		let opts: RemoteOpts | undefined
		let resolveRun: (v: Awaited<ReturnType<typeof runRemoteAgent>>) => void = () => {}
		mockResolveClonePlan.mockRejectedValue(new Error("no repo"))
		mockRunRemoteAgent.mockImplementation(
			(_workspaceId, _prompt, options) =>
				new Promise((resolve) => {
					opts = options
					resolveRun = resolve
				}),
		)
		manager = new AgentManager()
		const done = manager.spawnAndWait(fakePi(), fakeRemoteCtx(), "Explore", "test", {
			description: "test",
			remote: true,
		})
		await vi.waitFor(() => expect(manager?.listAgents().length).toBe(1))
		await vi.waitFor(() => expect(opts).toBeDefined())
		return { opts: opts as RemoteOpts, resolveRun, done }
	}

	it("keeps a reconnecting agent counted and unpurged until the reattach resolves", async () => {
		const { opts, resolveRun, done } = await spawnParkedRemote()
		const record = manager?.listAgents()[0]
		expect(record?.status).toBe("running")

		opts.onReconnecting?.(true)
		expect(record?.status).toBe("reconnecting")

		// Status line: reconnecting agents are still live work, not "0 agents".
		expect(manager?.getRunningCount()).toBe(1)
		expect(manager?.hasRunning()).toBe(true)

		// Regression: the 60s cleanup sweep deleted reconnecting records (and
		// disposed their session) mid-reattach, making the agent vanish from the
		// widget while the runner kept polling silently.
		;(manager as unknown as { cleanup(): void }).cleanup()
		expect(manager?.listAgents()).toContain(record)
		manager?.clearCompleted()
		expect(manager?.listAgents()).toContain(record)

		opts.onReconnecting?.(false)
		resolveRun(remoteResult)
		expect((await done).status).toBe("completed")
	})

	it("abortAll stops reconnecting agents", async () => {
		const { resolveRun, done } = await spawnParkedRemote()
		const record = manager?.listAgents()[0]
		if (!record?.abortController) throw new Error("record not spawned with abortController")
		const abortSpy = vi.spyOn(record.abortController, "abort")

		record.status = "reconnecting"
		const aborted = manager?.abortAll()

		expect(aborted).toBe(1)
		expect(record?.status).toBe("stopped")
		expect(abortSpy).toHaveBeenCalled()

		// Let the parked runner settle so dispose doesn't see a mid-flight record.
		resolveRun(remoteResult)
		await done.catch(() => {})
	})

	it("abort (single-record path, used by Ctrl+X) stops a reconnecting agent", async () => {
		const { opts, resolveRun, done } = await spawnParkedRemote()
		const record = manager?.listAgents()[0]
		if (!record) throw new Error("record not spawned")

		opts.onReconnecting?.(true)
		expect(record.status).toBe("reconnecting")

		// Previously abort() only accepted "running" — a reconnecting cloud
		// agent (transport reattach in flight) could never be stopped by the
		// user via the single-record kill path.
		expect(manager?.abort(record.id)).toBe(true)
		expect(record.status).toBe("stopped")

		resolveRun(remoteResult)
		await done.catch(() => {})
	})

	it("a late onReconnecting callback never resurrects a stopped record", async () => {
		const { opts, resolveRun, done } = await spawnParkedRemote()
		const record = manager?.listAgents()[0]

		opts.onReconnecting?.(true)
		expect(record?.status).toBe("reconnecting")

		// User aborts while the runner is mid-recovery, and the runner's
		// reattach callback fires afterwards — it must not flip the record
		// back to "running".
		manager?.abortAll()
		expect(record?.status).toBe("stopped")

		opts.onReconnecting?.(false)
		expect(record?.status).toBe("stopped")

		resolveRun(remoteResult)
		await done.catch(() => {})
	})

	it("buildAgentOutcome does not classify a reconnecting record as an error", () => {
		const outcome = buildAgentOutcome({
			status: "reconnecting",
			startedAt: Date.now(),
		} as unknown as AgentRecord)
		// Reconnecting is live, recoverable work — not a failure.
		expect(outcome.reason).not.toBe("error")
		expect(outcome.reason).toBeUndefined()
	})
})

describe("AgentManager resumeRemoteRecord", () => {
	let manager: AgentManager | undefined

	beforeEach(() => {
		// Default: no other owner — the resume proceeds to the attach.
		mockIsRemoteSessionConnected.mockResolvedValue(false)
	})

	afterEach(() => {
		manager?.dispose()
		manager = undefined
		vi.clearAllMocks()
	})

	function fakeResumeCtx(): ExtensionContext {
		return {
			cwd: "/work/myrepo",
			mode: "tui",
			ui: { custom: vi.fn() },
		} as unknown as ExtensionContext
	}

	const state: RemoteRunState = {
		id: "resumed-1",
		description: "cloud: test plan",
		remoteSession: {
			workspaceId: "ws-1",
			sessionName: "acp-resume01",
			wsUrl: "wss://worker.example.com",
			host: "worker.example.com",
			cwd: "/home/sandbox/acp-resume01",
		},
		acpSessionId: "remote-acp-1",
		remoteOrigin: "plan",
		startedAt: 1_000,
		status: "running",
	}

	it("completes a resumed remote run through the normal completion path", async () => {
		mockAttachRemoteAgent.mockResolvedValue({
			responseText: "recovered result",
			stopReason: "recovered",
			usage: undefined,
			remoteSession: state.remoteSession,
			recoveryNote: "recovery note",
		})
		manager = new AgentManager()

		await manager.resumeRemoteRecord(state, fakeResumeCtx())
		await manager.getRecord(state.id)?.promise

		const record = manager.getRecord(state.id)
		expect(record?.status).toBe("completed")
		// The cloud display name ("Cloud Agent") comes from the type — a resumed
		// remote run must match a fresh one.
		expect(record?.type).toBe("Remote-Runner")
		expect(record?.result).toBe("recovered result")
		expect(record?.recoveryNote).toBe("recovery note")
		// The record is terminal — the manager is idle again.
		expect(manager.getRunningCount()).toBe(0)
		// The attach used the persisted handles (session/load attaches by id).
		expect(mockAttachRemoteAgent).toHaveBeenCalledWith(expect.objectContaining({ acpSessionId: "remote-acp-1" }))
	})

	it("marks a resolved recovery_failed resume as an error — no completion on an unknown result", async () => {
		// Regression: the engine RESOLVES recovery_failed when the replay held
		// no final message; the resume wiring must route it to an error record
		// (same contract as _runRemote's stopReason whitelist), not completed.
		mockAttachRemoteAgent.mockResolvedValue({
			responseText: "(the remote run finished while kimchi was closed; ...)",
			stopReason: "recovery_failed",
			usage: undefined,
			remoteSession: state.remoteSession,
			recoveryNote: "Recovery failed: no final assistant message.",
		})
		manager = new AgentManager()

		await manager.resumeRemoteRecord(state, fakeResumeCtx())
		await manager.getRecord(state.id)?.promise

		const record = manager.getRecord(state.id)
		expect(record?.status).toBe("error")
		expect(record?.error).toContain("could not be recovered")
		expect(record?.recoveryNote).toContain("Recovery failed")
	})

	it("marks a thrown attach failure (reaped session) as an error", async () => {
		mockAttachRemoteAgent.mockRejectedValue(new Error("remote session no longer exists — result unknown"))
		manager = new AgentManager()

		await manager.resumeRemoteRecord(state, fakeResumeCtx())
		await manager.getRecord(state.id)?.promise

		const record = manager.getRecord(state.id)
		expect(record?.status).toBe("error")
		expect(record?.error).toContain("no longer exists")
	})

	it("spares remote records in abortAll({skipRemote: true}) but stops them on a plain abortAll", async () => {
		// The attach never settles — the resumed run stays "running".
		mockAttachRemoteAgent.mockReturnValue(new Promise(() => {}))
		manager = new AgentManager()
		await manager.resumeRemoteRecord(state, fakeResumeCtx())
		const record = manager.getRecord(state.id)
		expect(record?.status).toBe("running")

		// Process shutdown: the remote run keeps going on the worker.
		expect(manager.abortAll({ skipRemote: true })).toBe(0)
		expect(record?.status).toBe("running")

		// An explicit kill still stops it.
		expect(manager.abortAll()).toBe(1)
		expect(record?.status).toBe("stopped")
	})

	it("skips the attach when another kimchi session already holds the remote session", async () => {
		mockIsRemoteSessionConnected.mockResolvedValue(true)
		manager = new AgentManager()

		const outcome = await manager.resumeRemoteRecord(state, fakeResumeCtx())

		expect(outcome).toBe("already-watched")
		// No attach, no record, no background slot consumed.
		expect(mockAttachRemoteAgent).not.toHaveBeenCalled()
		expect(manager.getRecord(state.id)).toBeUndefined()
		expect(manager.getRunningCount()).toBe(0)
	})
})
