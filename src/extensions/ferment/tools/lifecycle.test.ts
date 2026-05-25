import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../../ferment/event-store.js"
import { type FermentRuntime, createDefaultFermentRuntime } from "../runtime.js"
import { createApplyAndPersist } from "../tool-helpers.js"
import {
	buildFreeformScopingFeedbackMessage,
	completeFerment,
	registerLifecycleTools,
	scopeFerment,
} from "./lifecycle.js"

// Stub the journey-grade judge for completeFerment tests. The mock returns a
// clean A by default; individual cases can vi.mocked(judgeJourneyGrade).mockResolvedValueOnce(...)
// to exercise the judge-unavailable / unparseable paths.
vi.mock("../judge.js", async () => {
	const actual = await vi.importActual<typeof import("../judge.js")>("../judge.js")
	return {
		...actual,
		judgeJourneyGrade: vi.fn(async () => ({
			ok: true as const,
			grade: "A" as const,
			rationale: "Clean delivery; gates substantiated.",
		})),
	}
})

const { judgeJourneyGrade: mockJudgeJourneyGrade } = await import("../judge.js")

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

function createHarness() {
	const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-lifecycle-test-")))
	const runtime: FermentRuntime = { ...createDefaultFermentRuntime(), getStorage: () => storage }
	const pi = { sendMessage: vi.fn(), sendUserMessage: vi.fn(), appendEntry: vi.fn() } as unknown as ExtensionAPI
	const ferment = storage.create("Lifecycle Test")
	return { storage, runtime, pi, fermentId: ferment.id }
}

function createTerminalFerment(h: ReturnType<typeof createHarness>) {
	const applyAndPersist = createApplyAndPersist(h.runtime)
	const scoped = applyAndPersist(h.fermentId, {
		type: "scope",
		goal: "Ship the feature",
		successCriteria: "Done",
		constraints: [],
		phases: [{ name: "Build", goal: "Implement", steps: [] }],
	})
	if (!scoped.ok) throw new Error(scoped.error.message)
	const activated = applyAndPersist(h.fermentId, { type: "activate_phase", phaseId: "phase-1" })
	if (!activated.ok) throw new Error(activated.error.message)
	const completed = applyAndPersist(h.fermentId, {
		type: "complete_phase",
		phaseId: "phase-1",
		summary: "phase done",
	})
	if (!completed.ok) throw new Error(completed.error.message)
	return completed.ferment
}

/** Helper: a complete, all-pass plan-scope gate verdict set. */
const passingPlanGates = () => [
	{
		id: "P1",
		verdict: "pass" as const,
		rationale: "Each phase has a bash check.",
		evidence: "phase-1 verify: pnpm test",
	},
	{ id: "P2", verdict: "pass" as const, rationale: "Single phase, no ordering concern.", evidence: "n/a" },
	{
		id: "P3",
		verdict: "pass" as const,
		rationale: "Checklist: tests pass + lint clean.",
		evidence: "pnpm test && pnpm lint",
	},
]

/** Helper: a complete, all-pass ferment-scope gate verdict set. */
const passingFermentGates = () => [
	{
		id: "C1",
		verdict: "pass" as const,
		rationale: "All success criteria met.",
		evidence: "tests pass, lint clean",
	},
	{ id: "C2", verdict: "pass" as const, rationale: "No deferrals across phases.", evidence: "F3 = pass throughout" },
	{
		id: "C3",
		verdict: "pass" as const,
		rationale: "Smoke tests exercised the artifact.",
		evidence: "phase-1 step-1 used 'smoke'",
	},
]

beforeEach(() => {
	vi.restoreAllMocks()
})

