import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../../ferment/event-store.js"
import { type FermentRuntime, createDefaultFermentRuntime } from "../runtime.js"
import { setActive } from "../state.js"
import { createApplyAndPersist } from "../tool-helpers.js"
import { type PhaseHandlerServices, completePhase, registerPhaseTools } from "./phases.js"

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
		getActiveTools: vi.fn(() => ["read", "bash", "complete_ferment_phase", "start_ferment_step"]),
		getAllTools: vi.fn(() => [
			{ name: "read" },
			{ name: "bash" },
			{ name: "complete_ferment_phase" },
			{ name: "start_ferment_step" },
		]),
		setActiveTools: vi.fn(),
	} as unknown as ExtensionAPI
	const ferment = storage.create("Phase Test")
	const phaseCount = options.phases ?? 2
	const scope = applyAndPersist(ferment.id, {
		type: "scope",
		goal: "Goal",
		successCriteria: ["Works"],
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
		runProjectChecks: vi.fn(() => ({ cwd: "/tmp", discovered: false, anyFailed: false, checks: [] })),
		onPhaseCompleted: vi.fn(),
		...overrides,
	}
}

/** Helper: a complete, all-pass phase-scope gate verdict set. */
const passingPhaseGates = () => [
	{ id: "F1", verdict: "pass" as const, rationale: "All step verifications were real.", evidence: "step-1 used smoke" },
	{ id: "F2", verdict: "pass" as const, rationale: "Phase goal delivered.", evidence: "feature.ts:1-40" },
	{ id: "F3", verdict: "pass" as const, rationale: "Nothing deferred.", evidence: "n/a" },
]

beforeEach(() => {
	vi.restoreAllMocks()
	setActive(undefined)
})

