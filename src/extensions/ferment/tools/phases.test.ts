import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../../ferment/event-store.js"
import type { JudgeGrade } from "../../../ferment/types.js"
import { type FermentRuntime, createDefaultFermentRuntime } from "../runtime.js"
import { setActive } from "../state.js"
import { createApplyAndPersist } from "../tool-helpers.js"
import { type PhaseHandlerServices, completePhase, registerPhaseTools } from "./phases.js"

vi.mock("../judge.js", () => ({
	judgeGradePhase: vi.fn(async () => gradeA),
	judgeSuggestCorrectiveStep: vi.fn(async () => undefined),
}))

const gradeA: JudgeGrade = { grade: "A", rationale: "solid", gradedAt: "2026-01-01T00:00:00.000Z" }

function okText(result: { content: { text: string }[]; isError?: boolean }): string {
	if (result.isError) throw new Error(`Expected ok, got error: ${result.content[0]?.text}`)
	return result.content.map((c) => c.text).join("\n")
}

function createHarness(options: { phases?: number } = {}) {
	const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-phases-test-")))
	const runtime: FermentRuntime = { ...createDefaultFermentRuntime(), getStorage: () => storage }
	const applyAndPersist = createApplyAndPersist(runtime)
	const pi = {
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
		appendEntry: vi.fn(),
		getActiveTools: vi.fn(() => ["read", "bash", "complete_phase", "start_step"]),
		getAllTools: vi.fn(() => [{ name: "read" }, { name: "bash" }, { name: "complete_phase" }, { name: "start_step" }]),
		setActiveTools: vi.fn(),
	} as unknown as ExtensionAPI
	const ferment = storage.create("Phase Test")
	const phaseCount = options.phases ?? 2
	const scope = applyAndPersist(ferment.id, {
		type: "scope",
		goal: "Goal",
		successCriteria: "Works",
		constraints: [],
		phases: Array.from({ length: phaseCount }, (_, index) => ({
			name: `Phase ${index + 1}`,
			goal: `Build ${index + 1}`,
			steps: [{ description: `Step ${index + 1}` }],
		})),
	})
	if (!scope.ok) throw new Error(scope.error.message)
	const active = applyAndPersist(ferment.id, { type: "activate_phase", phaseId: "phase-1" })
	if (!active.ok) throw new Error(active.error.message)
	const started = applyAndPersist(ferment.id, { type: "start_step", phaseId: "phase-1", stepId: "step-1" })
	if (!started.ok) throw new Error(started.error.message)
	const completed = applyAndPersist(ferment.id, {
		type: "complete_step",
		phaseId: "phase-1",
		stepId: "step-1",
		summary: "done",
	})
	if (!completed.ok) throw new Error(completed.error.message)
	return { storage, runtime, applyAndPersist, pi, fermentId: ferment.id }
}

function createServices(overrides: Partial<PhaseHandlerServices> = {}): PhaseHandlerServices {
	return {
		captureGitHead: vi.fn(() => undefined),
		gatherEvidence: vi.fn(() => ({ filesChanged: "file.ts", diffSnippet: "+change", available: true })),
		judgeGradePhase: vi.fn(async () => gradeA),
		judgeSuggestCorrectiveStep: vi.fn(async () => undefined),
		onPhaseCompleted: vi.fn(),
		isPlanMode: vi.fn(() => false),
		...overrides,
	}
}

beforeEach(() => {
	vi.restoreAllMocks()
	setActive(undefined)
})

