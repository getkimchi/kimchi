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
		runProjectChecks: vi.fn(() => ({ cwd: "/tmp", discovered: false, anyFailed: false, checks: [] })),
		onPhaseCompleted: vi.fn(),
		isPlanMode: vi.fn(() => false),
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

		// Phase grades no longer exist — grading happens only at complete_ferment
		// (the journey-grade judge). Phase completion just transitions status.
		expect(okText(result)).toContain('Phase "Phase 1" done')
		expect(h.storage.get(h.fermentId)?.phases[0].status).toBe("completed")
		expect(h.storage.get(h.fermentId)?.phases[0].grade).toBeUndefined()
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

	it("uses injected plan-mode UI to pause after phase completion", async () => {
		const h = createHarness()
		const markHumanInput = vi.fn()
		h.runtime.markHumanInput = markHumanInput
		const services = createServices({ isPlanMode: vi.fn(() => true) })

		const result = await completePhase(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "phase done", gates: passingPhaseGates() },
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
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled()
	})

	it("does not queue stale follow-up messages for plan-mode phase review choices", async () => {
		const h = createHarness()
		const services = createServices({ isPlanMode: vi.fn(() => true) })

		const proceed = await completePhase(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "phase done", gates: passingPhaseGates() },
			{
				pi: h.pi,
				ctx: { ui: { select: vi.fn(async () => "Proceed to Phase 2") } },
			},
			services,
		)

		expect(okText(proceed)).toContain("User confirmed: proceed to Phase 2")
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled()
	})

	it("returns custom plan-mode phase direction in the tool result", async () => {
		const h = createHarness()
		const services = createServices({ isPlanMode: vi.fn(() => true) })

		const result = await completePhase(
			h.runtime,
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "phase done", gates: passingPhaseGates() },
			{
				pi: h.pi,
				ctx: {
					ui: {
						select: vi.fn(async () => "Let me say something"),
						input: vi.fn(async () => "Skip the remaining setup phase."),
					},
				},
			},
			services,
		)

		expect(okText(result)).toContain("User direction: Skip the remaining setup phase.")
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled()
	})
})

describe("registerPhaseTools", () => {
	it("uses the injected runtime, not the global active ferment, for plan-mode phase completion", async () => {
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
			{ ferment_id: h.fermentId, phase_id: "phase-1", summary: "phase done", gates: passingPhaseGates() },
			undefined,
			undefined,
			{ ui: { select } },
		)) as { content: { text: string }[]; isError?: boolean }

		expect(okText(result)).toContain("Ferment paused at user request")
		expect(select).toHaveBeenCalled()
		expect(h.storage.get(h.fermentId)?.status).toBe("paused")
	})
})