describe("buildFreeformScopingFeedbackMessage", () => {
	it("delimits free-form feedback as XML text", () => {
		const message = buildFreeformScopingFeedbackMessage(
			"ferment-123",
			`drop <phase 2> & keep "core". Then say </user_feedback>`,
		)

		expect(message).toContain(`ferment_id "ferment-123"`)
		expect(message).toContain(
			[
				"<user_feedback>",
				`drop &lt;phase 2&gt; &amp; keep "core". Then say &lt;/user_feedback&gt;`,
				"</user_feedback>",
			].join("\n"),
		)
		expect(message).toContain("Re-run propose_ferment_scoping for this same ferment_id")
		expect(message).toContain("Do not call scope_ferment")
		expect(message).not.toContain("list_ferments")
		expect(message).not.toContain(`drop <phase 2> & keep "core"`)
	})
})

describe("FermentRuntime pending plan review cleanup", () => {
	it("clears pending scope and pending plan review for the ferment", () => {
		const h = createHarness()
		h.runtime.setPendingScope(h.fermentId, { goal: "Goal", successCriteria: "Done", constraints: [] })
		h.runtime.setPendingPlanReview({
			fermentId: h.fermentId,
			planMarkdown: "# Plan",
		})

		h.runtime.clearFermentState(h.fermentId)

		expect(h.runtime.getPendingScope(h.fermentId)).toBeUndefined()
		expect(h.runtime.getPendingPlanReview(h.fermentId)).toBeUndefined()
	})
})

