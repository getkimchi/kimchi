import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../../ferment/event-store.js"
import { type FermentRuntime, createDefaultFermentRuntime } from "../runtime.js"
import { createApplyAndPersist } from "../tool-helpers.js"
import { type LifecycleHandlerServices, completeFerment, registerLifecycleTools, scopeFerment } from "./lifecycle.js"

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

function createServices(overrides: Partial<LifecycleHandlerServices> = {}): LifecycleHandlerServices {
	return {
		...overrides,
	}
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

describe("scopeFerment", () => {
	it("scopes with all plan gates passing and marks an after-scope continuation", async () => {
		const h = createHarness()
		const services = createServices()

		const result = await scopeFerment(
			h.runtime,
			{
				ferment_id: h.fermentId,
				goal: "Ship the feature",
				success_criteria: "Tests pass",
				constraints: ["Keep it small"],
				phases: [{ name: "Build", goal: "Implement", steps: [{ description: "Code it" }] }],
				gates: passingPlanGates(),
			},
			{ pi: h.pi },
			services,
		)

		expect(okText(result)).toContain("scoped and ready")
		expect(h.storage.get(h.fermentId)?.status).toBe("planned")
		expect(h.runtime.hasAfterScopeContinuation(h.fermentId)).toBe(true)
	})

	it("does not mark an after-scope continuation for exec-mode scoping", async () => {
		const h = createHarness()
		const applyAndPersist = createApplyAndPersist(h.runtime)
		const mode = applyAndPersist(h.fermentId, { type: "set_mode", mode: "exec" })
		if (!mode.ok) throw new Error(mode.error.message)
		const services = createServices()

		const result = await scopeFerment(
			h.runtime,
			{
				ferment_id: h.fermentId,
				goal: "Ship the feature",
				phases: [{ name: "Build", goal: "Implement", steps: [{ description: "Code it" }] }],
				gates: passingPlanGates(),
			},
			{ pi: h.pi },
			services,
		)

		expect(okText(result)).toContain("scoped and ready")
		expect(h.runtime.hasAfterScopeContinuation(h.fermentId)).toBe(false)
	})

	it("refuses scoping when agent self-flags a plan gate", async () => {
		const h = createHarness()
		const services = createServices()
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
				goal: "Ship the feature",
				phases: [{ name: "Build", goal: "Implement" }],
				gates: flaggedGates,
			},
			{ pi: h.pi },
			services,
		)

		expect(errText(result)).toContain("Gate P1")
		expect(errText(result)).toContain("no concrete verifier")
		expect(h.storage.get(h.fermentId)?.status).toBe("draft")
	})

	it("rejects scoping with a clear error when gate coverage is incomplete", async () => {
		const h = createHarness()
		const services = createServices()
		const incomplete = [{ id: "P1", verdict: "pass" as const, rationale: "ok", evidence: "n/a" }]

		const result = await scopeFerment(
			h.runtime,
			{
				ferment_id: h.fermentId,
				goal: "Ship the feature",
				phases: [{ name: "Build", goal: "Implement" }],
				gates: incomplete,
			},
			{ pi: h.pi },
			services,
		)

		expect(errText(result)).toContain("missing required gate verdicts")
		expect(errText(result)).toContain("P2")
		expect(errText(result)).toContain("P3")
		expect(h.storage.get(h.fermentId)?.status).toBe("draft")
	})

	it("keeps the interactive scoping confirmation gate (after gate validation)", async () => {
		const h = createHarness()
		h.runtime.markScopingInteractive(h.fermentId)
		const services = createServices()

		const result = await scopeFerment(
			h.runtime,
			{
				ferment_id: h.fermentId,
				goal: "Ship the feature",
				phases: [{ name: "Build", goal: "Implement" }],
				gates: passingPlanGates(),
			},
			{ pi: h.pi },
			services,
		)

		expect(errText(result)).toContain("waiting for user confirmation")
		expect(h.storage.get(h.fermentId)?.status).toBe("draft")
	})
})

describe("registerLifecycleTools", () => {
	it("registers create_ferment against the injected runtime storage", async () => {
		const storage = new FermentEventStore(mkdtempSync(join(tmpdir(), "ferment-lifecycle-registered-test-")))
		const runtime: FermentRuntime = {
			...createDefaultFermentRuntime(),
			getStorage: () => storage,
			setActive: vi.fn(),
		}
		const tools = new Map<string, RegisteredTool>()
		const pi = {
			registerTool: (tool: RegisteredTool) => {
				tools.set(tool.name, tool)
			},
			sendMessage: vi.fn(),
			appendEntry: vi.fn(),
			getActiveTools: vi.fn(() => ["read", "bash"]),
			getAllTools: vi.fn(() => [{ name: "read" }, { name: "bash" }, { name: "create_ferment" }]),
			setActiveTools: vi.fn(),
		} as unknown as ExtensionAPI
		registerLifecycleTools(pi, runtime)

		const createTool = tools.get("create_ferment")
		if (!createTool) throw new Error("create_ferment was not registered")
		const result = (await createTool.execute("test-call-id", {
			name: "Registered Lifecycle",
			description: "uses injected storage",
		})) as { content: { text: string }[]; isError?: boolean }

		expect(okText(result)).toContain('Created "Registered Lifecycle"')
		const created = storage.list().find((f) => f.name === "Registered Lifecycle")
		expect(created).toBeDefined()
		expect(runtime.setActive).toHaveBeenCalledWith(expect.objectContaining({ id: created?.id }))
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
		const services = createServices()

		const result = await completeFerment(
			h.runtime,
			{ ferment_id: h.fermentId, final_summary: "all done", gates: passingFermentGates() },
			services,
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
		const services = createServices()
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
			services,
		)

		expect(errText(result)).toContain("complete_ferment refused")
		expect(errText(result)).toContain("Gate C2")
		expect(h.storage.get(h.fermentId)?.status).not.toBe("complete")
	})

	it("rejects ship with a clear error when ferment gate coverage is incomplete", async () => {
		const h = createHarness()
		createTerminalFerment(h)
		const services = createServices()
		const incomplete = [{ id: "C1", verdict: "pass" as const, rationale: "ok", evidence: "n/a" }]

		const result = await completeFerment(
			h.runtime,
			{ ferment_id: h.fermentId, final_summary: "", gates: incomplete },
			services,
		)

		expect(errText(result)).toContain("missing required gate verdicts")
		expect(errText(result)).toContain("C2")
		expect(errText(result)).toContain("C3")
		expect(h.storage.get(h.fermentId)?.status).not.toBe("complete")
	})
})