describe("completePhase", () => {
	it("completes, gathers injected evidence, grades, and nudges through services", async () => {
		const h = createHarness()
		h.runtime.setPhaseStartRef(h.fermentId, "phase-1", "abc123")
		const services = createServices()

		const result = await completePhase(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "phase done" },
			{ pi: h.pi },
			services,
		)

		expect(okText(result)).toContain("Grade: A")
		expect(h.storage.get(h.fermentId)?.phases[0].status).toBe("completed")
		expect(h.storage.get(h.fermentId)?.phases[0].grade?.grade).toBe("A")
		expect(services.gatherEvidence).toHaveBeenCalledWith("abc123")
		expect(services.judgeGradePhase).toHaveBeenCalledWith(
			"Phase 1",
			"Build 1",
			expect.stringContaining("Step 1"),
			"phase done",
			expect.objectContaining({ available: true }),
		)
		expect(services.onPhaseCompleted).toHaveBeenCalledWith(h.pi)
	})

	it("stores corrective guidance for low phase grades", async () => {
		const h = createHarness()
		const gradeD: JudgeGrade = { grade: "D", rationale: "weak", gradedAt: "2026-01-01T00:00:00.000Z" }
		const services = createServices({
			judgeGradePhase: vi.fn(async () => gradeD),
			judgeSuggestCorrectiveStep: vi.fn(async () => "Add a regression test first."),
		})

		const result = await completePhase(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "phase done" },
			{ pi: h.pi },
			services,
		)

		expect(okText(result)).toContain("Grade: D")
		expect(h.runtime.getCorrectiveStep(h.fermentId, "phase-1")).toBe("Add a regression test first.")
		expect(services.judgeSuggestCorrectiveStep).toHaveBeenCalledWith("Phase 1", "Build 1", gradeD)
	})

	it("uses injected plan-mode UI to pause after phase review", async () => {
		const h = createHarness()
		const markHumanInput = vi.fn()
		h.runtime.markHumanInput = markHumanInput
		const services = createServices({ isPlanMode: vi.fn(() => true) })

		const result = await completePhase(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "phase done" },
			{
				pi: h.pi,
				ctx: { ui: { select: vi.fn(async () => "Pause here") } },
			},
			services,
		)

		expect(okText(result)).toContain("Ferment paused at user request")
		expect(h.storage.get(h.fermentId)?.status).toBe("paused")
		expect(h.pi.setActiveTools).toHaveBeenLastCalledWith(["read", "bash"])
		expect(markHumanInput).toHaveBeenCalled()
		expect(h.pi.sendUserMessage).toHaveBeenCalledWith("Ferment paused. Let me know when you are ready to continue.", {
			deliverAs: "followUp",
		})
	})
})

describe("registerPhaseTools", () => {
	it("uses the injected runtime, not the global active ferment, for plan-mode phase review", async () => {
		const h = createHarness()
		let injectedActive = h.storage.get(h.fermentId)
		if (!injectedActive) throw new Error("Expected active ferment in injected storage")
		h.runtime.getActive = () => injectedActive
		h.runtime.setActive = (ferment) => {
			injectedActive = ferment
		}
		setActive(undefined)

		const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>()
		const pi = {
			registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
				tools.set(tool.name, tool)
			},
			sendUserMessage: vi.fn(),
			appendEntry: vi.fn(),
			sendMessage: vi.fn(),
			getActiveTools: vi.fn(() => ["read", "bash", "complete_phase", "start_step"]),
			getAllTools: vi.fn(() => [
				{ name: "read" },
				{ name: "bash" },
				{ name: "complete_phase" },
				{ name: "start_step" },
			]),
			setActiveTools: vi.fn(),
		} as unknown as ExtensionAPI
		registerPhaseTools(pi, h.runtime)

		const select = vi.fn(async () => "Pause here")
		const completePhaseTool = tools.get("complete_phase")
		if (!completePhaseTool) throw new Error("complete_phase was not registered")

		const result = (await completePhaseTool.execute(
			"test-call-id",
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "phase done" },
			undefined,
			undefined,
			{ ui: { select } },
		)) as { content: { text: string }[]; isError?: boolean }

		expect(okText(result)).toContain("Ferment paused at user request")
		expect(select).toHaveBeenCalled()
		expect(h.storage.get(h.fermentId)?.status).toBe("paused")
	})
})
