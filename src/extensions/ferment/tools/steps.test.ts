import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../../ferment/event-store.js"
import { type FermentRuntime, createDefaultFermentRuntime } from "../runtime.js"
import { clearAllStepStarts } from "../state.js"
import { createApplyAndPersist } from "../tool-helpers.js"
import {
	type StepHandlerServices,
	type VerificationResult,
	completeStep,
	defaultStepHandlerServices,
	registerStepTools,
	startStep,
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

function createHarness(options: { verification?: string; goal?: string; successCriteria?: string } = {}) {
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
		successCriteria: options.successCriteria ?? "Works",
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

beforeEach(() => {
	clearAllStepStarts()
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

	it("includes fixed output paths from scoping in the worker prompt handoff", async () => {
		const h = createHarness({
			goal: "Write /app/jump_analyzer.py and store the TOML output in /app/output.toml",
			successCriteria: "Running on /app/example_video.mp4 produces /app/output.toml",
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
			{ ferment_id: h.fermentId, phase_id: "phase-1", step_id: "step-1", summary: "done", gates: flaggedGates },
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
			{ ferment_id: h.fermentId, phase_id: "phase-1", step_id: "step-1", summary: "done", gates: incomplete },
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
				summary: "done",
				gates: passingStepGates(),
			},
			{ pi: h.pi, ctx: {} },
			services,
		)

		expect(okText(result)).toContain("verified")
		expect(services.judgeStepVerification).not.toHaveBeenCalled()
	})
})