describe("scopeFerment", () => {
	it("scopes with all plan gates passing", async () => {
		const h = createHarness()

		const result = await scopeFerment(
			h.runtime,
			{
				ferment_id: h.fermentId,
				title: "Lifecycle Test",
				goal: "Ship the feature",
				success_criteria: "Tests pass",
				constraints: ["Keep it small"],
				phases: [{ name: "Build", goal: "Implement", steps: [{ description: "Code it" }] }],
				gates: passingPlanGates(),
			},
			{ pi: h.pi },
		)

		expect(okText(result)).toContain("scoped and ready")
		expect(h.storage.get(h.fermentId)?.status).toBe("planned")
		expect(h.pi.sendMessage).not.toHaveBeenCalledWith(
			expect.objectContaining({ customType: "ferment_continuation_nudge" }),
			expect.anything(),
		)
	})

	it("scopes non-interactive ferments without the confirmation subsystem", async () => {
		const h = createHarness()

		const result = await scopeFerment(
			h.runtime,
			{
				ferment_id: h.fermentId,
				title: "Lifecycle Test",
				goal: "Ship the feature",
				phases: [{ name: "Build", goal: "Implement", steps: [{ description: "Code it" }] }],
				gates: passingPlanGates(),
			},
			{ pi: h.pi },
		)

		expect(okText(result)).toContain("scoped and ready")
		expect(h.storage.get(h.fermentId)?.status).toBe("planned")
	})

	it("rejects scope_ferment when title is blank", async () => {
		const h = createHarness()

		const result = await scopeFerment(
			h.runtime,
			{
				ferment_id: h.fermentId,
				title: "   ",
				goal: "Ship the feature",
				phases: [{ name: "Build", goal: "Implement", steps: [{ description: "Code it" }] }],
				gates: passingPlanGates(),
			},
			{ pi: h.pi },
		)

		expect(errText(result)).toContain('Field "title" must be a non-empty')
		expect(h.storage.get(h.fermentId)?.status).toBe("draft")
	})

	it("refuses scoping when agent self-flags a plan gate", async () => {
		const h = createHarness()
		const flaggedGates = [
			{
				id: "P1",
				verdict: "flag" as const,
				rationale: "phase-1 has no concrete verifier.",
				evidence: "no verify command set",
			},
			{ id: "P2", verdict: "pass" as const, rationale: "ok", evidence: "n/a" },
			{ id: "P3", verdict: "pass" as const, rationale: "ok", evidence: "n/a" },
		]

		const result = await scopeFerment(
			h.runtime,
			{
				ferment_id: h.fermentId,
				title: "Lifecycle Test",
				goal: "Ship the feature",
				phases: [{ name: "Build", goal: "Implement" }],
				gates: flaggedGates,
			},
			{ pi: h.pi },
		)

		expect(errText(result)).toContain("Gate P1")
		expect(errText(result)).toContain("no concrete verifier")
		expect(h.storage.get(h.fermentId)?.status).toBe("draft")
	})

	it("rejects scoping with a clear error when gate coverage is incomplete", async () => {
		const h = createHarness()
		const incomplete = [{ id: "P1", verdict: "pass" as const, rationale: "ok", evidence: "n/a" }]

		const result = await scopeFerment(
			h.runtime,
			{
				ferment_id: h.fermentId,
				title: "Lifecycle Test",
				goal: "Ship the feature",
				phases: [{ name: "Build", goal: "Implement" }],
				gates: incomplete,
			},
			{ pi: h.pi },
		)

		expect(errText(result)).toContain("missing required gate verdicts")
		expect(errText(result)).toContain("P2")
		expect(errText(result)).toContain("P3")
		expect(h.storage.get(h.fermentId)?.status).toBe("draft")
	})

	it("points blocked interactive scope_ferment calls back to propose_ferment_scoping", async () => {
		const h = createHarness()
		h.runtime.markScopingInteractive(h.fermentId)

		const result = await scopeFerment(
			h.runtime,
			{
				ferment_id: h.fermentId,
				title: "Lifecycle Test",
				goal: "Ship the feature",
				phases: [{ name: "Build", goal: "Implement" }],
				gates: passingPlanGates(),
			},
			{ pi: h.pi },
		)

		expect(errText(result)).toContain("propose_ferment_scoping")
		expect(errText(result)).toContain("Do not call scope_ferment directly")
		expect(errText(result)).not.toContain("Present the plan summary")
		expect(h.storage.get(h.fermentId)?.status).toBe("draft")
	})

	it("scope_ferment tool with assumptions param persists them into scoping.assumptions", async () => {
		const h = createHarness()

		await scopeFerment(
			h.runtime,
			{
				ferment_id: h.fermentId,
				title: "Lifecycle Test",
				goal: "Ship the feature",
				success_criteria: "Tests pass",
				assumptions: "k8s cluster exists and is reachable",
				phases: [{ name: "Build", goal: "Implement", steps: [{ description: "Code it" }] }],
				gates: passingPlanGates(),
			},
			{ pi: h.pi },
		)

		const saved = h.storage.get(h.fermentId)
		expect(saved?.scoping.assumptions?.answer).toBe("k8s cluster exists and is reachable")
	})

	it("scope_ferment tool without assumptions leaves scoping.assumptions undefined", async () => {
		const h = createHarness()

		await scopeFerment(
			h.runtime,
			{
				ferment_id: h.fermentId,
				title: "Lifecycle Test",
				goal: "Ship the feature",
				phases: [{ name: "Build", goal: "Implement", steps: [{ description: "Code it" }] }],
				gates: passingPlanGates(),
			},
			{ pi: h.pi },
		)

		const saved = h.storage.get(h.fermentId)
		expect(saved?.scoping.assumptions).toBeUndefined()
	})
})

