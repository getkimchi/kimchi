import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../../ferment/event-store.js"
import { type FermentRuntime, createDefaultFermentRuntime } from "../runtime.js"
import { clearAllStepStarts, clearPendingCompaction, getPendingCompaction } from "../state.js"
import { createApplyAndPersist } from "../tool-helpers.js"

const mockAgentRecords = vi.hoisted(() => new Map<string, unknown>())
vi.mock("../../agents/index.js", () => ({
	getAgentRecordForTaskValidation: vi.fn((id: string) => mockAgentRecords.get(id)),
}))

import {
	type StepHandlerServices,
	type VerificationResult,
	completeStep,
	defaultStepHandlerServices,
	registerStepTools,
	startStep,
	suggestWorkerLimits,
} from "./steps.js"

interface RegisteredTool {
	name: string
	execute: (toolCallId: string, params: Record<string, unknown>) => Promise<unknown>
}

function okText(result: { content: { text: string }[]; isError?: boolean }): string {
	if (result.isError) throw new Error(`Expected ok, got error: ${result.content[0]?.text}`)
	return result.content.map((c) => c.text).join("\n")
}

function errText(result: { content: { text: string }[]; isError?: boolean }): string {
	if (!result.isError) throw new Error(`Expected error, got ok: ${result.content[0]?.text}`)
	return result.content.map((c) => c.text).join("\n")
}

function createHarness(options: { verification?: string; goal?: string; successCriteria?: string[] } = {}) {
	const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-steps-test-")))
	const runtime: FermentRuntime = { ...createDefaultFermentRuntime(), getStorage: () => storage }
	const applyAndPersist = createApplyAndPersist(runtime)
	const pi = {
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
		appendEntry: vi.fn(),
		getActiveTools: vi.fn(() => ["read", "bash", "start_ferment_step", "complete_ferment_step"]),
		getAllTools: vi.fn(() => [
			{ name: "read" },
			{ name: "bash" },
			{ name: "start_ferment_step" },
			{ name: "complete_ferment_step" },
		]),
		setActiveTools: vi.fn(),
	} as unknown as ExtensionAPI
	const ferment = storage.create("Step Test")
	const scope = applyAndPersist(ferment.id, {
		type: "scope",
		goal: options.goal ?? "Goal",
		successCriteria: options.successCriteria ?? ["Works"],
		constraints: [],
		phases: [
			{
				name: "Phase",
				goal: "Build",
				steps: [
					{
						description: "First step",
						verify: options.verification,
					},
					{ description: "Second step" },
				],
			},
		],
	})
	if (!scope.ok) throw new Error(scope.error.message)
	const active = applyAndPersist(ferment.id, { type: "activate_phase", phaseId: "phase-1" })
	if (!active.ok) throw new Error(active.error.message)
	return { storage, runtime, applyAndPersist, pi, fermentId: ferment.id }
}

function createServices(overrides: Partial<StepHandlerServices> = {}): StepHandlerServices {
	return {
		captureGitHead: vi.fn(() => undefined),
		gatherEvidence: vi.fn(() => undefined),
		judgeStepVerification: vi.fn(async () => ({ verdict: "fail" as const, reason: "broken" })),
		onStepCompleted: vi.fn(),
		buildWorkerContext: vi.fn(() => "worker context"),
		runVerification: vi.fn(async (): Promise<VerificationResult> => ({ exitCode: 0, stdout: "ok", stderr: "" })),
		...overrides,
	}
}

/** Helper: a complete, all-pass step-scope gate verdict set. */
const passingStepGates = () => [
	{ id: "S1", verdict: "pass" as const, rationale: "Summary cites edited file.", evidence: "first.ts:1-10" },
	{ id: "S2", verdict: "pass" as const, rationale: "Verify command runs the artifact.", evidence: "pnpm test" },
	{ id: "S3", verdict: "pass" as const, rationale: "Empty input handled.", evidence: "throws TypeError; covered" },
]