describe("completePhase", () => {
	it("completes when all gates pass and gathers evidence", async () => {
		const h = createHarness()
		h.runtime.setPhaseStartRef(h.fermentId, "phase-1", "abc123")
		const services = createServices()

		const result = await completePhase(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "phase done", gates: passingPhaseGates() },
			{ pi: h.pi },
			services,
		)

		// Phase grade is now persisted on the phase so telemetry can read it.
		// The deterministic grade (A/B/F from gate verdicts) lives on phase.grade;
		// the journey-grade judge assigns the final ferment.grade at complete_ferment.
		expect(okText(result)).toContain('**Phase "Phase 1"** done')
		expect(h.storage.get(h.fermentId)?.phases[0].status).toBe("completed")
		expect(h.storage.get(h.fermentId)?.phases[0].grade?.grade).toBe("A")
		expect(services.gatherEvidence).toHaveBeenCalledWith("abc123")
		expect(services.onPhaseCompleted).toHaveBeenCalledWith(h.runtime)
	})

	it("refuses to advance when the agent raises a flag verdict on a phase gate", async () => {
		const h = createHarness()
		const services = createServices()
		const flaggedGates = [
			{
				id: "F1",
				verdict: "flag" as const,
				rationale: "All steps were proxy-verified — no real behavior was exercised.",
				evidence: "step-1 used test -f, step-2 used grep",
			},
			{ id: "F2", verdict: "pass" as const, rationale: "Phase artifact exists.", evidence: "feature.ts" },
			{ id: "F3", verdict: "pass" as const, rationale: "Nothing deferred.", evidence: "n/a" },
		]

		const result = await completePhase(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "phase done", gates: flaggedGates },
			{ pi: h.pi },
			services,
		)

		const errResult = result as { content: { text: string }[]; isError?: boolean }
		expect(errResult.isError).toBe(true)
		const text = errResult.content.map((c) => c.text).join("\n")
		expect(text).toContain("Gate F1 flagged")
		expect(text).toContain("proxy-verified")
		// Phase must NOT be completed.
		expect(h.storage.get(h.fermentId)?.phases[0].status).toBe("active")
		// Retry counter must have been bumped to 1.
		expect(h.runtime.getBlockRetry(h.fermentId, "phase-1")).toBe(1)
	})

	it("rejects the call with a clear error when gate coverage is incomplete", async () => {
		const h = createHarness()
		const services = createServices()
		const incomplete = [
			{ id: "F1", verdict: "pass" as const, rationale: "ok", evidence: "n/a" },
			// F2 and F3 missing on purpose.
		]

		const result = await completePhase(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "phase done", gates: incomplete },
			{ pi: h.pi },
			services,
		)

		const errResult = result as { content: { text: string }[]; isError?: boolean }
		expect(errResult.isError).toBe(true)
		const text = errResult.content.map((c) => c.text).join("\n")
		expect(text).toContain("missing required gate verdicts")
		expect(text).toContain("F2")
		expect(text).toContain("F3")
		// Phase must NOT be completed and no retry counter bump because we never got past validation.
		expect(h.storage.get(h.fermentId)?.phases[0].status).toBe("active")
		expect(h.runtime.getBlockRetry(h.fermentId, "phase-1")).toBe(0)
	})

	it("rejects the call when a verdict shape is invalid (empty rationale)", async () => {
		const h = createHarness()
		const services = createServices()
		const malformed = [
			{ id: "F1", verdict: "pass" as const, rationale: "", evidence: "n/a" },
			{ id: "F2", verdict: "pass" as const, rationale: "ok", evidence: "n/a" },
			{ id: "F3", verdict: "pass" as const, rationale: "ok", evidence: "n/a" },
		]
		const result = await completePhase(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "phase done", gates: malformed },
			{ pi: h.pi },
			services,
		)
		const errResult = result as { content: { text: string }[]; isError?: boolean }
		expect(errResult.isError).toBe(true)
		expect(errResult.content.map((c) => c.text).join("\n")).toContain("rationale")
	})

	it("manual policy asks at the boundary and continues when selected", async () => {
		const h = createHarness()
		h.runtime.setContinuationPolicy("manual")
		const selectSpy = vi.fn(async () => "Continue to next phase")
		const services = createServices()

		const result = await completePhase(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "phase done", gates: passingPhaseGates() },
			{
				pi: h.pi,
				ctx: { ui: { select: selectSpy } },
			},
			services,
		)

		const text = okText(result)
		expect(selectSpy).toHaveBeenCalledWith('Phase "Phase 1" done.\nContinue "Phase Test" to "Phase 2"?', [
			"Continue to next phase",
			"Pause here",
		])
		expect(text).toContain("User chose to continue to the next phase")
		expect(text).toContain('**Next:** "Phase 2"')
		expect(text).toContain("Next action: call `activate_ferment_phase`")
		const stored = h.storage.get(h.fermentId)
		expect(stored?.status).toBe("planned")
		expect(stored?.phases[0].status).toBe("completed")
		expect(stored?.phases[1].status).toBe("planned")
		expect(stored?.activePhaseId).toBeUndefined()
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled()
	})

	it("manual policy pauses when the user chooses pause at the boundary", async () => {
		const h = createHarness()
		h.runtime.setContinuationPolicy("manual")
		const selectSpy = vi.fn(async () => "Pause here")
		const services = createServices()

		const result = await completePhase(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "phase done", gates: passingPhaseGates() },
			{
				pi: h.pi,
				ctx: { ui: { select: selectSpy } },
			},
			services,
		)

		const text = okText(result)
		expect(selectSpy).toHaveBeenCalled()
		expect(text).toContain("Manual continuation policy stopped here")
		expect(text).toContain('**Next:** "Phase 2"')
		expect(text).not.toContain("Next action: call `activate_ferment_phase`")
		const stored = h.storage.get(h.fermentId)
		expect(stored?.status).toBe("paused")
		expect(stored?.phases[0].status).toBe("completed")
		expect(stored?.phases[1].status).toBe("planned")
		expect(stored?.activePhaseId).toBeUndefined()
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled()
	})

	it("manual policy pauses at the boundary when no UI is available", async () => {
		const h = createHarness()
		h.runtime.setContinuationPolicy("manual")
		const services = createServices()

		const result = await completePhase(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "phase done", gates: passingPhaseGates() },
			{ pi: h.pi },
			services,
		)

		const text = okText(result)
		expect(text).toContain("Manual continuation policy stopped here")
		expect(text).toContain('**Next:** "Phase 2"')
		expect(text).not.toContain("Next action: call `activate_ferment_phase`")
		const stored = h.storage.get(h.fermentId)
		expect(stored?.status).toBe("paused")
		expect(stored?.phases[0].status).toBe("completed")
		expect(stored?.phases[1].status).toBe("planned")
		expect(stored?.activePhaseId).toBeUndefined()
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled()
	})

	it("manual policy still allows final ferment completion at the last boundary", async () => {
		const h = createHarness({ phases: 1 })
		h.runtime.setContinuationPolicy("manual")
		const services = createServices()

		const result = await completePhase(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "phase done", gates: passingPhaseGates() },
			{ pi: h.pi },
			services,
		)

		const text = okText(result)
		expect(text).toContain("All phases terminal")
		expect(text).toContain("Next action: call `complete_ferment`")
	})

	it("automated policy keeps the next phase activation hint", async () => {
		const h = createHarness()
		h.runtime.setContinuationPolicy("automated")
		const services = createServices()

		const result = await completePhase(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "phase done", gates: passingPhaseGates() },
			{ pi: h.pi },
			services,
		)

		const text = okText(result)
		expect(text).toContain('**Next:** "Phase 2"')
		expect(text).toContain("Next action: call `activate_ferment_phase`")
	})
})