describe("propose_ferment_scoping via registerLifecycleTools", () => {
	function createProposeHarness() {
		const h = createHarness()
		const tools = new Map<string, RegisteredTool>()
		const pi = {
			...h.pi,
			registerTool: (tool: RegisteredTool) => {
				tools.set(tool.name, tool)
			},
			getActiveTools: vi.fn(() => ["read", "bash"]),
			getAllTools: vi.fn(() => [{ name: "read" }, { name: "bash" }]),
			setActiveTools: vi.fn(),
		} as unknown as ExtensionAPI
		registerLifecycleTools(pi, h.runtime)

		const tool = tools.get("propose_ferment_scoping")
		if (!tool) throw new Error("propose_ferment_scoping not registered")
		const execute = tool.execute as unknown as (
			...args: unknown[]
		) => Promise<{ content: { text: string }[]; isError?: boolean }>
		return { h, execute }
	}

	it("normalizes canonical question fields before runtime validation", async () => {
		const { h, execute } = createProposeHarness()

		const result = await execute(
			"tool-call-1",
			{
				ferment_id: h.fermentId,
				title: "Lifecycle Test",
				goal: "Ship the feature",
				phases: [{ name: "Build", goal: "Implement", steps: [{ description: "Code it" }] }],
				questions: [
					{
						id: "q1",
						question: "Which path?",
						options: [
							{ id: "a", label: "A", recommended: true },
							{ id: "b", label: "B" },
						],
					},
				],
				gates: passingPlanGates(),
			},
			undefined,
			undefined,
			{ ui: {} },
		)

		expect(errText(result)).toContain("Cannot ask scoping questions without an interactive UI")
		expect(errText(result)).not.toContain("questions.0.question")
	})

	it("rejects propose_ferment_scoping when title is blank", async () => {
		const { h, execute } = createProposeHarness()

		const result = await execute(
			"tool-call-1",
			{
				ferment_id: h.fermentId,
				title: '  ""  ',
				goal: "Ship the feature",
				phases: [{ name: "Build", goal: "Implement", steps: [{ description: "Code it" }] }],
				questions: [],
				gates: passingPlanGates(),
			},
			undefined,
			undefined,
			{ ui: {} },
		)

		expect(errText(result)).toContain('Field "title" must be a non-empty')
	})

	it("rejects prompt because question is the only public question text field", async () => {
		const { h, execute } = createProposeHarness()

		const result = await execute(
			"tool-call-1",
			{
				ferment_id: h.fermentId,
				title: "Lifecycle Test",
				goal: "Ship the feature",
				phases: [{ name: "Build", goal: "Implement", steps: [{ description: "Code it" }] }],
				questions: [
					{
						id: "q1",
						prompt: "Which path?",
						options: [
							{ id: "a", label: "A", recommended: true },
							{ id: "b", label: "B" },
						],
					},
				],
				gates: passingPlanGates(),
			},
			undefined,
			undefined,
			{ ui: {} },
		)

		expect(errText(result)).toContain("questions.0.question must be a string")
	})

	it("allows empty question because the schema only requires a string", async () => {
		const { h, execute } = createProposeHarness()

		const result = await execute(
			"tool-call-1",
			{
				ferment_id: h.fermentId,
				title: "Lifecycle Test",
				goal: "Ship the feature",
				phases: [{ name: "Build", goal: "Implement", steps: [{ description: "Code it" }] }],
				questions: [
					{
						id: "q1",
						question: "",
						options: [
							{ id: "a", label: "A", recommended: true },
							{ id: "b", label: "B" },
						],
					},
				],
				gates: passingPlanGates(),
			},
			undefined,
			undefined,
			{ ui: {} },
		)

		expect(errText(result)).toContain("Cannot ask scoping questions without an interactive UI")
		expect(errText(result)).not.toContain("questions.0.question must be a string")
	})

	it("rejects text because question is the only public question text field", async () => {
		const { h, execute } = createProposeHarness()

		const result = await execute(
			"tool-call-1",
			{
				ferment_id: h.fermentId,
				title: "Lifecycle Test",
				goal: "Ship the feature",
				phases: [{ name: "Build", goal: "Implement", steps: [{ description: "Code it" }] }],
				questions: [
					{
						id: "q1",
						text: "Legacy text?",
						options: [
							{ id: "a", label: "A", recommended: true },
							{ id: "b", label: "B" },
						],
					},
				],
				gates: passingPlanGates(),
			},
			undefined,
			undefined,
			{ ui: {} },
		)

		expect(errText(result)).toContain("questions.0.question must be a string")
	})
})