function linkedWorker(fermentId: string, phaseId = "phase-1", stepId = "step-1"): string {
	const id = `agent-${mockAgentRecords.size + 1}`
	mockAgentRecords.set(id, {
		id,
		visibility: "user",
		taskRef: { kind: "ferment_step", ferment_id: fermentId, phase_id: phaseId, step_id: stepId },
		latestOutcome: {
			agent_id: id,
			status: "completed",
			outcome: "completed",
			resumable: false,
			token_usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			duration_ms: 1,
			report: {
				status: "completed",
				summary: "done",
				steps_completed: ["done"],
				remaining_steps: [],
				submitted_at: 1,
			},
			resume_attempts: 0,
		},
	})
	return id
}

beforeEach(() => {
	clearAllStepStarts()
	mockAgentRecords.clear()
	vi.restoreAllMocks()
})

describe("startStep", () => {
	it("starts a step and captures its start ref", async () => {
		const h = createHarness()
		const services = createServices({ captureGitHead: vi.fn(() => "abc123") })

		const result = await startStep(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", step_id: "step-1" },
			{ pi: h.pi },
			services,
		)

		const text = okText(result)
		expect(text).toContain("First step")
		expect(text).not.toContain("worker_model:")
		expect(text).not.toMatch(/model "kimchi-dev/)
		expect(h.storage.get(h.fermentId)?.phases[0].steps[0].status).toBe("running")
		expect(h.runtime.getStepStartRef(h.fermentId, "phase-1", "step-1")).toBe("abc123")
	})

	it("defaults normal implementation work to the standard worker budget tier", async () => {
		const h = createHarness()
		const result = await startStep(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", step_id: "step-1" },
			{ pi: h.pi },
			createServices(),
		)

		const text = okText(result)
		expect(text).toContain('task_ref: {"kind":"ferment_step"')
		expect(text).toContain('"budget_tier":"standard"')
		expect(text).toContain("budget_tier=standard")
		expect(text).toContain("max_turns=25")
		expect(text).toContain("max_duration=300s")
		expect(text).toContain("token_budget=100000")
		expect(text).toContain("submit_agent_report")
		expect(text).toContain("Do not complete the step from an exhausted worker")
		expect(text).not.toContain("call complete_ferment_step with whatever it produced")
	})

	it("uses the explicitly selected narrow worker budget tier", async () => {
		const h = createHarness()
		const result = await startStep(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", step_id: "step-1", budget_tier: "narrow" },
			{ pi: h.pi },
			createServices(),
		)

		const text = okText(result)
		expect(text).toContain('"budget_tier":"narrow"')
		expect(text).toContain("budget_tier=narrow")
		expect(text).toContain("max_turns=10")
		expect(text).toContain("max_duration=180s")
		expect(text).toContain("token_budget=50000")
		expect(text).toContain("cumulative_token_budget=100000")
	})

	it("uses the explicitly selected complex worker budget tier", async () => {
		const h = createHarness()
		const result = await startStep(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", step_id: "step-1", budget_tier: "complex" },
			{ pi: h.pi },
			createServices(),
		)

		const text = okText(result)
		expect(text).toContain('"budget_tier":"complex"')
		expect(text).toContain("max_turns=30")
		expect(text).toContain("max_duration=600s")
		expect(text).toContain("token_budget=150000")
		expect(text).toContain("cumulative_token_budget=375000")
	})

	it("includes fixed output paths from scoping in the worker prompt handoff", async () => {
		const h = createHarness({
			goal: "Write /app/jump_analyzer.py and store the TOML output in /app/output.toml",
			successCriteria: ["Running on /app/example_video.mp4 produces /app/output.toml"],
		})
		const services = createServices({ buildWorkerContext: defaultStepHandlerServices.buildWorkerContext })

		const result = await startStep(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", step_id: "step-1" },
			{ pi: h.pi },
			services,
		)

		const text = okText(result)
		expect(text).toContain("Goal:")
		expect(text).toContain("/app/output.toml")
		expect(text).toContain("Worker context (pass to subagent verbatim):")
	})

	it("maps concurrent non-parallel starts to the existing tool error", async () => {
		const h = createHarness()
		const services = createServices()
		await startStep(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", step_id: "step-1" },
			{ pi: h.pi },
			services,
		)

		const result = await startStep(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", step_id: "step-2" },
			{ pi: h.pi },
			services,
		)

		expect(errText(result)).toMatch(/already running/)
	})

	it("returns a headless stuck-loop error instead of mutating again", async () => {
		const h = createHarness()
		const services = createServices()
		h.runtime.bumpStepStart(h.fermentId, "phase-1", "step-1")
		h.runtime.bumpStepStart(h.fermentId, "phase-1", "step-1")

		const result = await startStep(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", step_id: "step-1" },
			{ pi: h.pi },
			services,
		)

		expect(errText(result)).toMatch(/Stuck loop detected/)
		expect(h.storage.get(h.fermentId)?.phases[0].steps[0].status).toBe("pending")
	})

	it("pauses or skips from the stuck-loop UI decision", async () => {
		const pauseHarness = createHarness()
		pauseHarness.runtime.bumpStepStart(pauseHarness.fermentId, "phase-1", "step-1")
		pauseHarness.runtime.bumpStepStart(pauseHarness.fermentId, "phase-1", "step-1")
		const pauseResult = await startStep(
			pauseHarness.runtime,
			{ ferment_id: pauseHarness.fermentId, phase_id: "phase-1", step_id: "step-1" },
			{ pi: pauseHarness.pi, ctx: { ui: { select: vi.fn(async () => "Pause ferment") } } },
			createServices(),
		)
		expect(okText(pauseResult)).toContain("paused")
		expect(pauseHarness.storage.get(pauseHarness.fermentId)?.status).toBe("paused")
		expect(pauseHarness.pi.setActiveTools).not.toHaveBeenCalled()

		const skipHarness = createHarness()
		const skipServices = createServices()
		skipHarness.runtime.bumpStepStart(skipHarness.fermentId, "phase-1", "step-1")
		skipHarness.runtime.bumpStepStart(skipHarness.fermentId, "phase-1", "step-1")
		const skipResult = await startStep(
			skipHarness.runtime,
			{ ferment_id: skipHarness.fermentId, phase_id: "phase-1", step_id: "step-1" },
			{ pi: skipHarness.pi, ctx: { ui: { select: vi.fn(async () => "Skip step") } } },
			skipServices,
		)
		expect(okText(skipResult)).toContain("skipped")
		expect(skipHarness.storage.get(skipHarness.fermentId)?.phases[0].steps[0].status).toBe("skipped")
		expect(skipServices.onStepCompleted).toHaveBeenCalled()
	})
})

describe("registerStepTools", () => {
	it("registers start_ferment_step against the injected runtime storage", async () => {
		const h = createHarness()
		const tools = new Map<string, RegisteredTool>()
		const pi = {
			registerTool: (tool: RegisteredTool) => {
				tools.set(tool.name, tool)
			},
			sendMessage: vi.fn(),
			sendUserMessage: vi.fn(),
			appendEntry: vi.fn(),
		} as unknown as ExtensionAPI
		registerStepTools(pi, h.runtime)

		const startTool = tools.get("start_ferment_step")
		if (!startTool) throw new Error("start_ferment_step was not registered")
		const result = (await startTool.execute("test-call-id", {
			ferment_id: h.fermentId,
			phase_id: "phase-1",
			step_id: "step-1",
		})) as { content: { text: string }[]; isError?: boolean }

		expect(okText(result)).toContain("First step")
		expect(h.storage.get(h.fermentId)?.phases[0].steps[0].status).toBe("running")
	})
})

describe("completeStep", () => {
	it("completes a step without verification when all gates pass", async () => {
		const h = createHarness()
		const services = createServices()
		const start = h.applyAndPersist(h.fermentId, { type: "start_step", phaseId: "phase-1", stepId: "step-1" })
		if (!start.ok) throw new Error(start.error.message)

		const result = await completeStep(
			h.runtime,
			{
				ferment_id: h.fermentId,
				phase_id: "phase-1",
				step_id: "step-1",
				worker_agent_id: linkedWorker(h.fermentId),
				summary: "done",
				gates: passingStepGates(),
			},
			{ pi: h.pi },
			services,
		)

		expect(okText(result)).toContain("done")
		expect(h.storage.get(h.fermentId)?.phases[0].steps[0].status).toBe("done")
		expect(services.onStepCompleted).toHaveBeenCalled()
	})

	it("records verification success silently when all gates pass", async () => {
		const h = createHarness({ verification: "pnpm test" })
		h.runtime.nowIso = () => "2026-05-11T12:34:56.000Z"
		const services = createServices({
			runVerification: vi.fn(async () => ({ exitCode: 0, stdout: "pass", stderr: "" })),
		})
		const start = h.applyAndPersist(h.fermentId, { type: "start_step", phaseId: "phase-1", stepId: "step-1" })
		if (!start.ok) throw new Error(start.error.message)

		const result = await completeStep(
			h.runtime,
			{
				ferment_id: h.fermentId,
				phase_id: "phase-1",
				step_id: "step-1",
				worker_agent_id: linkedWorker(h.fermentId),
				summary: "done",
				gates: passingStepGates(),
			},
			{ pi: h.pi },
			services,
		)

		expect(okText(result)).toContain("verified")
		expect(h.storage.get(h.fermentId)?.phases[0].steps[0].status).toBe("verified")
		expect(h.storage.get(h.fermentId)?.phases[0].steps[0].result?.completedAt).toBe("2026-05-11T12:34:56.000Z")
		// No LLM grading call exists anymore on the verify-success path.
		expect(services.judgeStepVerification).not.toHaveBeenCalled()
	})

	it("refuses step completion when the agent self-flags on a step gate", async () => {
		const h = createHarness()
		const services = createServices()
		const start = h.applyAndPersist(h.fermentId, { type: "start_step", phaseId: "phase-1", stepId: "step-1" })
		if (!start.ok) throw new Error(start.error.message)

		const flaggedGates = [
			{
				id: "S1",
				verdict: "flag" as const,
				rationale: "Summary mentions /app/cancel.py but diff only touches first.ts.",
				evidence: "summary vs diff mismatch",
			},
			{ id: "S2", verdict: "pass" as const, rationale: "ok", evidence: "n/a" },
			{ id: "S3", verdict: "pass" as const, rationale: "ok", evidence: "n/a" },
		]

		const result = await completeStep(
			h.runtime,
			{
				ferment_id: h.fermentId,
				phase_id: "phase-1",
				step_id: "step-1",
				worker_agent_id: linkedWorker(h.fermentId),
				summary: "done",
				gates: flaggedGates,
			},
			{ pi: h.pi },
			services,
		)

		expect(errText(result)).toContain("Gate S1")
		expect(errText(result)).toContain("cancel.py")
		// Step must NOT be marked done.
		expect(h.storage.get(h.fermentId)?.phases[0].steps[0].status).toBe("running")
		// onStepCompleted should NOT fire on a refused completion.
		expect(services.onStepCompleted).not.toHaveBeenCalled()
	})

	it("rejects the call with a clear error when gate coverage is incomplete", async () => {
		const h = createHarness()
		const services = createServices()
		const start = h.applyAndPersist(h.fermentId, { type: "start_step", phaseId: "phase-1", stepId: "step-1" })
		if (!start.ok) throw new Error(start.error.message)

		const incomplete = [{ id: "S1", verdict: "pass" as const, rationale: "ok", evidence: "n/a" }]

		const result = await completeStep(
			h.runtime,
			{
				ferment_id: h.fermentId,
				phase_id: "phase-1",
				step_id: "step-1",
				worker_agent_id: linkedWorker(h.fermentId),
				summary: "done",
				gates: incomplete,
			},
			{ pi: h.pi },
			services,
		)

		expect(errText(result)).toContain("missing required gate verdicts")
		expect(errText(result)).toContain("S2")
		expect(errText(result)).toContain("S3")
		expect(h.storage.get(h.fermentId)?.phases[0].steps[0].status).toBe("running")
	})

	it("treats a tactical judge 'pass' verdict as success on non-zero verify exit", async () => {
		const h = createHarness({ verification: "grep expected" })
		const services = createServices({
			runVerification: vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "no match" })),
			judgeStepVerification: vi.fn(async () => ({ verdict: "pass" as const, reason: "acceptable" })),
		})
		const start = h.applyAndPersist(h.fermentId, { type: "start_step", phaseId: "phase-1", stepId: "step-1" })
		if (!start.ok) throw new Error(start.error.message)

		const result = await completeStep(
			h.runtime,
			{
				ferment_id: h.fermentId,
				phase_id: "phase-1",
				step_id: "step-1",
				worker_agent_id: linkedWorker(h.fermentId),
				summary: "done",
				gates: passingStepGates(),
			},
			{ pi: h.pi },
			services,
		)

		expect(okText(result)).toContain("Judge: acceptable")
		expect(h.storage.get(h.fermentId)?.phases[0].steps[0].status).toBe("done")
	})

	it("fails the step when judge asks for retry or fail on non-zero verify exit", async () => {
		for (const verdict of ["retry", "fail"] as const) {
			const h = createHarness({ verification: "pnpm test" })
			const services = createServices({
				runVerification: vi.fn(async () => ({ exitCode: 2, stdout: "out", stderr: "err" })),
				judgeStepVerification: vi.fn(async () => ({ verdict, reason: "not good" })),
			})
			const start = h.applyAndPersist(h.fermentId, { type: "start_step", phaseId: "phase-1", stepId: "step-1" })
			if (!start.ok) throw new Error(start.error.message)

			const result = await completeStep(
				h.runtime,
				{
					ferment_id: h.fermentId,
					phase_id: "phase-1",
					step_id: "step-1",
					worker_agent_id: linkedWorker(h.fermentId),
					summary: "done",
					gates: passingStepGates(),
				},
				{ pi: h.pi },
				services,
			)

			expect(errText(result)).toMatch(verdict === "retry" ? /retry suggested/ : /failed verification/)
			expect(h.storage.get(h.fermentId)?.phases[0].steps[0].status).toBe("failed")
		}
	})

	it("treats a missing bash runner as a clean verification pass", async () => {
		const h = createHarness({ verification: "pnpm test" })
		const services = createServices({ runVerification: defaultStepHandlerServices.runVerification })
		const start = h.applyAndPersist(h.fermentId, { type: "start_step", phaseId: "phase-1", stepId: "step-1" })
		if (!start.ok) throw new Error(start.error.message)

		const result = await completeStep(
			h.runtime,
			{
				ferment_id: h.fermentId,
				phase_id: "phase-1",
				step_id: "step-1",
				worker_agent_id: linkedWorker(h.fermentId),
				summary: "done",
				gates: passingStepGates(),
			},
			{ pi: h.pi, ctx: {} },
			services,
		)

		expect(okText(result)).toContain("verified")
		expect(services.judgeStepVerification).not.toHaveBeenCalled()
	})

	describe("validateLinkedWorker rejection paths", () => {
		it("rejects when worker_agent_id is omitted", async () => {
			const h = createHarness()
			h.applyAndPersist(h.fermentId, { type: "start_step", phaseId: "phase-1", stepId: "step-1" })

			const result = await completeStep(
				h.runtime,
				{
					ferment_id: h.fermentId,
					phase_id: "phase-1",
					step_id: "step-1",
					summary: "done",
					gates: passingStepGates(),
					// Cast: this test intentionally omits `worker_agent_id` to verify
					// runtime validation rejects the missing field. TS would otherwise
					// flag the call because the field is required by CompleteStepParams.
				} as unknown as Parameters<typeof completeStep>[1],
				{ pi: h.pi },
				createServices(),
			)

			expect(errText(result)).toContain("requires worker_agent_id")
		})

		it("rejects when the agent record is not found", async () => {
			const h = createHarness()
			h.applyAndPersist(h.fermentId, { type: "start_step", phaseId: "phase-1", stepId: "step-1" })

			const result = await completeStep(
				h.runtime,
				{
					ferment_id: h.fermentId,
					phase_id: "phase-1",
					step_id: "step-1",
					worker_agent_id: "agent-nonexistent",
					summary: "done",
					gates: passingStepGates(),
				},
				{ pi: h.pi },
				createServices(),
			)

			expect(errText(result)).toContain("was not found")
		})

		it("rejects when the task ref does not match the ferment step", async () => {
			const h = createHarness()
			h.applyAndPersist(h.fermentId, { type: "start_step", phaseId: "phase-1", stepId: "step-1" })

			mockAgentRecords.set("agent-mismatch", {
				id: "agent-mismatch",
				visibility: "user",
				taskRef: { kind: "ferment_step", ferment_id: "other-ferment", phase_id: "phase-1", step_id: "step-1" },
				latestOutcome: {
					agent_id: "agent-mismatch",
					status: "completed",
					outcome: "completed",
					resumable: false,
					token_usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					duration_ms: 1,
					report: {
						status: "completed",
						summary: "done",
						steps_completed: [],
						remaining_steps: [],
						submitted_at: 1,
					},
					resume_attempts: 0,
				},
			})

			const result = await completeStep(
				h.runtime,
				{
					ferment_id: h.fermentId,
					phase_id: "phase-1",
					step_id: "step-1",
					worker_agent_id: "agent-mismatch",
					summary: "done",
					gates: passingStepGates(),
				},
				{ pi: h.pi },
				createServices(),
			)

			expect(errText(result)).toContain("is not linked to this Ferment step")
		})

		it("rejects when the agent has no recorded outcome", async () => {
			const h = createHarness()
			h.applyAndPersist(h.fermentId, { type: "start_step", phaseId: "phase-1", stepId: "step-1" })

			mockAgentRecords.set("agent-no-outcome", {
				id: "agent-no-outcome",
				visibility: "user",
				taskRef: { kind: "ferment_step", ferment_id: h.fermentId, phase_id: "phase-1", step_id: "step-1" },
			})

			const result = await completeStep(
				h.runtime,
				{
					ferment_id: h.fermentId,
					phase_id: "phase-1",
					step_id: "step-1",
					worker_agent_id: "agent-no-outcome",
					summary: "done",
					gates: passingStepGates(),
				},
				{ pi: h.pi },
				createServices(),
			)

			expect(errText(result)).toContain("has no recorded outcome")
		})

		it("rejects when the agent completed without submit_agent_report", async () => {
			const h = createHarness()
			h.applyAndPersist(h.fermentId, { type: "start_step", phaseId: "phase-1", stepId: "step-1" })

			mockAgentRecords.set("agent-no-report", {
				id: "agent-no-report",
				visibility: "user",
				taskRef: { kind: "ferment_step", ferment_id: h.fermentId, phase_id: "phase-1", step_id: "step-1" },
				latestOutcome: {
					agent_id: "agent-no-report",
					status: "completed",
					outcome: "completed",
					resumable: false,
					token_usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					duration_ms: 1,
					resume_attempts: 0,
				},
			})

			const result = await completeStep(
				h.runtime,
				{
					ferment_id: h.fermentId,
					phase_id: "phase-1",
					step_id: "step-1",
					worker_agent_id: "agent-no-report",
					summary: "done",
					gates: passingStepGates(),
				},
				{ pi: h.pi },
				createServices(),
			)

			expect(errText(result)).toContain("completed without submit_agent_report")
		})

		it("rejects when report status is not completed", async () => {
			const h = createHarness()
			h.applyAndPersist(h.fermentId, { type: "start_step", phaseId: "phase-1", stepId: "step-1" })

			mockAgentRecords.set("agent-partial", {
				id: "agent-partial",
				visibility: "user",
				taskRef: { kind: "ferment_step", ferment_id: h.fermentId, phase_id: "phase-1", step_id: "step-1" },
				latestOutcome: {
					agent_id: "agent-partial",
					status: "completed",
					outcome: "completed",
					resumable: false,
					token_usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					duration_ms: 1,
					report: {
						status: "partial",
						summary: "half done",
						steps_completed: [],
						remaining_steps: ["rest"],
						submitted_at: 1,
					},
					resume_attempts: 0,
				},
			})

			const result = await completeStep(
				h.runtime,
				{
					ferment_id: h.fermentId,
					phase_id: "phase-1",
					step_id: "step-1",
					worker_agent_id: "agent-partial",
					summary: "done",
					gates: passingStepGates(),
				},
				{ pi: h.pi },
				createServices(),
			)

			expect(errText(result)).toContain('report status is "partial"')
		})

		it("rejects when the agent exhausted its budget", async () => {
			const h = createHarness()
			h.applyAndPersist(h.fermentId, { type: "start_step", phaseId: "phase-1", stepId: "step-1" })

			mockAgentRecords.set("agent-exhausted", {
				id: "agent-exhausted",
				visibility: "user",
				taskRef: { kind: "ferment_step", ferment_id: h.fermentId, phase_id: "phase-1", step_id: "step-1" },
				latestOutcome: {
					agent_id: "agent-exhausted",
					status: "completed",
					outcome: "budget_exhausted",
					resumable: true,
					token_usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					duration_ms: 1,
					report: {
						status: "partial",
						summary: "ran out",
						steps_completed: [],
						remaining_steps: ["more"],
						submitted_at: 1,
					},
					resume_attempts: 0,
				},
			})

			const result = await completeStep(
				h.runtime,
				{
					ferment_id: h.fermentId,
					phase_id: "phase-1",
					step_id: "step-1",
					worker_agent_id: "agent-exhausted",
					summary: "done",
					gates: passingStepGates(),
				},
				{ pi: h.pi },
				createServices(),
			)

			expect(errText(result)).toContain("exhausted its budget")
		})
	})

	// ── Auto-compaction dedup regression tests ────────────────────────────
	// The last step of a phase must NOT record a step-level pending compaction:
	// determineNextAction returns complete_phase, so the phase-level compaction
	// (fired by completePhase) handles the boundary. Mid-phase steps still record
	// a step-level pending compaction.
	beforeEach(() => {
		clearPendingCompaction("ferment-steps-test")
	})

	it("records a step-level pending compaction for a mid-phase step", async () => {
		const h = createHarness()
		const services = createServices()
		const start = h.applyAndPersist(h.fermentId, { type: "start_step", phaseId: "phase-1", stepId: "step-1" })
		if (!start.ok) throw new Error(start.error.message)

		const result = await completeStep(
			h.runtime,
			{
				ferment_id: h.fermentId,
				phase_id: "phase-1",
				step_id: "step-1",
				worker_agent_id: linkedWorker(h.fermentId),
				summary: "done",
				gates: passingStepGates(),
			},
			{ pi: h.pi },
			services,
		)

		expect(okText(result)).toContain("done")
		// step-1 is NOT the last step (step-2 remains) → step compaction recorded.
		const pending = getPendingCompaction(h.fermentId)
		expect(pending).toBeDefined()
		expect(pending?.kind).toBe("step")
		expect(pending?.stepId).toBe("step-1")
	})

	it("skips the step-level pending compaction on the last step of a phase", async () => {
		const h = createHarness()
		const services = createServices()
		// Complete step-1 first so step-2 becomes the last pending step.
		const start1 = h.applyAndPersist(h.fermentId, { type: "start_step", phaseId: "phase-1", stepId: "step-1" })
		if (!start1.ok) throw new Error(start1.error.message)
		const complete1 = await completeStep(
			h.runtime,
			{
				ferment_id: h.fermentId,
				phase_id: "phase-1",
				step_id: "step-1",
				worker_agent_id: linkedWorker(h.fermentId),
				summary: "done",
				gates: passingStepGates(),
			},
			{ pi: h.pi },
			services,
		)
		expect(okText(complete1)).toContain("done")
		// Drain the step-1 pending compaction so it doesn't mask the step-2 result.
		clearPendingCompaction(h.fermentId)

		// Now start + complete step-2 (the last step of the phase).
		const start2 = h.applyAndPersist(h.fermentId, { type: "start_step", phaseId: "phase-1", stepId: "step-2" })
		if (!start2.ok) throw new Error(start2.error.message)
		const result = await completeStep(
			h.runtime,
			{
				ferment_id: h.fermentId,
				phase_id: "phase-1",
				step_id: "step-2",
				worker_agent_id: linkedWorker(h.fermentId, "phase-1", "step-2"),
				summary: "done",
				gates: passingStepGates(),
			},
			{ pi: h.pi },
			services,
		)

		expect(okText(result)).toContain("done")
		// step-2 is the last step → determineNextAction returns complete_phase →
		// step-level compaction must be skipped (deferred to the phase compaction).
		expect(getPendingCompaction(h.fermentId)).toBeUndefined()
	})
})

