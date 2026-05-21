/**
 * Tool-handler integration tests.
 *
 * These tests register the ferment tools against a mock ExtensionAPI, isolate
 * storage to a temp directory, and exercise the public tool surface (the same
 * surface the LLM sees). They're the safety net for the state-machine refactor:
 * any change to tool logic or storage must keep these passing.
 *
 * Tests are organized by tool, covering happy paths and the error contracts
 * that the state machine extraction will formalize.
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../ferment/event-store.js"
import { FermentStorage, clearFermentCache } from "../../ferment/store.js"
import type { Ferment } from "../../ferment/types.js"
import { type FermentRuntime, createDefaultFermentRuntime } from "./runtime.js"
import { clearAllPendingScopes, getPendingScope, setPendingScope } from "./scoping.js"
import {
	clearAllScopingGates,
	clearAllStepStarts,
	getActive,
	markScopingConfirmed,
	markScopingInteractive,
	setActive,
} from "./state.js"

// Mock the judge module so the integration tests don't depend on a live LLM
// endpoint. After the gate-registry migration, judgeStepVerification is the
// only LLM-as-judge call left — invoked tactically when a step's verify
// command exits non-zero. Stub it to "fail" so tests that don't exercise that
// path get deterministic behaviour.
vi.mock("./judge.js", async () => {
	const actual = await vi.importActual<typeof import("./judge.js")>("./judge.js")
	return {
		...actual,
		judgeStepVerification: vi.fn(async () => ({ verdict: "fail" as const, reason: "stub" })),
		judgeJourneyGrade: vi.fn(async () => ({
			ok: true as const,
			grade: "A" as const,
			rationale: "Clean delivery; gates substantiated.",
		})),
	}
})
import { pr_dim } from "./colors.js"
import { registerKnowledgeTools } from "./tools/knowledge.js"
import { registerLifecycleTools } from "./tools/lifecycle.js"
import { registerPhaseTools } from "./tools/phases.js"
import { registerStepTools } from "./tools/steps.js"

// ─── Test harness ─────────────────────────────────────────────────────────────

interface RegisteredTool {
	name: string
	// biome-ignore lint/suspicious/noExplicitAny: mock harness
	execute: (toolCallId: string, params: any, signal?: AbortSignal, onUpdate?: any, ctx?: any) => Promise<any>
}

interface ToolResult {
	content: { type: string; text: string }[]
	isError?: boolean
}

interface Harness {
	storage: FermentStorage
	runtime: FermentRuntime
	tempDir: string
	tools: Map<string, RegisteredTool>
	pi: ExtensionAPI
	call: (toolName: string, params: unknown, ctx?: unknown) => Promise<ToolResult>
}

function createHarness(): Harness {
	const tempDir = mkdtempSync(join(tmpdir(), "ferment-tools-test-"))
	const storage = new FermentStorage(tempDir)
	const eventStorage = new FermentEventStore(tempDir)
	const runtime = { ...createDefaultFermentRuntime(), getStorage: () => eventStorage }
	const tools = new Map<string, RegisteredTool>()

	// Mock pi: only what the tool factories actually call.
	const pi = {
		registerTool: (tool: RegisteredTool) => {
			tools.set(tool.name, tool)
		},
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
		appendEntry: vi.fn(),
		getActiveTools: vi.fn(() => ["read", "bash", "complete_ferment"]),
		getAllTools: vi.fn(() => [{ name: "read" }, { name: "bash" }, { name: "complete_ferment" }]),
		setActiveTools: vi.fn(),
	} as unknown as ExtensionAPI

	registerLifecycleTools(pi, runtime)
	registerPhaseTools(pi, runtime)
	registerStepTools(pi, runtime)
	registerKnowledgeTools(pi, runtime)

	const call = async (toolName: string, params: unknown, ctx?: unknown): Promise<ToolResult> => {
		const tool = tools.get(toolName)
		if (!tool) throw new Error(`Tool not found: ${toolName}`)
		const result = await tool.execute("test-call-id", params, undefined, undefined, ctx)
		return result as ToolResult
	}

	return { storage, runtime, tempDir, tools, pi, call }
}

// Helpers for asserting on tool results.
function ok(result: ToolResult): string {
	if (result.isError) {
		throw new Error(`Expected ok, got error: ${result.content[0]?.text}`)
	}
	return result.content.map((c) => c.text).join("\n")
}

function err(result: ToolResult): string {
	if (!result.isError) {
		throw new Error(`Expected error, got ok: ${result.content[0]?.text}`)
	}
	return result.content.map((c) => c.text).join("\n")
}

// ─── Test setup ───────────────────────────────────────────────────────────────

let h: Harness

beforeEach(() => {
	h = createHarness()
	clearFermentCache()
	clearAllStepStarts()
	clearAllScopingGates()
	clearAllPendingScopes()
	setActive(undefined)
})

afterEach(() => {
	clearFermentCache()
	clearAllStepStarts()
	clearAllScopingGates()
	clearAllPendingScopes()
	setActive(undefined)
})

// Gate verdict helpers — return a complete passing set for each scope so the
// strict assertGateCoverage check passes. Tests that need a "flag" verdict
// override individual entries inline.
const passingPlanGates = () => [
	{ id: "P1", verdict: "pass" as const, rationale: "ok", evidence: "n/a" },
	{ id: "P2", verdict: "pass" as const, rationale: "ok", evidence: "n/a" },
	{ id: "P3", verdict: "pass" as const, rationale: "ok", evidence: "n/a" },
]
const passingStepGates = () => [
	{ id: "S1", verdict: "pass" as const, rationale: "ok", evidence: "n/a" },
	{ id: "S2", verdict: "pass" as const, rationale: "ok", evidence: "n/a" },
	{ id: "S3", verdict: "pass" as const, rationale: "ok", evidence: "n/a" },
]
const passingPhaseGates = () => [
	{ id: "F1", verdict: "pass" as const, rationale: "ok", evidence: "n/a" },
	{ id: "F2", verdict: "pass" as const, rationale: "ok", evidence: "n/a" },
	{ id: "F3", verdict: "pass" as const, rationale: "ok", evidence: "n/a" },
]
const passingFermentGates = () => [
	{ id: "C1", verdict: "pass" as const, rationale: "ok", evidence: "n/a" },
	{ id: "C2", verdict: "pass" as const, rationale: "ok", evidence: "n/a" },
	{ id: "C3", verdict: "pass" as const, rationale: "ok", evidence: "n/a" },
]

// Helper: create a ferment via the tool, then return its id from the harness
// temp storage used by the registered tool runtime.
async function createFerment(name: string, description?: string): Promise<string> {
	const result = await h.call("create_ferment", { name, description })
	ok(result)
	const items = h.storage.list()
	const created = items.find((f) => f.name === name)
	if (!created) throw new Error(`Ferment "${name}" not found after create`)
	return created.id
}

async function scopeFerment(
	id: string,
	overrides: Partial<{ goal: string; success_criteria: string; constraints: string[]; phases: unknown[] }> = {},
): Promise<void> {
	// Bypass scoping gate — we test the gate explicitly below.
	markScopingInteractive(id)
	markScopingConfirmed(id)
	const params = {
		ferment_id: id,
		goal: overrides.goal ?? "Make a thing",
		success_criteria: overrides.success_criteria ?? "It works",
		constraints: overrides.constraints ?? [],
		phases: overrides.phases ?? [
			{
				name: "Phase A",
				goal: "Build A",
				steps: [{ description: "Step A1" }, { description: "Step A2" }],
			},
			{
				name: "Phase B",
				goal: "Build B",
				steps: [{ description: "Step B1" }],
			},
		],
		gates: passingPlanGates(),
	}
	const result = await h.call("scope_ferment", params)
	ok(result)
}

function loadFerment(id: string): Ferment {
	clearFermentCache()
	const f = h.storage.get(id)
	if (!f) throw new Error(`Ferment ${id} not found`)
	return f
}

// ─── create_ferment ───────────────────────────────────────────────────────────

describe("create_ferment", () => {
	it("creates a mode-less ferment in draft status", async () => {
		const id = await createFerment("Test Project")
		const f = loadFerment(id)
		expect(f.name).toBe("Test Project")
		expect(f.status).toBe("draft")
		expect(f).not.toHaveProperty("mode")
		expect(f.phases).toEqual([])
	})

	it("captures description when provided", async () => {
		const id = await createFerment("Described", "A description")
		expect(loadFerment(id).description).toBe("A description")
	})
})

// ─── list_ferments ────────────────────────────────────────────────────────────

describe("list_ferments", () => {
	it("lists all ferments when no filter", async () => {
		await createFerment("Alpha")
		setActive(undefined)
		await createFerment("Beta")
		const result = ok(await h.call("list_ferments", {}))
		expect(result).toContain("Alpha")
		expect(result).toContain("Beta")
	})

	it("filters by status", async () => {
		const alphaId = await createFerment("Alpha")
		setActive(undefined)
		await createFerment("Beta")
		// Move alpha to running
		const s = h.storage
		s.updateStatus(alphaId, "running")

		const result = ok(await h.call("list_ferments", { filter: "running" }))
		expect(result).toContain("Alpha")
		expect(result).not.toContain("Beta")
	})

	it("normalizes 'active' filter to 'running'", async () => {
		const id = await createFerment("Alpha")
		h.storage.updateStatus(id, "running")
		const result = ok(await h.call("list_ferments", { filter: "active" }))
		expect(result).toContain("Alpha")
	})

	it("returns empty message when filter matches nothing", async () => {
		await createFerment("Alpha")
		const result = ok(await h.call("list_ferments", { filter: "complete" }))
		expect(result).toContain("No ferments")
	})
})

// ─── scope_ferment ────────────────────────────────────────────────────────────

describe("scope_ferment", () => {
	it("transitions draft → planned with phases", async () => {
		const id = await createFerment("Scope Test")
		await scopeFerment(id)
		const f = loadFerment(id)
		expect(f.status).toBe("planned")
		expect(f.phases).toHaveLength(2)
		expect(f.phases[0].name).toBe("Phase A")
		expect(f.phases[0].steps).toHaveLength(2)
	})

	it("rejects when ferment is not in draft", async () => {
		const id = await createFerment("Already Scoped")
		await scopeFerment(id)
		// Try to scope again — should fail
		markScopingInteractive(id)
		markScopingConfirmed(id)
		const result = await h.call("scope_ferment", {
			ferment_id: id,
			goal: "Different goal",
			phases: [],
			gates: passingPlanGates(),
		})
		expect(err(result)).toMatch(/already planned/i)
	})

	it("blocks when scoping gate is active and not confirmed", async () => {
		const id = await createFerment("Gate Test")
		// Mark interactive but not confirmed
		markScopingInteractive(id)
		const result = await h.call("scope_ferment", {
			ferment_id: id,
			goal: "X",
			phases: [],
			gates: passingPlanGates(),
		})
		expect(err(result)).toMatch(/propose_ferment_scoping/i)
		expect(err(result)).toMatch(/do not call scope_ferment directly/i)
		expect(err(result)).not.toMatch(/present the plan summary/i)
	})

	it("does not let legacy mode bypass an interactive scoping gate", async () => {
		const id = await createFerment("Exec Gate Test")
		h.storage.updateMode(id, "exec")
		markScopingInteractive(id)
		// Don't confirm — legacy mode is inert and cannot bypass this gate.
		const result = await h.call("scope_ferment", {
			ferment_id: id,
			goal: "X",
			phases: [{ name: "P1", goal: "G", steps: [{ description: "S" }] }],
			gates: passingPlanGates(),
		})
		expect(err(result)).toMatch(/propose_ferment_scoping/i)
		expect(err(result)).toMatch(/do not call scope_ferment directly/i)
	})

	it("returns error when ferment not found", async () => {
		markScopingConfirmed("nonexistent")
		const result = await h.call("scope_ferment", {
			ferment_id: "nonexistent",
			goal: "X",
			phases: [],
			gates: passingPlanGates(),
		})
		expect(err(result)).toMatch(/not found/i)
	})

	it("captures parallel_group on phases", async () => {
		const id = await createFerment("Parallel Test")
		await scopeFerment(id, {
			phases: [
				{ name: "P1", goal: "G1", parallel_group: 1, steps: [{ description: "S1" }] },
				{ name: "P2", goal: "G2", parallel_group: 1, steps: [{ description: "S2" }] },
				{ name: "P3", goal: "G3", steps: [{ description: "S3" }] },
			],
		})
		const f = loadFerment(id)
		expect(f.phases[0].groupIndex).toBe(1)
		expect(f.phases[1].groupIndex).toBe(1)
		expect(f.phases[2].groupIndex).toBeUndefined()
	})
})

// ─── activate_ferment_phase ───────────────────────────────────────────────────────────

describe("activate_ferment_phase", () => {
	it("activates the first planned phase", async () => {
		const id = await createFerment("Activate Test")
		await scopeFerment(id)
		const result = ok(await h.call("activate_ferment_phase", { ferment_id: id, phase_id: "phase-1" }))
		expect(result).toContain("activated")
		expect(result).not.toContain("Ferment Specification")

		const f = loadFerment(id)
		expect(f.status).toBe("running")
		expect(f.phases[0].status).toBe("active")
		expect(f.activePhaseId).toBe("phase-1")
	})

	it("falls back to first planned phase if phase_id not given", async () => {
		const id = await createFerment("Fallback")
		await scopeFerment(id)
		ok(await h.call("activate_ferment_phase", { ferment_id: id }))
		expect(loadFerment(id).phases[0].status).toBe("active")
	})

	it("falls back to failed phase recovery before activating a planned phase", async () => {
		const id = await createFerment("Retry Fallback")
		await scopeFerment(id)
		ok(await h.call("activate_ferment_phase", { ferment_id: id, phase_id: "phase-1" }))
		ok(await h.call("fail_ferment_phase", { ferment_id: id, phase_id: "phase-1", reason: "tests failed" }))

		ok(await h.call("activate_ferment_phase", { ferment_id: id }))

		const f = loadFerment(id)
		expect(f.phases[0].status).toBe("active")
		expect(f.phases[1].status).toBe("planned")
		expect(f.activePhaseId).toBe("phase-1")
	})

	it("activates all phases in a parallel group", async () => {
		const id = await createFerment("Parallel Activate")
		await scopeFerment(id, {
			phases: [
				{ name: "P1", goal: "G1", parallel_group: 1, steps: [{ description: "S1" }] },
				{ name: "P2", goal: "G2", parallel_group: 1, steps: [{ description: "S2" }] },
				{ name: "P3", goal: "G3", steps: [{ description: "S3" }] },
			],
		})
		const result = ok(await h.call("activate_ferment_phase", { ferment_id: id, phase_id: "phase-1" }))
		expect(result).toContain("Parallel group")
		expect(result).not.toContain("Ferment Specification")

		const f = loadFerment(id)
		expect(f.phases[0].status).toBe("active")
		expect(f.phases[1].status).toBe("active")
		expect(f.phases[2].status).toBe("planned")
	})

	it("fails when no planned phases remain", async () => {
		const id = await createFerment("None Left")
		await scopeFerment(id)
		// Skip both phases manually
		const s = h.storage
		s.skipPhase(id, "phase-1", "skip")
		s.skipPhase(id, "phase-2", "skip")

		const result = await h.call("activate_ferment_phase", { ferment_id: id })
		expect(err(result)).toMatch(/no planned or failed phases/i)
	})

	it("returns error when ferment not found", async () => {
		const result = await h.call("activate_ferment_phase", { ferment_id: "nope" })
		expect(err(result)).toMatch(/not found/i)
	})
})

// ─── refine_ferment_phase ─────────────────────────────────────────────────────────────

describe("refine_ferment_phase", () => {
	it("replaces steps on an active phase", async () => {
		const id = await createFerment("Refine Test")
		await scopeFerment(id)
		ok(await h.call("activate_ferment_phase", { ferment_id: id, phase_id: "phase-1" }))

		ok(
			await h.call("refine_ferment_phase", {
				ferment_id: id,
				phase_id: "phase-1",
				steps: [
					{ description: "New step 1" },
					{ description: "New step 2", verify: "echo ok" },
					{ description: "New step 3" },
				],
			}),
		)

		const f = loadFerment(id)
		const phase = f.phases[0]
		expect(phase.steps).toHaveLength(3)
		expect(phase.steps[0].description).toBe("New step 1")
		expect(phase.steps[1].verification?.command).toBe("echo ok")
	})

	it("rejects when phase is not active", async () => {
		const id = await createFerment("Inactive Refine")
		await scopeFerment(id)
		// phase-1 is still in 'planned' status
		const result = await h.call("refine_ferment_phase", {
			ferment_id: id,
			phase_id: "phase-1",
			steps: [{ description: "X" }],
		})
		expect(err(result)).toMatch(/must be active/i)
	})
})

// ─── start_ferment_step ───────────────────────────────────────────────────────────────

describe("start_ferment_step", () => {
	async function setupActivePhase(): Promise<string> {
		const id = await createFerment("Start Step Test")
		await scopeFerment(id)
		ok(await h.call("activate_ferment_phase", { ferment_id: id, phase_id: "phase-1" }))
		return id
	}

	it("transitions step from pending → running", async () => {
		const id = await setupActivePhase()
		ok(await h.call("start_ferment_step", { ferment_id: id, phase_id: "phase-1", step_id: "step-1" }))
		expect(loadFerment(id).phases[0].steps[0].status).toBe("running")
	})

	it("rejects starting a step when a non-parallel step is already running", async () => {
		const id = await setupActivePhase()
		ok(await h.call("start_ferment_step", { ferment_id: id, phase_id: "phase-1", step_id: "step-1" }))
		const result = await h.call("start_ferment_step", { ferment_id: id, phase_id: "phase-1", step_id: "step-2" })
		expect(err(result)).toMatch(/already running/i)
	})

	it("blocks after 3 consecutive starts (stuck-loop detection)", async () => {
		const id = await setupActivePhase()
		ok(await h.call("start_ferment_step", { ferment_id: id, phase_id: "phase-1", step_id: "step-1" }))
		ok(await h.call("start_ferment_step", { ferment_id: id, phase_id: "phase-1", step_id: "step-1" }))
		const result = await h.call("start_ferment_step", { ferment_id: id, phase_id: "phase-1", step_id: "step-1" })
		expect(err(result)).toMatch(/Stuck loop detected/i)
	})

	it("lets the user skip directly from the stuck-loop prompt", async () => {
		const id = await setupActivePhase()
		ok(await h.call("start_ferment_step", { ferment_id: id, phase_id: "phase-1", step_id: "step-1" }))
		ok(await h.call("start_ferment_step", { ferment_id: id, phase_id: "phase-1", step_id: "step-1" }))

		const ctx = {
			ui: {
				select: vi.fn().mockResolvedValue("Skip step"),
			},
		}
		const result = await h.call("start_ferment_step", { ferment_id: id, phase_id: "phase-1", step_id: "step-1" }, ctx)

		expect(ok(result)).toMatch(/skipped at user request/i)
		expect(ctx.ui.select).toHaveBeenCalledWith(expect.stringContaining("has been started 3 times"), [
			"Retry",
			"Skip step",
			"Pause ferment",
		])
		expect(loadFerment(id).phases[0].steps[0].status).toBe("skipped")
	})

	it("lets the user pause directly from the stuck-loop prompt", async () => {
		const id = await setupActivePhase()
		ok(await h.call("start_ferment_step", { ferment_id: id, phase_id: "phase-1", step_id: "step-1" }))
		ok(await h.call("start_ferment_step", { ferment_id: id, phase_id: "phase-1", step_id: "step-1" }))

		const ctx = {
			ui: {
				select: vi.fn().mockResolvedValue("Pause ferment"),
			},
		}
		const result = await h.call("start_ferment_step", { ferment_id: id, phase_id: "phase-1", step_id: "step-1" }, ctx)

		expect(ok(result)).toMatch(/paused at user request/i)
		expect(loadFerment(id).status).toBe("paused")
	})

	it("lets the user retry from the stuck-loop prompt after clearing the counter", async () => {
		const id = await setupActivePhase()
		ok(await h.call("start_ferment_step", { ferment_id: id, phase_id: "phase-1", step_id: "step-1" }))
		ok(await h.call("start_ferment_step", { ferment_id: id, phase_id: "phase-1", step_id: "step-1" }))

		const ctx = {
			ui: {
				select: vi.fn().mockResolvedValue("Retry"),
			},
		}
		const result = await h.call("start_ferment_step", { ferment_id: id, phase_id: "phase-1", step_id: "step-1" }, ctx)

		expect(ok(result)).toMatch(/Step 1: "Step A1" started/)
		expect(loadFerment(id).phases[0].steps[0].status).toBe("running")
		const nextResult = await h.call("start_ferment_step", { ferment_id: id, phase_id: "phase-1", step_id: "step-1" })
		expect(ok(nextResult)).toMatch(/Step 1: "Step A1" started/)
	})

	it("returns step not found for invalid step_id", async () => {
		const id = await setupActivePhase()
		const result = await h.call("start_ferment_step", { ferment_id: id, phase_id: "phase-1", step_id: "step-999" })
		expect(err(result)).toMatch(/not found/i)
	})
})

// ─── complete_ferment_step ────────────────────────────────────────────────────────────

describe("complete_ferment_step", () => {
	async function setupRunningStep(): Promise<string> {
		const id = await createFerment("Complete Step Test")
		await scopeFerment(id, {
			phases: [
				{
					name: "Phase A",
					goal: "Build",
					steps: [{ description: "S1" }, { description: "S2" }],
				},
			],
		})
		ok(await h.call("activate_ferment_phase", { ferment_id: id, phase_id: "phase-1" }))
		ok(await h.call("start_ferment_step", { ferment_id: id, phase_id: "phase-1", step_id: "step-1" }))
		return id
	}

	it("transitions step from running → done (no verification)", async () => {
		const id = await setupRunningStep()
		ok(
			await h.call("complete_ferment_step", {
				ferment_id: id,
				phase_id: "phase-1",
				step_id: "step-1",
				summary: "did it",
				gates: passingStepGates(),
			}),
		)
		expect(loadFerment(id).phases[0].steps[0].status).toBe("done")
	})

	it("records summary in step result", async () => {
		const id = await setupRunningStep()
		await h.call("complete_ferment_step", {
			ferment_id: id,
			phase_id: "phase-1",
			step_id: "step-1",
			summary: "summary text",
			gates: passingStepGates(),
		})
		// Step grading no longer happens at complete_ferment_step (gates replace grades),
		// so step.grade is undefined; the summary itself is what we verify here.
		const step = loadFerment(id).phases[0].steps[0]
		expect(step.summary).toBe("summary text")
	})

	it("rejects when step does not exist", async () => {
		const id = await setupRunningStep()
		const result = await h.call("complete_ferment_step", {
			ferment_id: id,
			phase_id: "phase-1",
			step_id: "step-999",
			gates: passingStepGates(),
		})
		expect(err(result)).toMatch(/not found/i)
	})
})

// ─── skip_ferment_step ────────────────────────────────────────────────────────────────

describe("skip_ferment_step", () => {
	it("marks step as skipped", async () => {
		const id = await createFerment("Skip Step Test")
		await scopeFerment(id)
		ok(await h.call("activate_ferment_phase", { ferment_id: id, phase_id: "phase-1" }))
		ok(await h.call("skip_ferment_step", { ferment_id: id, phase_id: "phase-1", step_id: "step-1" }))
		expect(loadFerment(id).phases[0].steps[0].status).toBe("skipped")
	})
})

// ─── fail_ferment_step ────────────────────────────────────────────────────────────────

describe("fail_ferment_step", () => {
	it("marks step as failed with error message", async () => {
		const id = await createFerment("Fail Step Test")
		await scopeFerment(id)
		ok(await h.call("activate_ferment_phase", { ferment_id: id, phase_id: "phase-1" }))
		ok(
			await h.call("fail_ferment_step", {
				ferment_id: id,
				phase_id: "phase-1",
				step_id: "step-1",
				error: "broken",
			}),
		)
		const step = loadFerment(id).phases[0].steps[0]
		expect(step.status).toBe("failed")
		expect(step.result?.stderr).toBe("broken")
	})
})

// ─── complete_ferment_phase ───────────────────────────────────────────────────────────

describe("complete_ferment_phase", () => {
	async function setupAllStepsTerminal(): Promise<string> {
		const id = await createFerment("Complete Phase Test")
		await scopeFerment(id)
		ok(await h.call("activate_ferment_phase", { ferment_id: id, phase_id: "phase-1" }))
		// Complete both steps in phase 1
		ok(await h.call("start_ferment_step", { ferment_id: id, phase_id: "phase-1", step_id: "step-1" }))
		ok(
			await h.call("complete_ferment_step", {
				ferment_id: id,
				phase_id: "phase-1",
				step_id: "step-1",
				summary: "done",
				gates: passingStepGates(),
			}),
		)
		ok(await h.call("start_ferment_step", { ferment_id: id, phase_id: "phase-1", step_id: "step-2" }))
		ok(
			await h.call("complete_ferment_step", {
				ferment_id: id,
				phase_id: "phase-1",
				step_id: "step-2",
				summary: "done",
				gates: passingStepGates(),
			}),
		)
		return id
	}

	it("transitions phase from active → completed", async () => {
		const id = await setupAllStepsTerminal()
		ok(
			await h.call("complete_ferment_phase", {
				ferment_id: id,
				phase_id: "phase-1",
				summary: "phase done",
				gates: passingPhaseGates(),
			}),
		)
		const f = loadFerment(id)
		expect(f.phases[0].status).toBe("completed")
		expect(f.phases[0].summary).toBe("phase done")
	})

	it("does NOT assign a per-phase grade — grading is now journey-only at complete_ferment", async () => {
		const id = await setupAllStepsTerminal()
		ok(
			await h.call("complete_ferment_phase", {
				ferment_id: id,
				phase_id: "phase-1",
				summary: "phase done",
				gates: passingPhaseGates(),
			}),
		)
		// Per-phase grading was removed: the only letter grade lives on
		// ferment.grade after the journey-grade judge runs at complete_ferment.
		expect(loadFerment(id).phases[0].grade).toBeUndefined()
	})
})

// ─── skip_ferment_phase ───────────────────────────────────────────────────────────────

describe("skip_ferment_phase", () => {
	it("marks phase as skipped", async () => {
		const id = await createFerment("Skip Phase Test")
		await scopeFerment(id)
		h.runtime.setContinuationPolicy("automated")
		ok(
			await h.call("skip_ferment_phase", {
				ferment_id: id,
				phase_id: "phase-1",
				reason: "not needed",
			}),
		)
		const f = loadFerment(id)
		expect(f.phases[0].status).toBe("skipped")
		expect(f.phases[0].summary).toBe("not needed")
	})

	it("manual policy pauses after skipping a phase boundary", async () => {
		const id = await createFerment("Manual Skip Phase Test")
		await scopeFerment(id)
		h.runtime.setContinuationPolicy("manual")

		const text = ok(
			await h.call("skip_ferment_phase", {
				ferment_id: id,
				phase_id: "phase-1",
				reason: "not needed",
			}),
		)

		expect(text).toContain("Manual continuation policy stopped here")
		expect(text).toContain('Next: "Phase B"')
		expect(text).not.toContain("Next action: call `activate_ferment_phase`")
		const f = loadFerment(id)
		expect(f.status).toBe("paused")
		expect(f.phases[0].status).toBe("skipped")
		expect(f.phases[1].status).toBe("planned")
		expect(f.activePhaseId).toBeUndefined()
	})

	it("manual policy can continue after skipping a phase boundary when user chooses continue", async () => {
		const id = await createFerment("Manual Skip Continue Test")
		await scopeFerment(id)
		h.runtime.setContinuationPolicy("manual")
		const select = vi.fn(async () => "Continue to next phase")

		const text = ok(
			await h.call(
				"skip_ferment_phase",
				{
					ferment_id: id,
					phase_id: "phase-1",
					reason: "not needed",
				},
				{ ui: { select } },
			),
		)

		expect(select).toHaveBeenCalledWith(
			'Phase "Phase A" skipped.\nContinue "Manual Skip Continue Test" to "Phase B"?',
			["Continue to next phase", "Pause here"],
		)
		expect(text).toContain("User chose to continue to the next phase")
		expect(text).toContain("Next action: call `activate_ferment_phase`")
		const f = loadFerment(id)
		expect(f.status).toBe("planned")
		expect(f.phases[0].status).toBe("skipped")
		expect(f.phases[1].status).toBe("planned")
		expect(f.activePhaseId).toBeUndefined()
	})
})

// ─── fail_ferment_phase ───────────────────────────────────────────────────────────────

describe("fail_ferment_phase", () => {
	it("marks phase as failed with reason", async () => {
		const id = await createFerment("Fail Phase Test")
		await scopeFerment(id)
		ok(await h.call("activate_ferment_phase", { ferment_id: id, phase_id: "phase-1" }))
		ok(
			await h.call("fail_ferment_phase", {
				ferment_id: id,
				phase_id: "phase-1",
				reason: "tests don't pass",
			}),
		)
		expect(loadFerment(id).phases[0].status).toBe("failed")
	})
})

// ─── complete_ferment ─────────────────────────────────────────────────────────

describe("complete_ferment", () => {
	it("rejects when phases are still planned or active", async () => {
		const id = await createFerment("Incomplete Test")
		await scopeFerment(id)
		const result = await h.call("complete_ferment", { ferment_id: id, gates: passingFermentGates() })
		expect(err(result)).toMatch(/still active or planned/i)
	})

	it("completes when all phases are terminal", async () => {
		const id = await createFerment("Done Test")
		await scopeFerment(id)
		expect(getActive()?.id).toBe(id)
		expect(process.env.KIMCHI_ACTIVE_FERMENT).toBe(id)
		const s = h.storage
		s.skipPhase(id, "phase-1", "skipped")
		s.skipPhase(id, "phase-2", "skipped")
		ok(
			await h.call("complete_ferment", {
				ferment_id: id,
				final_summary: "all done",
				gates: passingFermentGates(),
			}),
		)
		expect(loadFerment(id).status).toBe("complete")
		expect(getActive()).toBeUndefined()
		expect(process.env.KIMCHI_ACTIVE_FERMENT).toBeUndefined()
	})

	it("computes overall grade from phase grades", async () => {
		const id = await createFerment("Graded Test")
		await scopeFerment(id)
		const s = h.storage
		s.activatePhase(id, "phase-1")
		s.completePhase(id, "phase-1", "ok")
		s.setPhaseGrade(id, "phase-1", { grade: "A", rationale: "good", gradedAt: new Date().toISOString() })
		s.skipPhase(id, "phase-2", "skip")
		ok(await h.call("complete_ferment", { ferment_id: id, gates: passingFermentGates() }))
		expect(loadFerment(id).grade).toBeDefined()
	})
})

// ─── active ferment env propagation ───────────────────────────────────────────

describe("active ferment environment", () => {
	it("deletes KIMCHI_ACTIVE_FERMENT when active ferment is cleared", async () => {
		const id = await createFerment("Env Clear Test")
		expect(process.env.KIMCHI_ACTIVE_FERMENT).toBe(id)

		setActive(undefined)

		expect(getActive()).toBeUndefined()
		expect(process.env.KIMCHI_ACTIVE_FERMENT).toBeUndefined()
		expect(Object.hasOwn(process.env, "KIMCHI_ACTIVE_FERMENT")).toBe(false)
	})

	it("does not expose terminal ferments as resumable active work", async () => {
		const id = await createFerment("Terminal Env Test")
		await scopeFerment(id)
		const s = h.storage
		s.skipPhase(id, "phase-1", "skipped")
		s.skipPhase(id, "phase-2", "skipped")
		ok(await h.call("complete_ferment", { ferment_id: id, gates: passingFermentGates() }))

		const terminal = loadFerment(id)
		setActive(terminal)

		expect(getActive()?.id).toBe(id)
		expect(terminal.status).toBe("complete")
		expect(process.env.KIMCHI_ACTIVE_FERMENT).toBeUndefined()
	})
})

// ─── add_ferment_decision ─────────────────────────────────────────────────────────────

describe("add_ferment_decision", () => {
	it("appends a decision to the ferment", async () => {
		const id = await createFerment("Decision Test")
		await scopeFerment(id)
		ok(
			await h.call("add_ferment_decision", {
				ferment_id: id,
				title: "Use SQLite",
				description: "Faster than JSON",
			}),
		)
		const f = loadFerment(id)
		expect(f.decisions).toHaveLength(1)
		expect(f.decisions[0].title).toBe("Use SQLite")
		expect(f.decisions[0].id).toBe("D001")
	})

	it("assigns sequential ids", async () => {
		const id = await createFerment("Sequential Test")
		await scopeFerment(id)
		await h.call("add_ferment_decision", { ferment_id: id, title: "First", description: "x" })
		await h.call("add_ferment_decision", { ferment_id: id, title: "Second", description: "y" })
		const f = loadFerment(id)
		expect(f.decisions[0].id).toBe("D001")
		expect(f.decisions[1].id).toBe("D002")
	})
})

// ─── add_ferment_memory ───────────────────────────────────────────────────────────────

describe("add_ferment_memory", () => {
	it("appends a memory with valid category", async () => {
		const id = await createFerment("Memory Test")
		await scopeFerment(id)
		ok(
			await h.call("add_ferment_memory", {
				ferment_id: id,
				category: "gotcha",
				content: "Watch out for X",
			}),
		)
		const f = loadFerment(id)
		expect(f.memories).toHaveLength(1)
		expect(f.memories[0].category).toBe("gotcha")
	})

	it("rejects invalid categories", async () => {
		const id = await createFerment("Invalid Category Test")
		await scopeFerment(id)
		const result = await h.call("add_ferment_memory", {
			ferment_id: id,
			category: "not-a-category",
			content: "X",
		})
		expect(err(result)).toMatch(/invalid category/i)
	})
})

// ─── retired mode tool ────────────────────────────────────────────────────────

describe("retired mode tool", () => {
	it("does not expose set_ferment_mode on the tool surface", () => {
		expect(h.tools.has("set_ferment_mode")).toBe(false)
	})
})

// ─── update_ferment_scope_field ───────────────────────────────────────────────────────

describe("update_ferment_scope_field", () => {
	it("updates the goal field", async () => {
		const id = await createFerment("Update Test")
		await scopeFerment(id, { goal: "Original" })
		ok(
			await h.call("update_ferment_scope_field", {
				ferment_id: id,
				field: "goal",
				value: "Updated goal",
			}),
		)
		expect(loadFerment(id).goal).toBe("Updated goal")
	})

	it("updates constraints (parses comma-separated)", async () => {
		const id = await createFerment("Constraints Update")
		await scopeFerment(id)
		ok(
			await h.call("update_ferment_scope_field", {
				ferment_id: id,
				field: "constraints",
				value: "no libs, must be fast",
			}),
		)
		expect(loadFerment(id).constraints).toEqual(["no libs", "must be fast"])
	})

	it("rejects unknown field names", async () => {
		const id = await createFerment("Unknown Field Test")
		const result = await h.call("update_ferment_scope_field", {
			ferment_id: id,
			field: "bogus",
			value: "x",
		})
		expect(err(result)).toMatch(/unknown field/i)
	})
})

// ─── pause-blocks-tool-calls (state machine enforcement) ─────────────────────

describe("paused ferment blocks tool calls at the bridge", () => {
	async function setupPaused(): Promise<string> {
		const id = await createFerment("Paused Test")
		await scopeFerment(id)
		ok(await h.call("activate_ferment_phase", { ferment_id: id, phase_id: "phase-1" }))
		// Flip to paused via storage; here we just need bridge-level enforcement
		// for an already-paused ferment.
		const s = h.storage
		s.updateStatus(id, "paused")
		clearFermentCache()
		return id
	}

	it("refuses start_ferment_step when ferment is paused", async () => {
		const id = await setupPaused()
		const result = await h.call("start_ferment_step", {
			ferment_id: id,
			phase_id: "phase-1",
			step_id: "step-1",
		})
		expect(err(result)).toMatch(/paused/i)
	})

	it("refuses activate_ferment_phase when ferment is paused", async () => {
		const id = await setupPaused()
		const result = await h.call("activate_ferment_phase", { ferment_id: id, phase_id: "phase-2" })
		expect(err(result)).toMatch(/paused/i)
	})

	it("refuses complete_ferment_step when ferment is paused", async () => {
		const id = await setupPaused()
		const result = await h.call("complete_ferment_step", {
			ferment_id: id,
			phase_id: "phase-1",
			step_id: "step-1",
			summary: "x",
			gates: passingStepGates(),
		})
		expect(err(result)).toMatch(/paused/i)
	})

	it("refuses add_ferment_decision when ferment is paused", async () => {
		const id = await setupPaused()
		const result = await h.call("add_ferment_decision", {
			ferment_id: id,
			title: "Decision while paused",
			description: "should be rejected",
		})
		expect(err(result)).toMatch(/paused/i)
	})
})

// ─── propose_ferment_scoping ──────────────────────────────────────────────────────────

describe("propose_ferment_scoping", () => {
	const threePhases = [
		{ name: "P1", goal: "g1", steps: [{ description: "s1" }] },
		{ name: "P2", goal: "g2", steps: [{ description: "s2" }] },
		{ name: "P3", goal: "g3", steps: [{ description: "s3" }] },
	]

	const basePayload = (ferment_id: string, overrides: Record<string, unknown> = {}) => ({
		ferment_id,
		goal: "Build a thing",
		success_criteria: "Tests pass",
		constraints: ["no breaking changes"],
		assumptions: "API is stable",
		phases: threePhases,
		gates: passingPlanGates(),
		...overrides,
	})

	// Helper: seed a pending scope so propose_ferment_scoping can replace it.
	function seedPending(id: string) {
		setPendingScope(id, { goal: "", successCriteria: "", constraints: [] })
		markScopingInteractive(id)
	}

	// (a) zero-questions + Continue → planned
	it("(a) zero-questions + Continue → ferment becomes planned", async () => {
		const id = await createFerment("ZeroQ Continue")
		seedPending(id)
		const ctx = { ui: { select: vi.fn().mockResolvedValue("Start execution  ✓"), input: vi.fn() } }

		const result = ok(await h.call("propose_ferment_scoping", basePayload(id), ctx))

		const f = loadFerment(id)
		expect(f.status).toBe("planned")
		expect(f.phases).toHaveLength(3)
		expect(f.scoping?.assumptions?.answer).toBe("API is stable")
		expect(getPendingScope(id)).toBeUndefined()
		expect(result).toContain("Plan saved")
		expect(result).toContain("Here is the proposed plan")
		expect(result).toContain("# Plan:")
		expect(ctx.ui.select).toHaveBeenCalledWith(expect.stringContaining("# Plan:"), expect.any(Array))
	})

	it("normalizes stringified phases before rendering the plan UI", async () => {
		const id = await createFerment("Stringified")
		seedPending(id)
		const ctx = {
			ui: {
				select: vi.fn().mockResolvedValueOnce("Start execution  ✓"),
				input: vi.fn(),
			},
		}

		const result = ok(
			await h.call(
				"propose_ferment_scoping",
				basePayload(id, {
					assumptions: JSON.stringify(["A web app exists", "Local-first is acceptable"]),
					constraints: "no backend",
					phases: JSON.stringify(threePhases),
				}),
				ctx,
			),
		)

		const f = loadFerment(id)
		expect(f.status).toBe("planned")
		expect(f.phases).toHaveLength(3)
		expect(f.scoping?.assumptions?.answer).toBe("A web app exists; Local-first is acceptable")
		expect(result).toContain("Plan saved")
		expect(result).toContain("## Constraints")
		expect(result).toContain("- no backend")
		expect(result).toContain("Here is the proposed plan")
	})

	it("normalizes assumption arrays before persisting a proposed scope", async () => {
		const id = await createFerment("Array Assumptions")
		seedPending(id)
		const ctx = { ui: { select: vi.fn().mockResolvedValue("Start execution  ✓"), input: vi.fn() } }

		const result = ok(
			await h.call(
				"propose_ferment_scoping",
				basePayload(id, {
					assumptions: ["Go toolchain is installed", "The current directory is writable"],
				}),
				ctx,
			),
		)

		const f = loadFerment(id)
		expect(f.status).toBe("planned")
		expect(f.scoping?.assumptions?.answer).toBe("Go toolchain is installed; The current directory is writable")
		expect(result).toContain("Plan saved")
		expect(result).toContain("- Go toolchain is installed")
		expect(result).toContain("- The current directory is writable")
	})

	it("normalizes string-array assumptions before rendering the plan UI", async () => {
		const id = await createFerment("AssumptionArray")
		seedPending(id)
		const ctx = { ui: { select: vi.fn().mockResolvedValue("Start execution  ✓"), input: vi.fn() } }

		const result = ok(
			await h.call(
				"propose_ferment_scoping",
				basePayload(id, {
					assumptions: ["Browser-based web app", "No auth needed", "Standard TODO UX is acceptable"],
				}),
				ctx,
			),
		)

		const f = loadFerment(id)
		expect(f.status).toBe("planned")
		expect(f.scoping?.assumptions?.answer).toBe("Browser-based web app; No auth needed; Standard TODO UX is acceptable")
		expect(result).toContain("## Assumptions")
		expect(result).toContain("Browser-based web app")
		expect(result).toContain("Standard TODO UX is acceptable")
	})

	it("treats duplicate propose_ferment_scoping after plan save as a no-op", async () => {
		const id = await createFerment("DuplicatePropose")
		seedPending(id)
		const ctx = { ui: { select: vi.fn().mockResolvedValue("Start execution  ✓"), input: vi.fn() } }

		ok(await h.call("propose_ferment_scoping", basePayload(id), ctx))
		const second = ok(await h.call("propose_ferment_scoping", basePayload(id), ctx))

		expect(second).toContain("already planned")
		expect(second).toContain("activate_ferment_phase")
		expect(loadFerment(id).status).toBe("planned")
	})

	it("normalizes fenced JSON array strings for phases", async () => {
		const id = await createFerment("FencedJson")
		seedPending(id)
		const ctx = {
			ui: {
				select: vi.fn().mockResolvedValueOnce("Start execution  ✓"),
				input: vi.fn(),
			},
		}

		const result = ok(
			await h.call(
				"propose_ferment_scoping",
				basePayload(id, {
					constraints: ["- preserve data"],
					phases: `Here is the plan:\n\`\`\`json\n${JSON.stringify(threePhases)}\n\`\`\``,
				}),
				ctx,
			),
		)

		const f = loadFerment(id)
		expect(f.status).toBe("planned")
		expect(f.phases).toHaveLength(3)
		expect(result).toContain("- preserve data")
		expect(result).not.toContain("- - preserve data")
	})

	// (b) with questions + all recommended picks → draft, sendMessage asks agent to replan
	it("(b) with questions + all recommended picks → draft status, sendMessage asks for final plan", async () => {
		const id = await createFerment("WithQ Continue")
		seedPending(id)
		const questions = [
			{
				id: "q1",
				text: "Approach?",
				options: [
					{ id: "opt-a", label: "Option A", recommended: true },
					{ id: "opt-b", label: "Option B" },
				],
			},
			{
				id: "q2",
				text: "Scope?",
				options: [
					{ id: "wide", label: "Wide" },
					{ id: "narrow", label: "Narrow", recommended: true },
				],
			},
		]
		// Q1: pick recommended, Q2: pick recommended, then review → Update plan
		const q1RecLabel = "Option A  ★ Recommended"
		const q2RecLabel = "Narrow  ★ Recommended"
		const continueLabel = "Update plan  ✓"
		const ctx = {
			ui: {
				select: vi
					.fn()
					.mockResolvedValueOnce(q1RecLabel)
					.mockResolvedValueOnce(q2RecLabel)
					.mockResolvedValueOnce(continueLabel),
				input: vi.fn(),
			},
		}

		const result = ok(await h.call("propose_ferment_scoping", basePayload(id, { questions }), ctx))

		const f = loadFerment(id)
		expect(f.status).toBe("draft")
		expect(result).not.toContain("Here is the proposed plan")
		expect(result).toContain("Your answers")
		expect(ctx.ui.select).toHaveBeenNthCalledWith(2, "[Q2/2] Scope?", [
			"Wide",
			q2RecLabel,
			`✎ ${pr_dim("Custom answer...")}`,
		])
		const sendMsg = h.pi.sendMessage as ReturnType<typeof vi.fn>
		const feedbackCalls = sendMsg.mock.calls.filter(
			(c: unknown[]) => (c[0] as { customType?: string })?.customType === "ferment_scoping_iteration",
		)
		expect(feedbackCalls).toHaveLength(1)
		const msgContent: string =
			typeof feedbackCalls[0][0].content === "string"
				? feedbackCalls[0][0].content
				: (feedbackCalls[0][0].content?.[0]?.text ?? "")
		expect(msgContent).toContain("Approach?")
		expect(msgContent).toContain("opt-a")
		expect(msgContent).toContain("Scope?")
		expect(msgContent).toContain("narrow")
		expect(msgContent).toContain("Usually emit `questions: []`")
	})

	// (c) per-question non-recommended pick → ferment stays draft, ONE sendMessage with all answers
	it("(c) per-question non-recommended pick → draft status, sendMessage with triggerTurn fired", async () => {
		const id = await createFerment("PerQ Pick")
		seedPending(id)
		const questions = [
			{
				id: "q1",
				text: "Approach?",
				options: [
					{ id: "opt-a", label: "Option A", recommended: true },
					{ id: "opt-b", label: "Option B" },
				],
			},
		]
		// Q1/1: pick non-recommended "Option B"; review: update the plan
		const continueLabel = "Update plan  ✓"
		const ctx = {
			ui: {
				select: vi.fn().mockResolvedValueOnce("Option B").mockResolvedValueOnce(continueLabel),
				input: vi.fn(),
			},
		}

		const result = ok(await h.call("propose_ferment_scoping", basePayload(id, { questions }), ctx))

		expect(loadFerment(id).status).toBe("draft")

		const sendMsg = h.pi.sendMessage as ReturnType<typeof vi.fn>
		const iterCalls = sendMsg.mock.calls.filter(
			(c: unknown[]) => (c[0] as { customType?: string })?.customType === "ferment_scoping_iteration",
		)
		expect(iterCalls).toHaveLength(1)
		const msgContent: string =
			typeof iterCalls[0][0].content === "string" ? iterCalls[0][0].content : (iterCalls[0][0].content?.[0]?.text ?? "")
		// New bundled-message format: question TEXT + chosen option label + id.
		expect(msgContent).toContain("Approach?")
		expect(msgContent).toContain("opt-b")
		expect(msgContent).toContain("Option B")
		expect(msgContent).toContain("Usually emit `questions: []`")
		expect(msgContent).toContain("only if these answers reveal a genuinely new")
		expect(msgContent).toContain("never repeat or rephrase")
		const triggerTurn = iterCalls[0][1]?.triggerTurn ?? iterCalls[0][0]?.triggerTurn
		expect(triggerTurn).toBe(true)
		expect(result).toMatch(/updating the plan/i)
	})

	// (d) say more → ctx.ui.input invoked, message echoed with triggerTurn
	it("(d) say more → input invoked, sendMessage echoes user text with triggerTurn", async () => {
		const id = await createFerment("SayMore")
		seedPending(id)
		const ctx = {
			ui: {
				select: vi.fn().mockResolvedValue("Let me say something"),
				input: vi.fn().mockResolvedValue("actually drop phase 3"),
				setWorkingVisible: vi.fn(),
			},
		}

		ok(await h.call("propose_ferment_scoping", basePayload(id), ctx))

		expect(ctx.ui.input).toHaveBeenCalled()
		expect(ctx.ui.setWorkingVisible).toHaveBeenCalledWith(false)
		expect(ctx.ui.setWorkingVisible).toHaveBeenCalledWith(true)
		expect(loadFerment(id).status).toBe("draft")

		const sendMsg = h.pi.sendMessage as ReturnType<typeof vi.fn>
		const iterCalls = sendMsg.mock.calls.filter(
			(c: unknown[]) => (c[0] as { customType?: string })?.customType === "ferment_scoping_iteration",
		)
		expect(iterCalls).toHaveLength(1)
		const msgContent: string =
			typeof iterCalls[0][0].content === "string" ? iterCalls[0][0].content : (iterCalls[0][0].content?.[0]?.text ?? "")
		expect(msgContent).toContain("actually drop phase 3")
		const triggerTurn = iterCalls[0][1]?.triggerTurn ?? iterCalls[0][0]?.triggerTurn
		expect(triggerTurn).toBe(true)
	})

	// (e) P-gate flag blocks the call
	it("(e) P-gate flag blocks the call, ferment stays draft", async () => {
		const id = await createFerment("GateBlock")
		seedPending(id)
		const flaggedGates = [
			{ id: "P1", verdict: "flag" as const, rationale: "no success signal", evidence: "none" },
			{ id: "P2", verdict: "pass" as const, rationale: "ok", evidence: "n/a" },
			{ id: "P3", verdict: "pass" as const, rationale: "ok", evidence: "n/a" },
		]
		const ctx = { ui: { select: vi.fn(), input: vi.fn() } }

		const result = await h.call("propose_ferment_scoping", basePayload(id, { gates: flaggedGates }), ctx)

		expect(result.isError).toBe(true)
		expect(err(result)).toContain("P1")
		expect(loadFerment(id).status).toBe("draft")
		expect(ctx.ui.select).not.toHaveBeenCalled()
		// Buffer is unchanged — not replaced on gate failure
		expect(h.runtime.getPendingScope(id)).toMatchObject({ goal: "" })
	})

	// (f) headless (no ctx.ui.select) zero-question → direct confirm
	it("(f) headless zero-question → direct confirm, ferment planned", async () => {
		const id = await createFerment("Headless ZeroQ")
		seedPending(id)
		// No ui.select provided — headless path
		const ctx = {}

		ok(await h.call("propose_ferment_scoping", basePayload(id), ctx))

		expect(loadFerment(id).status).toBe("planned")
		expect(getPendingScope(id)).toBeUndefined()
	})

	// (g) headless with questions → refuse until the agent folds defaults into a final no-question proposal
	it("(g) headless with questions → asks agent to fold recommendations into questions=[] proposal", async () => {
		const id = await createFerment("Headless WithQ")
		seedPending(id)
		const questions = [
			{
				id: "q1",
				text: "Approach?",
				options: [
					{ id: "opt-a", label: "Option A", recommended: true },
					{ id: "opt-b", label: "Option B" },
				],
			},
			{
				id: "q2",
				text: "Scope?",
				options: [
					{ id: "wide", label: "Wide" },
					{ id: "narrow", label: "Narrow", recommended: true },
				],
			},
		]
		const ctx = {}

		const result = err(await h.call("propose_ferment_scoping", basePayload(id, { questions }), ctx))

		expect(result).toContain("Cannot ask scoping questions without an interactive UI")
		expect(result).toContain("q1: opt-a")
		expect(result).toContain("q2: narrow")
		expect(loadFerment(id).status).toBe("draft")
		expect(getPendingScope(id)).toBeDefined()
	})

	// (h) second invocation REPLACES buffer wholesale
	it("(h) second invocation replaces buffer wholesale — omitted fields become undefined", async () => {
		const id = await createFerment("BufReplace")
		seedPending(id)

		// First call: set assumptions
		const ctx1 = {
			ui: { select: vi.fn().mockResolvedValue("Let me say something"), input: vi.fn().mockResolvedValue("") },
		}
		await h.call("propose_ferment_scoping", basePayload(id, { assumptions: "X" }), ctx1)

		// Buffer should now have assumptions = "X"
		expect(getPendingScope(id)?.assumptions).toBe("X")

		// Second call: omit assumptions entirely
		const ctx2 = {
			ui: { select: vi.fn().mockResolvedValue("Let me say something"), input: vi.fn().mockResolvedValue("") },
		}
		const payloadNoAssumptions = { ...basePayload(id), assumptions: undefined }
		await h.call("propose_ferment_scoping", payloadNoAssumptions, ctx2)

		// Buffer should be replaced wholesale — assumptions now undefined
		expect(getPendingScope(id)?.assumptions).toBeUndefined()
	})

	// Fix 1: Esc on dropdown → returns toolOk wait message, no sendMessage, ferment stays draft
	it("Esc on dropdown → returns toolOk wait message, no sendMessage, ferment stays draft", async () => {
		const id = await createFerment("EscDropdown")
		seedPending(id)
		// ui.select returns undefined (user pressed Esc)
		const ctx = { ui: { select: vi.fn().mockResolvedValue(undefined), input: vi.fn() } }

		const result = ok(await h.call("propose_ferment_scoping", basePayload(id), ctx))

		expect(result).toMatch(/no changes made/i)
		expect(result).toMatch(/waiting/i)
		expect(loadFerment(id).status).toBe("draft")
		const sendMsg = h.pi.sendMessage as ReturnType<typeof vi.fn>
		const iterCalls = sendMsg.mock.calls.filter(
			(c: unknown[]) => (c[0] as { customType?: string })?.customType === "ferment_scoping_iteration",
		)
		expect(iterCalls).toHaveLength(0)
	})

	// Fix 2: rejects question with duplicate option labels
	it("rejects question with duplicate option labels", async () => {
		const id = await createFerment("DupLabels")
		seedPending(id)
		const questions = [
			{
				id: "q1",
				text: "Approach?",
				options: [
					{ id: "opt-a", label: "Yes", recommended: true },
					{ id: "opt-b", label: "Yes" },
				],
			},
		]
		const ctx = { ui: { select: vi.fn(), input: vi.fn() } }

		const result = await h.call("propose_ferment_scoping", basePayload(id, { questions }), ctx)

		expect(result.isError).toBe(true)
		expect(err(result)).toContain("duplicate option labels")
		expect(ctx.ui.select).not.toHaveBeenCalled()
	})

	// Fix 3: 4th invocation with questions returns toolErr forcing convergence
	it("4th invocation with questions returns toolErr forcing convergence", async () => {
		const id = await createFerment("IterCap")
		seedPending(id)
		const questions = [
			{
				id: "q1",
				text: "Approach?",
				options: [
					{ id: "opt-a", label: "Option A", recommended: true },
					{ id: "opt-b", label: "Option B" },
				],
			},
		]
		const continueLabel = "Update plan  ✓"
		// Each call: user picks non-recommended "Option B" then Continue → fires sendMessage, increments iteration count
		for (let i = 0; i < 3; i++) {
			const ctx = {
				ui: {
					select: vi.fn().mockResolvedValueOnce("Option B").mockResolvedValueOnce(continueLabel),
					input: vi.fn(),
				},
			}
			ok(await h.call("propose_ferment_scoping", basePayload(id, { questions }), ctx))
		}

		// 4th call with questions → should be blocked before showing any UI
		const ctx4 = { ui: { select: vi.fn(), input: vi.fn() } }
		const result = await h.call("propose_ferment_scoping", basePayload(id, { questions }), ctx4)

		expect(result.isError).toBe(true)
		expect(err(result)).toMatch(/3 times/i)
		expect(ctx4.ui.select).not.toHaveBeenCalled()
	})

	// New: Custom answer option opens ctx.ui.input and free-form text is recorded
	it("Custom answer option opens ctx.ui.input and free-form text is included in sendMessage", async () => {
		const id = await createFerment("CustomAnswer")
		seedPending(id)
		const questions = [
			{
				id: "q1",
				text: "Approach?",
				options: [
					{ id: "opt-a", label: "Option A", recommended: true },
					{ id: "opt-b", label: "Option B" },
				],
			},
		]
		const customLabel = `✎ ${pr_dim("Custom answer...")}`
		const continueLabel = "Update plan  ✓"
		const ctx = {
			ui: {
				select: vi.fn().mockResolvedValueOnce(customLabel).mockResolvedValueOnce(continueLabel),
				input: vi.fn().mockResolvedValue("my custom thing"),
				setWorkingVisible: vi.fn(),
			},
		}

		ok(await h.call("propose_ferment_scoping", basePayload(id, { questions }), ctx))

		expect(ctx.ui.input).toHaveBeenCalledWith(expect.stringContaining("Approach?"), "")
		expect(ctx.ui.setWorkingVisible).toHaveBeenCalledWith(false)
		expect(ctx.ui.setWorkingVisible).toHaveBeenCalledWith(true)
		expect(loadFerment(id).status).toBe("draft")

		const sendMsg = h.pi.sendMessage as ReturnType<typeof vi.fn>
		const iterCalls = sendMsg.mock.calls.filter(
			(c: unknown[]) => (c[0] as { customType?: string })?.customType === "ferment_scoping_iteration",
		)
		expect(iterCalls).toHaveLength(1)
		const msgContent: string =
			typeof iterCalls[0][0].content === "string" ? iterCalls[0][0].content : (iterCalls[0][0].content?.[0]?.text ?? "")
		expect(msgContent).toContain("my custom thing")
	})

	// New: Restart questions cycles back to Q1
	it("Restart questions cycles back to Q1 and second iteration is recorded", async () => {
		const id = await createFerment("RestartQ")
		seedPending(id)
		const questions = [
			{
				id: "q1",
				text: "Approach?",
				options: [
					{ id: "opt-a", label: "Option A", recommended: true },
					{ id: "opt-b", label: "Option B" },
				],
			},
		]
		const q1RecLabel = "Option A  ★ Recommended"
		const continueLabel = "Update plan  ✓"
		// First pass: pick recommended → review → Restart
		// Second pass: pick non-recommended "Option B" → review → Continue
		const ctx = {
			ui: {
				select: vi
					.fn()
					.mockResolvedValueOnce(q1RecLabel) // Q1 first pass
					.mockResolvedValueOnce("Restart questions") // review first pass
					.mockResolvedValueOnce("Option B") // Q1 second pass
					.mockResolvedValueOnce(continueLabel), // review second pass
				input: vi.fn(),
			},
		}

		ok(await h.call("propose_ferment_scoping", basePayload(id, { questions }), ctx))

		// select was called 4 times total (Q1 ×2 + review ×2)
		expect(ctx.ui.select).toHaveBeenCalledTimes(4)
		// Non-recommended answer → sendMessage fired
		const sendMsg = h.pi.sendMessage as ReturnType<typeof vi.fn>
		const iterCalls = sendMsg.mock.calls.filter(
			(c: unknown[]) => (c[0] as { customType?: string })?.customType === "ferment_scoping_iteration",
		)
		expect(iterCalls).toHaveLength(1)
		const msgContent: string =
			typeof iterCalls[0][0].content === "string" ? iterCalls[0][0].content : (iterCalls[0][0].content?.[0]?.text ?? "")
		expect(msgContent).toContain("opt-b")
	})

	// New: Esc on per-question select cancels the whole flow
	it("Esc on per-question select cancels the whole flow", async () => {
		const id = await createFerment("EscPerQ")
		seedPending(id)
		const questions = [
			{
				id: "q1",
				text: "Approach?",
				options: [
					{ id: "opt-a", label: "Option A", recommended: true },
					{ id: "opt-b", label: "Option B" },
				],
			},
			{
				id: "q2",
				text: "Scope?",
				options: [
					{ id: "wide", label: "Wide" },
					{ id: "narrow", label: "Narrow", recommended: true },
				],
			},
		]
		const q1RecLabel = "Option A  ★ Recommended"
		// Q1: pick recommended; Q2: Esc (undefined)
		const ctx = {
			ui: {
				select: vi.fn().mockResolvedValueOnce(q1RecLabel).mockResolvedValueOnce(undefined),
				input: vi.fn(),
			},
		}

		const result = ok(await h.call("propose_ferment_scoping", basePayload(id, { questions }), ctx))

		expect(result).toMatch(/Q2/i)
		expect(result).toMatch(/dismissed/i)
		expect(loadFerment(id).status).toBe("draft")
		const sendMsg = h.pi.sendMessage as ReturnType<typeof vi.fn>
		const iterCalls = sendMsg.mock.calls.filter(
			(c: unknown[]) => (c[0] as { customType?: string })?.customType === "ferment_scoping_iteration",
		)
		expect(iterCalls).toHaveLength(0)
	})
})
