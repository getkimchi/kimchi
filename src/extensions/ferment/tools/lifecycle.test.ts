import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../../ferment/event-store.js"
import type { JudgeGrade } from "../../../ferment/types.js"
import type { PlanReview } from "../judge.js"
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
		judgePlan: vi.fn(async (): Promise<PlanReview> => {
			return { verdict: "approve", suggestions: [], confidence: 85, reasoning: "Plan is clear." }
		}),
		maybeInjectAutoNudge: vi.fn(),
		computeFermentGrade: vi.fn((): JudgeGrade => {
			return { grade: "A", rationale: "complete", gradedAt: "2026-01-01T00:00:00.000Z" }
		}),
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

beforeEach(() => {
	vi.restoreAllMocks()
})

describe("scopeFerment", () => {
	it("scopes with injected judge review and auto nudge", async () => {
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
			},
			{ pi: h.pi },
			services,
		)

		expect(okText(result)).toContain("Plan review: ✓ approved")
		expect(h.storage.get(h.fermentId)?.status).toBe("planned")
		expect(services.judgePlan).toHaveBeenCalledWith(
			"Lifecycle Test",
			"Ship the feature",
			"Tests pass",
			"Keep it small",
			expect.stringContaining("Build"),
		)
		expect(services.maybeInjectAutoNudge).toHaveBeenCalledWith(h.pi)
	})

	it("formats revision suggestions from injected judge review", async () => {
		const h = createHarness()
		const services = createServices({
			judgePlan: vi.fn(async (): Promise<PlanReview> => {
				return {
					verdict: "revise",
					suggestions: ["Add verification"],
					confidence: 70,
					reasoning: "Missing a concrete check.",
				}
			}),
		})

		const result = await scopeFerment(
			h.runtime,
			{
				ferment_id: h.fermentId,
				goal: "Ship the feature",
				phases: [{ name: "Build", goal: "Implement" }],
			},
			{ pi: h.pi },
			services,
		)

		expect(okText(result)).toContain("revision suggested")
		expect(okText(result)).toContain("Add verification")
	})

	it("keeps the interactive scoping confirmation gate", async () => {
		const h = createHarness()
		h.runtime.markScopingInteractive(h.fermentId)
		const services = createServices()

		const result = await scopeFerment(
			h.runtime,
			{
				ferment_id: h.fermentId,
				goal: "Ship the feature",
				phases: [{ name: "Build", goal: "Implement" }],
			},
			{ pi: h.pi },
			services,
		)

		expect(errText(result)).toContain("waiting for user confirmation")
		expect(h.storage.get(h.fermentId)?.status).toBe("draft")
		expect(services.judgePlan).not.toHaveBeenCalled()
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
	it("uses injected grading and clears runtime state", () => {
		const h = createHarness()
		createTerminalFerment(h)
		const clearFermentState = vi.fn()
		const setActive = vi.fn()
		h.runtime.clearFermentState = clearFermentState
		h.runtime.setActive = setActive
		const services = createServices()

		const result = completeFerment(h.runtime, { ferment_id: h.fermentId, final_summary: "all done" }, services)

		expect(okText(result)).toContain("Overall Grade: A")
		expect(h.storage.get(h.fermentId)?.status).toBe("complete")
		expect(h.storage.get(h.fermentId)?.grade?.grade).toBe("A")
		expect(services.computeFermentGrade).toHaveBeenCalledWith(
			expect.arrayContaining([expect.objectContaining({ id: "phase-1" })]),
		)
		expect(clearFermentState).toHaveBeenCalledWith(h.fermentId)
		expect(setActive).toHaveBeenCalledWith(undefined)
	})
})