describe("registerPhaseTools", () => {
	it("uses the injected runtime, not the global active ferment, for phase completion", async () => {
		const h = createHarness()
		h.runtime.setContinuationPolicy("automated")
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
			getActiveTools: vi.fn(() => ["read", "bash", "complete_ferment_phase", "start_ferment_step"]),
			getAllTools: vi.fn(() => [
				{ name: "read" },
				{ name: "bash" },
				{ name: "complete_ferment_phase" },
				{ name: "start_ferment_step" },
			]),
			setActiveTools: vi.fn(),
		} as unknown as ExtensionAPI
		registerPhaseTools(pi, h.runtime)

		const selectSpy = vi.fn()
		const completePhaseTool = tools.get("complete_ferment_phase")
		if (!completePhaseTool) throw new Error("complete_ferment_phase was not registered")

		// Call with UI injected - runtime uses injected storage (not global active).
		const result = (await completePhaseTool.execute(
			"test-call-id",
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "phase done", gates: passingPhaseGates() },
			undefined,
			undefined,
			{ ui: { select: selectSpy } },
		)) as { content: { text: string }[]; isError?: boolean }

		// Silent path: no dropdown, phase completed normally using the injected runtime.
		expect(selectSpy).not.toHaveBeenCalled()
		expect(h.storage.get(h.fermentId)?.phases[0].status).toBe("completed")
		expect(okText(result)).toContain("Phase")
	})

	it("renderResult returns a Markdown component", async () => {
		const tools = new Map<
			string,
			{ name: string; execute: (...args: unknown[]) => Promise<unknown>; renderResult?: (result: unknown) => unknown }
		>()
		const pi = {
			registerTool: (t: {
				name: string
				execute: (...args: unknown[]) => Promise<unknown>
				renderResult?: (result: unknown) => unknown
			}) => tools.set(t.name, t),
			sendUserMessage: vi.fn(),
			appendEntry: vi.fn(),
			sendMessage: vi.fn(),
			getActiveTools: vi.fn(() => ["read", "bash", "complete_ferment_phase"]),
			getAllTools: vi.fn(() => [{ name: "read" }, { name: "bash" }, { name: "complete_ferment_phase" }]),
			setActiveTools: vi.fn(),
		} as unknown as ExtensionAPI
		const h = createHarness()
		registerPhaseTools(pi, h.runtime)
		const tool = tools.get("complete_ferment_phase")
		const result = { content: [{ type: "text", text: "**Phase done**" }] }
		const component = tool?.renderResult?.(result)
		expect(component).toBeDefined()
	})
})
