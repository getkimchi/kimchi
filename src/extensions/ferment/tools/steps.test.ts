import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../../ferment/event-store.js"
import type { JudgeGrade } from "../../../ferment/types.js"
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

const gradeA: JudgeGrade = { grade: "A", rationale: "solid", gradedAt: "2026-01-01T00:00:00.000Z" }

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

function createHarness(options: { verification?: string } = {}) {
	const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-steps-test-")))
	const runtime: FermentRuntime = { ...createDefaultFermentRuntime(), getStorage: () => storage }
	const applyAndPersist = createApplyAndPersist(runtime)
	const pi = {
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
		appendEntry: vi.fn(),
		getActiveTools: vi.fn(() => ["read", "bash", "start_step", "complete_step"]),
		getAllTools: vi.fn(() => [{ name: "read" }, { name: "bash" }, { name: "start_step" }, { name: "complete_step" }]),
		setActiveTools: vi.fn(),
	} as unknown as ExtensionAPI
	const ferment = storage.create("Step Test")
	const scope = applyAndPersist(ferment.id, {
		type: "scope",
		goal: "Goal",
		successCriteria: "Works",
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
		judgeGradeStep: vi.fn(async () => gradeA),
		judgeStepVerification: vi.fn(async () => ({ verdict: "fail" as const, reason: "broken" })),
		onStepCompleted: vi.fn(),
		buildWorkerContext: vi.fn(() => "worker context"),
		runVerification: vi.fn(async (): Promise<VerificationResult> => ({ exitCode: 0, stdout: "ok", stderr: "" })),
		...overrides,
	}
}

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

		expect(okText(result)).toContain("First step")
		expect(h.storage.get(h.fermentId)?.phases[0].steps[0].status).toBe("running")
		expect(h.runtime.getStepStartRef(h.fermentId, "phase-1", "step-1")).toBe("abc123")
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
			{ pi: pauseHarness.pi, ctx: { ui: { select: vi.fn(async () => "Pause the ferment for now") } } },
			createServices(),
		)
		expect(okText(pauseResult)).toContain("paused")
		expect(pauseHarness.storage.get(pauseHarness.fermentId)?.status).toBe("paused")
		expect(pauseHarness.pi.setActiveTools).toHaveBeenLastCalledWith(["read", "bash"])

		const skipHarness = createHarness()
		const skipServices = createServices()
		skipHarness.runtime.bumpStepStart(skipHarness.fermentId, "phase-1", "step-1")
		skipHarness.runtime.bumpStepStart(skipHarness.fermentId, "phase-1", "step-1")
		const skipResult = await startStep(
			skipHarness.runtime,
			{ ferment_id: skipHarness.fermentId, phase_id: "phase-1", step_id: "step-1" },
			{ pi: skipHarness.pi, ctx: { ui: { select: vi.fn(async () => "Skip this step and move on") } } },
			skipServices,
		)
		expect(okText(skipResult)).toContain("skipped")
		expect(skipHarness.storage.get(skipHarness.fermentId)?.phases[0].steps[0].status).toBe("skipped")
		expect(skipServices.onStepCompleted).toHaveBeenCalled()
	})
})

describe("registerStepTools", () => {
	it("registers start_step against the injected runtime storage", async () => {
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

		const startTool = tools.get("start_step")
		if (!startTool) throw new Error("start_step was not registered")
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
	it("completes and grades a step without verification", async () => {
		const h = createHarness()
		const services = createServices()
		const start = h.applyAndPersist(h.fermentId, { type: "start_step", phaseId: "phase-1", stepId: "step-1" })
		if (!start.ok) throw new Error(start.error.message)

		const result = await completeStep(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", step_id: "step-1", summary: "done" },
			{ pi: h.pi },
			services,
		)

		expect(okText(result)).toContain("Grade: A")
		expect(h.storage.get(h.fermentId)?.phases[0].steps[0].status).toBe("done")
		expect(h.storage.get(h.fermentId)?.phases[0].steps[0].grade?.grade).toBe("A")
		expect(services.onStepCompleted).toHaveBeenCalled()
	})

	it("records verification success and grades the step", async () => {
		const h = createHarness({ verification: "pnpm test" })
		h.runtime.nowIso = () => "2026-05-11T12:34:56.000Z"
		const services = createServices({
			runVerification: vi.fn(async () => ({ exitCode: 0, stdout: "pass", stderr: "" })),
		})
		const start = h.applyAndPersist(h.fermentId, { type: "start_step", phaseId: "phase-1", stepId: "step-1" })
		if (!start.ok) throw new Error(start.error.message)

		const result = await completeStep(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", step_id: "step-1", summary: "done" },
			{ pi: h.pi },
			services,
		)

		expect(okText(result)).toContain("verified")
		expect(h.storage.get(h.fermentId)?.phases[0].steps[0].status).toBe("verified")
		expect(h.storage.get(h.fermentId)?.phases[0].steps[0].result?.completedAt).toBe("2026-05-11T12:34:56.000Z")
		expect(services.judgeGradeStep).toHaveBeenCalledWith(
			"First step",
			"done",
			expect.objectContaining({ exitCode: 0 }),
			undefined,
		)
	})

	it("grades success when judge accepts a non-zero verification", async () => {
		const h = createHarness({ verification: "grep expected" })
		const services = createServices({
			runVerification: vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "no match" })),
			judgeStepVerification: vi.fn(async () => ({ verdict: "pass" as const, reason: "acceptable" })),
		})
		const start = h.applyAndPersist(h.fermentId, { type: "start_step", phaseId: "phase-1", stepId: "step-1" })
		if (!start.ok) throw new Error(start.error.message)

		const result = await completeStep(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", step_id: "step-1", summary: "done" },
			{ pi: h.pi },
			services,
		)

		expect(okText(result)).toContain("Judge: acceptable")
		expect(h.storage.get(h.fermentId)?.phases[0].steps[0].status).toBe("done")
		expect(h.storage.get(h.fermentId)?.phases[0].steps[0].grade?.grade).toBe("A")
	})

	it("fails the step when judge asks for retry or fail", async () => {
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
				{ ferment_id: h.fermentId, phase_id: "phase-1", step_id: "step-1", summary: "done" },
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
			{ ferment_id: h.fermentId, phase_id: "phase-1", step_id: "step-1", summary: "done" },
			{ pi: h.pi, ctx: {} },
			services,
		)

		expect(okText(result)).toContain("verified")
		expect(services.judgeStepVerification).not.toHaveBeenCalled()
	})
})
