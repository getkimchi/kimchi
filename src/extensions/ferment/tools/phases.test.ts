import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../../ferment/event-store.js"
import { createContext } from "../../__mocks__/context.js"
import type { JudgePhaseInput } from "../judge.js"
import { createDefaultFermentRuntime, type FermentRuntime } from "../runtime.js"
import { setActive } from "../state.js"
import { createApplyAndPersist } from "../tool-helpers.js"
import { completePhase, type PhaseHandlerServices, registerPhaseTools } from "./phases.js"

function okText(result: { content: { text: string }[]; isError?: boolean }): string {
	if (result.isError) throw new Error(`Expected ok, got error: ${result.content[0]?.text}`)
	return result.content.map((c) => c.text).join("\n")
}

function errText(result: { content: { text: string }[]; isError?: boolean }): string {
	if (!result.isError) throw new Error(`Expected error, got ok: ${result.content[0]?.text}`)
	return result.content.map((c) => c.text).join("\n")
}

function createHarness(options: { phases?: number; verification?: string } = {}) {
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
			steps: [{ description: `Step ${index + 1}`, ...(options.verification ? { verify: options.verification } : {}) }],
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
		judgePhaseGrade: vi.fn(async () => ({
			ok: true as const,
			grade: "A" as const,
			rationale: "Clean.",
			recommendations: [],
		})),
		runVerification: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" })),
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
			{ pi: h.pi, ctx: createContext() },
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
			{ pi: h.pi, ctx: createContext() },
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
			{ pi: h.pi, ctx: createContext() },
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
			{ pi: h.pi, ctx: createContext() },
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
				ctx: createContext({ ui: { select: selectSpy } }),
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
				ctx: createContext({ ui: { select: selectSpy } }),
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
			{ pi: h.pi, ctx: createContext() },
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
			{ pi: h.pi, ctx: createContext() },
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
			{ pi: h.pi, ctx: createContext() },
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
			createContext({ ui: { select: selectSpy } }),
		)) as { content: { text: string }[]; isError?: boolean }

		// Silent path: no dropdown, phase completed normally using the injected runtime.
		expect(selectSpy).not.toHaveBeenCalled()
		expect(h.storage.get(h.fermentId)?.phases[0].status).toBe("completed")
		expect(okText(result)).toContain("Phase")
	})

	it("warns when a refined plan declares no verify commands; stays silent when coverage exists", async () => {
		const tools = new Map<string, { name: string; execute: (...args: unknown[]) => Promise<unknown> }>()
		const pi = {
			registerTool: (t: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => tools.set(t.name, t),
			sendUserMessage: vi.fn(),
			appendEntry: vi.fn(),
			sendMessage: vi.fn(),
			getActiveTools: vi.fn(() => ["read", "bash", "refine_ferment_phase"]),
			getAllTools: vi.fn(() => [{ name: "read" }, { name: "bash" }, { name: "refine_ferment_phase" }]),
			setActiveTools: vi.fn(),
		} as unknown as ExtensionAPI
		const h = createHarness()
		registerPhaseTools(pi, h.runtime)
		const tool = tools.get("refine_ferment_phase")
		if (!tool) throw new Error("refine_ferment_phase was not registered")

		const verifyLess = (await tool.execute(
			"tc-1",
			{
				ferment_id: h.fermentId,
				phase_id: "phase-1",
				steps: [{ description: "Do thing" }, { description: "Do other thing" }],
			},
			undefined,
			undefined,
			createContext(),
		)) as { content: { text: string }[]; isError?: boolean }
		expect(okText(verifyLess)).toContain("none of the refined steps declares a verify command")

		const withVerify = (await tool.execute(
			"tc-2",
			{
				ferment_id: h.fermentId,
				phase_id: "phase-1",
				steps: [{ description: "Do thing", verify: "npm run test" }],
			},
			undefined,
			undefined,
			createContext(),
		)) as { content: { text: string }[]; isError?: boolean }
		expect(okText(withVerify)).not.toContain("none of the refined steps declares a verify command")
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

	// ── LLM phase grader enforcement ──────────────────────────────────────────

	it("A-grade advances and persists recommendations", async () => {
		const h = createHarness()
		const recs = ["Add integration test for the retry path."]
		const services = createServices({
			judgePhaseGrade: vi.fn(async () => ({
				ok: true as const,
				grade: "A" as const,
				rationale: "Excellent. Production-ready.",
				recommendations: recs,
			})),
		})

		const result = await completePhase(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "phase done", gates: passingPhaseGates() },
			{ pi: h.pi },
			services,
		)

		expect(okText(result)).toContain('**Phase "Phase 1"** done')
		const stored = h.storage.get(h.fermentId)
		expect(stored?.phases[0].status).toBe("completed")
		expect(stored?.phases[0].grade?.grade).toBe("A")
		expect(stored?.phases[0].grade?.recommendations).toEqual(recs)
	})

	it("B-grade refuses on first attempt, accepts on rework", async () => {
		const h = createHarness()
		const recs = ["Add edge-case test for empty input.", "Wire retry into production call site."]
		const services = createServices({
			judgePhaseGrade: vi.fn(async () => ({
				ok: true as const,
				grade: "B" as const,
				rationale: "Goal met but coverage is thin.",
				recommendations: recs,
			})),
		})

		// First attempt: B refused (minimum is A on first try).
		const result1 = await completePhase(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "attempt 1", gates: passingPhaseGates() },
			{ pi: h.pi },
			services,
		)
		const err1 = result1 as { content: { text: string }[]; isError?: boolean }
		expect(err1.isError).toBe(true)
		expect(err1.content.map((c) => c.text).join("\n")).toContain("minimum required is A")

		// Second attempt: B accepted (minimum relaxes to B after rework).
		const result2 = await completePhase(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "attempt 2", gates: passingPhaseGates() },
			{ pi: h.pi },
			services,
		)
		expect(okText(result2)).toContain('**Phase "Phase 1"** done')
		const stored = h.storage.get(h.fermentId)
		expect(stored?.phases[0].status).toBe("completed")
		expect(stored?.phases[0].grade?.grade).toBe("B")
		expect(stored?.phases[0].grade?.recommendations).toEqual(recs)
	})

	it("C-grade refuses advancement within budget and surfaces recommendations", async () => {
		const h = createHarness()
		const recs = ["Fix the N+1 query in listUsers.", "Add cancellation to the fetch loop."]
		const services = createServices({
			judgePhaseGrade: vi.fn(async () => ({
				ok: true as const,
				grade: "C" as const,
				rationale: "Operational gaps.",
				recommendations: recs,
			})),
		})

		const result = await completePhase(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "phase done", gates: passingPhaseGates() },
			{ pi: h.pi },
			services,
		)

		const errResult = result as { content: { text: string }[]; isError?: boolean }
		expect(errResult.isError).toBe(true)
		const text = errResult.content.map((c) => c.text).join("\n")
		expect(text).toContain("LLM grader assigned grade C")
		expect(text).toContain("retry 1/3")
		expect(text).toContain("Fix the N+1 query in listUsers.")
		expect(text).toContain("Add cancellation to the fetch loop.")
		// Fix protocol: executor must apply the fix to the artifact and verify
		// with the grader's named check, not by weakening tests (run-6 failure).
		expect(text).toContain("How to fix this correctly")
		expect(text).toContain("Fix the artifact, not the test")
		// Phase must NOT be completed.
		expect(h.storage.get(h.fermentId)?.phases[0].status).toBe("active")
		// Retry counter must have been bumped.
		expect(h.runtime.getBlockRetry(h.fermentId, "phase-1")).toBe(1)
	})

	it("C-grade repeated exhausts budget and advances with the grade", async () => {
		const h = createHarness()
		const recs = ["Fix the N+1 query in listUsers."]
		const services = createServices({
			judgePhaseGrade: vi.fn(async () => ({
				ok: true as const,
				grade: "C" as const,
				rationale: "Operational gaps.",
				recommendations: recs,
			})),
		})

		// First refusal: within budget.
		const result1 = await completePhase(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "attempt 1", gates: passingPhaseGates() },
			{ pi: h.pi },
			services,
		)
		const err1 = result1 as { content: { text: string }[]; isError?: boolean }
		expect(err1.isError).toBe(true)
		expect(err1.content.map((c) => c.text).join("\n")).toContain("retry 1/3")

		// Second refusal: within budget.
		const result2 = await completePhase(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "attempt 2", gates: passingPhaseGates() },
			{ pi: h.pi },
			services,
		)
		const err2 = result2 as { content: { text: string }[]; isError?: boolean }
		expect(err2.isError).toBe(true)
		expect(err2.content.map((c) => c.text).join("\n")).toContain("retry 2/3")

		// Third refusal: within budget.
		const result3 = await completePhase(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "attempt 3", gates: passingPhaseGates() },
			{ pi: h.pi },
			services,
		)
		const err3 = result3 as { content: { text: string }[]; isError?: boolean }
		expect(err3.isError).toBe(true)
		expect(err3.content.map((c) => c.text).join("\n")).toContain("retry 3/3")

		// Fourth attempt: budget exhausted — accepts the grade and advances.
		const result4 = await completePhase(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "attempt 4", gates: passingPhaseGates() },
			{ pi: h.pi },
			services,
		)
		expect(okText(result4)).toContain('**Phase "Phase 1"** done')
		const stored = h.storage.get(h.fermentId)
		expect(stored?.phases[0].status).toBe("completed")
		expect(stored?.phases[0].grade?.grade).toBe("C")
		expect(stored?.phases[0].grade?.recommendations).toEqual(recs)
	})

	it("judge-unavailable advances with advisory grade and no refusal", async () => {
		const h = createHarness()
		const services = createServices({
			judgePhaseGrade: vi.fn(async () => ({
				ok: false as const,
				reason: "no_auth" as const,
			})),
		})

		const result = await completePhase(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "phase done", gates: passingPhaseGates() },
			{ pi: h.pi },
			services,
		)

		expect(okText(result)).toContain('**Phase "Phase 1"** done')
		const stored = h.storage.get(h.fermentId)
		expect(stored?.phases[0].status).toBe("completed")
		// Grade falls back to the deterministic derivedGrade (A when all gates pass).
		expect(stored?.phases[0].grade?.grade).toBe("A")
		// Rationale should note the judge was unavailable.
		expect(stored?.phases[0].grade?.rationale).toContain("unavailable")
	})

	it("harness-executed step verification runs reach the grader prompt input", async () => {
		// The harness's default steps declare no verify command — even so, that
		// absence is evidence the grader receives (used to have to demand it).
		const h = createHarness()
		let seenInput: { stepVerificationRuns?: string } | undefined
		const services = createServices({
			judgePhaseGrade: vi.fn(async (input: { stepVerificationRuns?: string }) => {
				seenInput = input
				return { ok: true as const, grade: "A" as const, rationale: "Clean.", recommendations: [] }
			}),
		})

		await completePhase(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "phase done", gates: passingPhaseGates() },
			{ pi: h.pi },
			services,
		)

		expect(seenInput?.stepVerificationRuns).toContain("(no verify command declared)")
	})

	it("delta-grading: a retry attempt's grader receives the prior refusal; acceptance clears it", async () => {
		const h = createHarness()
		const recs = ["Add edge-case test for empty input."]
		const captured: (JudgePhaseInput["priorRefusal"] | undefined)[] = []
		let call = 0
		const services = createServices({
			judgePhaseGrade: vi.fn(async (input: JudgePhaseInput) => {
				captured.push(input.priorRefusal)
				call += 1
				return call === 1
					? { ok: true as const, grade: "C" as const, rationale: "Gap.", recommendations: recs }
					: { ok: true as const, grade: "A" as const, rationale: "Fixed.", recommendations: [] }
			}),
		})

		const first = await completePhase(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "attempt 1", gates: passingPhaseGates() },
			{ pi: h.pi },
			services,
		)
		expect(errText(first)).toContain("grade C")

		const second = await completePhase(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "attempt 2", gates: passingPhaseGates() },
			{ pi: h.pi },
			services,
		)
		expect(okText(second)).toContain('**Phase "Phase 1"** done')

		expect(captured).toHaveLength(2)
		// First attempt graded without history; the retry graded with it.
		expect(captured[0]).toBeUndefined()
		expect(captured[1]?.grade).toBe("C")
		expect(captured[1]?.recommendations).toEqual(recs)
		// Acceptance clears the retry counter but RETAINS the refusal record —
		// the first journey-grade attempt reads the most recent phase refusal
		// as quality-momentum context (purged only by clearFermentState).
		expect(h.runtime.getLastPhaseRefusal(h.fermentId, "phase-1")?.grade).toBe("C")
	})

	it("deterministic re-verification refuses a red run without spawning the grader", async () => {
		const h = createHarness({ verification: "npm run test" })
		const judgePhaseGrade = vi.fn(async () => ({
			ok: true as const,
			grade: "A" as const,
			rationale: "Clean.",
			recommendations: [],
		}))
		const services = createServices({
			runVerification: vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "2 tests failed" })),
			judgePhaseGrade,
		})

		const result = await completePhase(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "phase done", gates: passingPhaseGates() },
			{ pi: h.pi },
			services,
		)

		const text = errText(result)
		expect(text).toContain("deterministic re-verification failed")
		expect(text).toContain("npm run test")
		expect(text).toContain("2 tests failed")
		// The grader is never spawned for the evidence class — the gate refuses first.
		expect(judgePhaseGrade).not.toHaveBeenCalled()
		expect(h.storage.get(h.fermentId)?.phases[0].status).toBe("active")
		expect(h.runtime.getBlockRetry(h.fermentId, "phase-1")).toBe(1)
	})

	it("green re-verification proceeds to the grader and completes", async () => {
		const h = createHarness({ verification: "npm run test" })
		const runVerification = vi.fn(async () => ({ exitCode: 0, stdout: "42 passed", stderr: "" }))
		const judgePhaseGrade = vi.fn(async () => ({
			ok: true as const,
			grade: "A" as const,
			rationale: "Clean.",
			recommendations: [],
		}))
		const services = createServices({ runVerification, judgePhaseGrade })

		const result = await completePhase(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "phase done", gates: passingPhaseGates() },
			{ pi: h.pi },
			services,
		)

		expect(okText(result)).toContain('**Phase "Phase 1"** done')
		expect(runVerification).toHaveBeenCalledTimes(1)
		expect(runVerification).toHaveBeenCalledWith(expect.objectContaining({ command: "npm run test" }))
		expect(judgePhaseGrade).toHaveBeenCalledTimes(1)
	})

	it("zero declared verification proceeds with an advisory note on the stored rationale", async () => {
		const h = createHarness()
		const services = createServices()

		const result = await completePhase(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "phase done", gates: passingPhaseGates() },
			{ pi: h.pi },
			services,
		)

		expect(okText(result)).toContain('**Phase "Phase 1"** done')
		expect(h.storage.get(h.fermentId)?.phases[0].grade?.rationale).toContain(
			"advisory: phase declared no executable verification",
		)
	})

	it("fallback_single_shot grade is advisory-only, never refuses, with provenance persisted", async () => {
		// Regression: a blind fallback letter (grader subagent unusable) used to be
		// able to refuse/lower a phase even though it had no tool access or
		// independent verification behind it.
		const h = createHarness()
		const services = createServices({
			judgePhaseGrade: vi.fn(async () => ({
				ok: true as const,
				grade: "F" as const,
				rationale: "Blind fallback could not verify anything.",
				recommendations: ["Everything looks broken."],
				graderSource: "fallback_single_shot" as const,
			})),
		})

		const result = await completePhase(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "phase done", gates: passingPhaseGates() },
			{ pi: h.pi },
			services,
		)

		expect(okText(result)).toContain('**Phase "Phase 1"** done')
		const stored = h.storage.get(h.fermentId)
		expect(stored?.phases[0].status).toBe("completed")
		// The blind fallback letter is persisted for the record…
		expect(stored?.phases[0].grade?.grade).toBe("F")
		// …but flagged advisory-only so it cannot lower or block the phase,
		expect(stored?.phases[0].grade?.rationale).toContain("advisory-only")
		// …with provenance recorded.
		expect(stored?.phases[0].grade?.graderSource).toBe("fallback_single_shot")
	})
})