describe("suggestWorkerLimits", () => {
	it("returns the standard Ferment step budget by default", () => {
		const limits = suggestWorkerLimits("Implement the auth middleware")
		expect(limits).toEqual({
			maxTurns: 25,
			maxDuration: 300,
			tokenBudget: 100_000,
			cumulativeTokenBudget: 250_000,
		})
	})

	it("does not inflate budgets from model-authored keywords", () => {
		const limits = suggestWorkerLimits("Compile the MIPS binary and link dependencies")
		expect(limits).toEqual({
			maxTurns: 25,
			maxDuration: 300,
			tokenBudget: 100_000,
			cumulativeTokenBudget: 250_000,
		})
	})

	it("does not inflate budgets from verification commands", () => {
		const limits = suggestWorkerLimits("Run the build", "make -j4 && ./run_tests.sh")
		expect(limits).toEqual({
			maxTurns: 25,
			maxDuration: 300,
			tokenBudget: 100_000,
			cumulativeTokenBudget: 250_000,
		})
	})
})

describe("start_ferment_step plan-first preamble", () => {
	it("contains plan-first preamble with verification and cleanup hints", async () => {
		const h = createHarness()
		const services = createServices()

		const result = await startStep(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", step_id: "step-1" },
			{ pi: h.pi },
			services,
		)

		const text = okText(result)
		expect(text).toContain("Plan first")
		expect(text).toContain("verification sub-task")
		expect(text).toContain("cleanup sub-task")
	})

	it.each([1, 2])("preamble appears on call %i without completion", async (callNumber) => {
		const h = createHarness()
		const services = createServices()

		for (let i = 0; i < callNumber - 1; i++) {
			h.runtime.bumpStepStart(h.fermentId, "phase-1", "step-1")
		}

		const result = await startStep(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", step_id: "step-1" },
			{ pi: h.pi },
			services,
		)

		const text = okText(result)
		expect(text).toContain("Plan first")
		expect(text).toContain("verification sub-task")
	})

	it("instructs orchestrator to embed plan in worker Agent prompt", async () => {
		const h = createHarness()
		const services = createServices()

		const result = await startStep(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", step_id: "step-1" },
			{ pi: h.pi },
			services,
		)

		const text = okText(result)
		expect(text).toContain("Embed")
		expect(text).toContain("plan")
		expect(text).toContain("Agent")
	})

	it("includes prior step summaries in the plan-first preamble", async () => {
		const h = createHarness()
		const services = createServices()

		// Start and complete step 1 with a summary
		await startStep(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", step_id: "step-1" },
			{ pi: h.pi },
			services,
		)
		const completeResult = await completeStep(
			h.runtime,
			{
				ferment_id: h.fermentId,
				phase_id: "phase-1",
				step_id: "step-1",
				worker_agent_id: linkedWorker(h.fermentId),
				summary: "Installed dependencies and verified config",
				gates: passingStepGates(),
			},
			{ pi: h.pi },
			services,
		)
		// Verify step-1 completed successfully
		expect((completeResult as { isError?: boolean }).isError).toBeFalsy()
		expect(h.storage.get(h.fermentId)?.phases[0].steps[0]?.status).toBe("done")

		// Now start step 2 — should include prior step context
		const result = await startStep(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", step_id: "step-2" },
			{ pi: h.pi },
			services,
		)

		const text = okText(result)
		expect(text).toContain("Prior steps")
		expect(text).toContain("First step")
	})

	it("stuck-loop guard triggers on 3rd consecutive start \u2014 no plan-first preamble", async () => {
		const h = createHarness()
		const services = createServices()

		h.runtime.bumpStepStart(h.fermentId, "phase-1", "step-1")
		h.runtime.bumpStepStart(h.fermentId, "phase-1", "step-1")

		const result = await startStep(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", step_id: "step-1" },
			{ pi: h.pi },
			services,
		)

		const text = errText(result)
		expect(text).toContain("Stuck loop detected")
		expect(text).not.toContain("Plan first")
		expect(text).not.toContain("verification sub-task")
		expect(h.storage.get(h.fermentId)?.phases[0].steps[0].status).toBe("pending")
	})
})