describe("update_ferment_scope_field via registerLifecycleTools", () => {
	function createRegisteredHarness() {
		const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-update-scope-test-")))
		const runtime: FermentRuntime = { ...createDefaultFermentRuntime(), getStorage: () => storage }
		const tools = new Map<string, RegisteredTool>()
		const pi = {
			registerTool: (tool: RegisteredTool) => {
				tools.set(tool.name, tool)
			},
			sendMessage: vi.fn(),
			appendEntry: vi.fn(),
			getActiveTools: vi.fn(() => ["read", "bash"]),
			getAllTools: vi.fn(() => [{ name: "read" }, { name: "bash" }]),
			setActiveTools: vi.fn(),
		} as unknown as ExtensionAPI
		registerLifecycleTools(pi, runtime)
		// Create and scope a ferment so update_ferment_scope_field has something to revise.
		const applyAndPersist = createApplyAndPersist(runtime)
		const ferment = storage.create("Update Scope Test")
		const scoped = applyAndPersist(ferment.id, {
			type: "scope",
			goal: "Original goal",
			successCriteria: "Done",
			constraints: [],
			phases: [{ name: "Phase", goal: "Build", steps: [] }],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		return { storage, runtime, tools, fermentId: ferment.id }
	}

	it("update_ferment_scope_field with field 'assumptions' writes scoping.assumptions via the tool", async () => {
		const { tools, fermentId, storage } = createRegisteredHarness()
		const tool = tools.get("update_ferment_scope_field")
		if (!tool) throw new Error("update_ferment_scope_field was not registered")

		const result = (await tool.execute("test-call-id", {
			ferment_id: fermentId,
			field: "assumptions",
			value: "k8s cluster exists and is reachable",
		})) as { content: { text: string }[]; isError?: boolean }

		expect(okText(result)).toContain("assumptions")
		expect(storage.get(fermentId)?.scoping.assumptions?.answer).toBe("k8s cluster exists and is reachable")
	})

	it("update_ferment_scope_field rejects unknown fields with a message listing assumptions", async () => {
		const { tools, fermentId } = createRegisteredHarness()
		const tool = tools.get("update_ferment_scope_field")
		if (!tool) throw new Error("update_ferment_scope_field was not registered")

		const result = (await tool.execute("test-call-id", {
			ferment_id: fermentId,
			field: "unknown_field",
			value: "ignored",
		})) as { content: { text: string }[]; isError?: boolean }

		expect(errText(result)).toContain("assumptions")
	})
})

describe("completeFerment", () => {
	it("ships and clears runtime state when all ferment gates pass", async () => {
		const h = createHarness()
		createTerminalFerment(h)
		const clearFermentState = vi.fn()
		const setActive = vi.fn()
		h.runtime.clearFermentState = clearFermentState
		h.runtime.setActive = setActive

		const result = await completeFerment(
			h.runtime,
			{ ferment_id: h.fermentId, final_summary: "all done", gates: passingFermentGates() },
			{ pi: h.pi },
		)

		expect(okText(result)).toContain("complete")
		expect(okText(result)).toContain("C1 (pass)")
		expect(h.storage.get(h.fermentId)?.status).toBe("complete")
		expect(h.storage.get(h.fermentId)?.grade?.grade).toBe("A")
		expect(clearFermentState).toHaveBeenCalledWith(h.fermentId)
		expect(setActive).toHaveBeenCalledWith(undefined)
	})

	it("refuses ship when agent self-flags a ferment gate", async () => {
		const h = createHarness()
		createTerminalFerment(h)
		const flaggedGates = [
			{ id: "C1", verdict: "pass" as const, rationale: "ok", evidence: "n/a" },
			{
				id: "C2",
				verdict: "flag" as const,
				rationale: "phase-1 deferred error handling but no later phase resolves it.",
				evidence: "F3 of phase-1 deferred 'edge cases'",
			},
			{ id: "C3", verdict: "pass" as const, rationale: "ok", evidence: "smoke" },
		]

		const result = await completeFerment(
			h.runtime,
			{ ferment_id: h.fermentId, final_summary: "", gates: flaggedGates },
			{ pi: h.pi },
		)

		expect(errText(result)).toContain("complete_ferment refused")
		expect(errText(result)).toContain("Gate C2")
		expect(h.storage.get(h.fermentId)?.status).not.toBe("complete")
	})

	it("rejects ship with a clear error when ferment gate coverage is incomplete", async () => {
		const h = createHarness()
		createTerminalFerment(h)
		const incomplete = [{ id: "C1", verdict: "pass" as const, rationale: "ok", evidence: "n/a" }]

		const result = await completeFerment(
			h.runtime,
			{ ferment_id: h.fermentId, final_summary: "", gates: incomplete },
			{ pi: h.pi },
		)

		expect(errText(result)).toContain("missing required gate verdicts")
		expect(errText(result)).toContain("C2")
		expect(errText(result)).toContain("C3")
		expect(h.storage.get(h.fermentId)?.status).not.toBe("complete")
	})

	it("treats complete_ferment on an already-complete ferment as an inert no-op", async () => {
		const h = createHarness()
		createTerminalFerment(h)
		const first = await completeFerment(
			h.runtime,
			{ ferment_id: h.fermentId, final_summary: "done", gates: passingFermentGates() },
			{ pi: h.pi },
		)
		expect(okText(first)).toContain('Ferment "Lifecycle Test" complete')
		expect(okText(first)).toContain("Do not call bash/read/list_ferments or any ferment tools")
		expect(mockJudgeJourneyGrade).toHaveBeenCalledTimes(1)

		const second = await completeFerment(h.runtime, { ferment_id: h.fermentId }, { pi: h.pi })

		expect(okText(second)).toContain('Ferment "Lifecycle Test" is already complete')
		expect(okText(second)).toContain("without clear user consent")
		expect(mockJudgeJourneyGrade).toHaveBeenCalledTimes(1)
		expect(h.storage.get(h.fermentId)?.status).toBe("complete")
	})

	it("refuses complete_ferment on an abandoned ferment without grading", async () => {
		const h = createHarness()
		const applyAndPersist = createApplyAndPersist(h.runtime)
		const abandoned = applyAndPersist(h.fermentId, { type: "abandon", reason: "user stopped" })
		if (!abandoned.ok) throw new Error(abandoned.error.message)

		const result = await completeFerment(h.runtime, { ferment_id: h.fermentId }, { pi: h.pi })

		expect(errText(result)).toContain('Ferment "Lifecycle Test" is abandoned and cannot be completed')
		expect(mockJudgeJourneyGrade).not.toHaveBeenCalled()
		expect(h.storage.get(h.fermentId)?.status).toBe("abandoned")
	})

	it("persists the journey grade from the judge into ferment.grade", async () => {
		const h = createHarness()
		createTerminalFerment(h)
		vi.mocked(mockJudgeJourneyGrade).mockResolvedValueOnce({
			ok: true,
			grade: "B",
			rationale: "Phase 1 verified via proxy; goal met but coverage is thin.",
		})
		const result = await completeFerment(
			h.runtime,
			{ ferment_id: h.fermentId, final_summary: "done", gates: passingFermentGates() },
			{ pi: h.pi },
		)
		expect(okText(result)).toContain("Final grade: B")
		expect(okText(result)).toContain("proxy")
		expect(h.storage.get(h.fermentId)?.grade?.grade).toBe("B")
		expect(h.storage.get(h.fermentId)?.grade?.rationale).toContain("proxy")
		expect(h.storage.get(h.fermentId)?.grade?.unavailable).toBeUndefined()
	})

	it("interactive: judge unavailable + user chooses ship_no_grade → ships with unavailable=true", async () => {
		const h = createHarness()
		createTerminalFerment(h)
		vi.mocked(mockJudgeJourneyGrade).mockResolvedValueOnce({
			ok: false,
			reason: "no_auth",
			detail: "missing api key",
		})
		const select = vi.fn(async () => "Ship without a grade")
		const piWithUi = { ...h.pi, getFlag: vi.fn(() => undefined) } as unknown as ExtensionAPI
		const ctx = { ui: { select } }

		const result = await completeFerment(
			h.runtime,
			{ ferment_id: h.fermentId, final_summary: "done", gates: passingFermentGates() },
			{ pi: piWithUi, ctx },
		)

		expect(select).toHaveBeenCalled()
		expect(okText(result)).toContain("Final grade: B (unavailable)")
		expect(h.storage.get(h.fermentId)?.status).toBe("complete")
		expect(h.storage.get(h.fermentId)?.grade?.unavailable).toBe(true)
		expect(h.storage.get(h.fermentId)?.grade?.rationale).toContain("user authorized ship")
	})

	it("interactive: judge unavailable + user chooses abandon → ferment abandoned", async () => {
		const h = createHarness()
		createTerminalFerment(h)
		vi.mocked(mockJudgeJourneyGrade).mockResolvedValueOnce({
			ok: false,
			reason: "api_error",
			detail: "timeout after 45s",
		})
		const select = vi.fn(async () => "Abandon ferment")
		const piWithUi = { ...h.pi, getFlag: vi.fn(() => undefined) } as unknown as ExtensionAPI
		const ctx = { ui: { select } }

		const result = await completeFerment(
			h.runtime,
			{ ferment_id: h.fermentId, final_summary: "done", gates: passingFermentGates() },
			{ pi: piWithUi, ctx },
		)

		expect(select).toHaveBeenCalled()
		expect(errText(result)).toContain("user declined ungraded ship")
		expect(h.storage.get(h.fermentId)?.status).toBe("abandoned")
		expect(h.storage.get(h.fermentId)?.grade).toBeUndefined()
	})

	it("interactive: judge unavailable + user cancels prompt → leaves ferment uncompleted", async () => {
		const h = createHarness()
		createTerminalFerment(h)
		vi.mocked(mockJudgeJourneyGrade).mockResolvedValueOnce({
			ok: false,
			reason: "empty_response",
		})
		const select = vi.fn(async () => undefined)
		const piWithUi = { ...h.pi, getFlag: vi.fn(() => undefined) } as unknown as ExtensionAPI
		const ctx = { ui: { select } }

		const result = await completeFerment(
			h.runtime,
			{ ferment_id: h.fermentId, final_summary: "done", gates: passingFermentGates() },
			{ pi: piWithUi, ctx },
		)

		expect(select).toHaveBeenCalled()
		expect(errText(result)).toContain("user did not authorize ungraded ship")
		expect(h.storage.get(h.fermentId)?.status).not.toBe("complete")
		expect(h.storage.get(h.fermentId)?.status).not.toBe("abandoned")
		expect(h.storage.get(h.fermentId)?.grade).toBeUndefined()
	})

	it("one-shot: judge unavailable → ships with unavailable=true without prompting", async () => {
		const h = createHarness()
		createTerminalFerment(h)
		vi.mocked(mockJudgeJourneyGrade).mockResolvedValueOnce({
			ok: false,
			reason: "no_registry",
		})
		const select = vi.fn() // must NOT be called
		const piOneShot = {
			...h.pi,
			getFlag: vi.fn((name: string) => (name === "ferment-oneshot" ? true : undefined)),
		} as unknown as ExtensionAPI

		const result = await completeFerment(
			h.runtime,
			{ ferment_id: h.fermentId, final_summary: "done", gates: passingFermentGates() },
			{ pi: piOneShot, ctx: { ui: { select } } },
		)

		expect(select).not.toHaveBeenCalled()
		expect(okText(result)).toContain("Final grade: B (unavailable)")
		expect(h.storage.get(h.fermentId)?.status).toBe("complete")
		expect(h.storage.get(h.fermentId)?.grade?.unavailable).toBe(true)
	})
})
