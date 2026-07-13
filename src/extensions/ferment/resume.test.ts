/**
 * Integration tests for resumeFerment pending-proposal hydration.
 *
 * Covers the three success criteria tied to the disk-backed pending proposal:
 *   1. Draft WITH a persisted proposal → resume re-arms the plan review dialog
 *      (getPendingPlanReview returns the persisted planMarkdown) and skips the
 *      LLM scoping nudge (no ferment_resume_nudge message).
 *   2. Draft with NO persisted proposal → existing behavior unchanged
 *      (ferment_resume_nudge fires, no plan review re-armed). Regression guard.
 *   3. Confirming the plan deletes the persisted sidecar file.
 *
 * The disk sidecar is isolated via KIMCHI_FERMENTS_DIR pointing at a temp dir,
 * matching how resumeFerment / confirmPendingScope resolve the ferments root.
 */

import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { FermentEventStore } from "../../ferment/event-store.js"
import { clearFermentCache } from "../../ferment/store.js"
import {
	PENDING_PROPOSAL_SCHEMA_VERSION,
	type PendingProposalData,
	deletePendingProposal,
	loadPendingProposal,
	savePendingProposal,
} from "./pending-proposal-store.js"
import { clearPendingPlanReviewTrigger } from "./plan-review-trigger.js"
import { resumeFerment } from "./resume.js"
import { type FermentRuntime, createDefaultFermentRuntime } from "./runtime.js"
import { confirmPendingScope } from "./scoping-confirmation.js"
import { clearAllPendingScopes, setPendingScope } from "./scoping.js"
import { clearAllScopingGates, clearAllStepStarts, setActive } from "./state.js"
import { createApplyAndPersist } from "./tool-helpers.js"

// ─── Harness ─────────────────────────────────────────────────────────────────

interface SendMessageCall {
	customType?: string
	content?: { text?: string }[]
}

function createHarness() {
	const fermentsDir = mkdtempSync(join(tmpdir(), "ferment-resume-test-"))
	const eventStorage = new FermentEventStore(fermentsDir)
	const runtime: FermentRuntime = { ...createDefaultFermentRuntime(), getStorage: () => eventStorage }
	const sentMessages: SendMessageCall[] = []

	const pi = {
		on: vi.fn(),
		registerTool: vi.fn(),
		sendMessage: vi.fn((msg: SendMessageCall) => {
			sentMessages.push(msg)
		}),
		sendUserMessage: vi.fn(),
		appendEntry: vi.fn(),
		getActiveTools: vi.fn(() => []),
		getAllTools: vi.fn(() => []),
		setActiveTools: vi.fn(),
		getFlag: vi.fn(() => undefined),
	} as unknown as ExtensionAPI

	return { fermentsDir, eventStorage, runtime, pi, sentMessages }
}

const PLAN_MARKDOWN = "## Plan: Test Ferment\n\n- Phase 1: Do the thing"
const SAMPLE_PHASES = [
	{
		name: "Phase 1",
		goal: "Do the thing",
		steps: [{ description: "step one" }],
	},
]

function makePersistedProposal(fermentId: string): PendingProposalData {
	return {
		schemaVersion: PENDING_PROPOSAL_SCHEMA_VERSION,
		fermentId,
		title: "Test Ferment",
		goal: "A test goal",
		successCriteria: ["criterion one"],
		constraints: ["constraint one"],
		assumptions: "an assumption",
		phases: SAMPLE_PHASES,
		planMarkdown: PLAN_MARKDOWN,
		proposeIterations: 1,
		savedAt: new Date("2025-01-01T00:00:00.000Z").toISOString(),
	}
}

let h: ReturnType<typeof createHarness>
let prevFermentsDir: string | undefined

beforeEach(() => {
	h = createHarness()
	clearFermentCache()
	clearAllStepStarts()
	clearAllScopingGates()
	clearAllPendingScopes()
	setActive(undefined)
	prevFermentsDir = process.env.KIMCHI_FERMENTS_DIR
	process.env.KIMCHI_FERMENTS_DIR = h.fermentsDir
})

afterEach(() => {
	clearFermentCache()
	clearAllStepStarts()
	clearAllScopingGates()
	clearAllPendingScopes()
	setActive(undefined)
	clearPendingPlanReviewTrigger()
	if (prevFermentsDir === undefined) {
		process.env.KIMCHI_FERMENTS_DIR = undefined
	} else {
		process.env.KIMCHI_FERMENTS_DIR = prevFermentsDir
	}
})

const hasUIContext = (): ExtensionCommandContext =>
	({
		hasUI: true,
		ui: { notify: vi.fn(), input: vi.fn(), select: vi.fn() },
	}) as unknown as ExtensionCommandContext

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("resumeFerment pending-proposal hydration", () => {
	it("draft WITH persisted proposal re-arms plan review and skips the LLM scoping nudge", () => {
		const ferment = h.eventStorage.create("Test Ferment")
		h.runtime.setActive(ferment)

		// Persist a pending proposal to disk (simulating a prior session's
		// propose_ferment_scoping with questions=[] that deferred review).
		savePendingProposal(ferment.id, makePersistedProposal(ferment.id), { root: h.fermentsDir })
		expect(loadPendingProposal(ferment.id, h.fermentsDir)).toBeDefined()

		resumeFerment(h.pi, ferment.id, hasUIContext(), h.runtime)

		// The plan review must be re-armed with the persisted planMarkdown.
		const review = h.runtime.getPendingPlanReview(ferment.id)
		expect(review).toBeDefined()
		expect(review?.planMarkdown).toBe(PLAN_MARKDOWN)

		// The pending scope buffer must also be re-armed so a later confirm/cancel
		// can consume it.
		const pendingScope = h.runtime.getPendingScope(ferment.id)
		expect(pendingScope).toBeDefined()
		expect(pendingScope?.goal).toBe("A test goal")
		expect(pendingScope?.proposeIterations).toBe(1)

		// No LLM scoping nudge (ferment_resume_nudge) — that path was skipped.
		const resumeNudge = h.sentMessages.find((m) => m.customType === "ferment_resume_nudge")
		expect(resumeNudge).toBeUndefined()

		// The breadcrumb confirming re-arm must fire.
		const breadcrumb = h.sentMessages.find((m) => m.customType === "ferment_breadcrumb")
		expect(breadcrumb).toBeDefined()
		const breadcrumbText = breadcrumb?.content?.map((c) => c.text ?? "").join("") ?? ""
		expect(breadcrumbText).toContain("plan review re-armed from saved proposal")
	})

	it("draft with NO persisted proposal keeps existing behavior (resume nudge fires, no plan review)", () => {
		const ferment = h.eventStorage.create("Untouched Draft")
		h.runtime.setActive(ferment)

		// No sidecar on disk.
		expect(loadPendingProposal(ferment.id, h.fermentsDir)).toBeUndefined()

		resumeFerment(h.pi, ferment.id, hasUIContext(), h.runtime)

		// No plan review re-armed.
		expect(h.runtime.getPendingPlanReview(ferment.id)).toBeUndefined()

		// The existing resume nudge fires (regression guard).
		const resumeNudge = h.sentMessages.find((m) => m.customType === "ferment_resume_nudge")
		expect(resumeNudge).toBeDefined()
	})

	it("confirming the plan deletes the persisted sidecar file", () => {
		const ferment = h.eventStorage.create("Confirm Delete")
		h.runtime.setActive(ferment)

		// Seed in-memory pending scope + persisted sidecar (as propose_ferment_scoping would).
		setPendingScope(ferment.id, {
			title: "Test Ferment",
			goal: "A test goal",
			successCriteria: ["criterion one"],
			constraints: ["constraint one"],
			assumptions: "an assumption",
			phases: SAMPLE_PHASES,
			proposeIterations: 1,
		})
		savePendingProposal(ferment.id, makePersistedProposal(ferment.id), { root: h.fermentsDir })
		expect(loadPendingProposal(ferment.id, h.fermentsDir)).toBeDefined()

		const result = confirmPendingScope(h.runtime, ferment.id, undefined, "propose_ferment_scoping", h.pi)
		expect(result.ok).toBe(true)

		// Sidecar must be gone after confirm.
		expect(loadPendingProposal(ferment.id, h.fermentsDir)).toBeUndefined()
	})

	it("cancel path (deletePendingProposal) removes the sidecar", () => {
		const ferment = h.eventStorage.create("Cancel Delete")
		// Persist a sidecar, then exercise the cancel cleanup directly — the
		// runPendingPlanReview cancel branch calls deletePendingProposal(review.fermentId),
		// which is covered end-to-end by the TUI E2E; here we assert the store
		// contract the cancel branch relies on.
		savePendingProposal(ferment.id, makePersistedProposal(ferment.id), { root: h.fermentsDir })
		expect(loadPendingProposal(ferment.id, h.fermentsDir)).toBeDefined()

		deletePendingProposal(ferment.id, h.fermentsDir)
		expect(loadPendingProposal(ferment.id, h.fermentsDir)).toBeUndefined()
		// Idempotent — second delete is a no-op.
		deletePendingProposal(ferment.id, h.fermentsDir)
	})
})

describe("resumeFerment automated scope-nudge dedup", () => {
	it("automated draft resume without a persisted proposal does not queue duplicate scoping nudges", () => {
		const ferment = h.eventStorage.create("Automated Untouched Draft")
		h.runtime.setContinuationPolicy("automated")
		h.runtime.setActive(ferment)

		resumeFerment(h.pi, ferment.id, { hasUI: false } as ExtensionCommandContext, h.runtime)

		const hiddenNudges = h.sentMessages
			.filter((m) => m.customType === "ferment_resume_nudge" || m.customType === "ferment_continuation_nudge")
			.map((m) => m.customType)
		expect(hiddenNudges).toEqual(["ferment_resume_nudge"])
	})
})

describe("resumeFerment paused-state nudge guard", () => {
	it("paused ferment that resumes to running emits the resume nudge", () => {
		const draft = h.eventStorage.create("Paused Then Running")
		h.runtime.setActive(draft)

		// Scope and activate so the ferment can be paused/resumed meaningfully.
		const applyAndPersist = createApplyAndPersist(h.runtime)
		const scoped = applyAndPersist(draft.id, {
			type: "scope",
			title: "Paused Then Running",
			goal: "g",
			successCriteria: ["c"],
			constraints: [],
			assumptions: "a",
			phases: [{ name: "P1", goal: "g", steps: [{ description: "s1" }] }],
		})
		expect(scoped.ok).toBe(true)
		if (!scoped.ok) throw new Error(scoped.error.message)
		const activated = applyAndPersist(draft.id, {
			type: "activate_phase",
			phaseId: scoped.ferment.phases[0].id,
		})
		expect(activated.ok).toBe(true)
		if (!activated.ok) throw new Error(activated.error.message)

		// Pause the ferment.
		const paused = applyAndPersist(draft.id, { type: "pause" })
		expect(paused.ok).toBe(true)
		if (!paused.ok) throw new Error(paused.error.message)
		expect(paused.ferment.status).toBe("paused")

		resumeFerment(h.pi, draft.id, hasUIContext(), h.runtime)

		// After resume, status should be running and the model gets the imperative nudge.
		const running = h.eventStorage.get(draft.id)
		expect(running?.status).toBe("running")

		const resumeNudge = h.sentMessages.find((m) => m.customType === "ferment_resume_nudge")
		expect(resumeNudge).toBeDefined()
		const nudgeText = resumeNudge?.content?.map((c) => c.text ?? "").join("") ?? ""
		expect(nudgeText).toContain("RESUMING ferment")
		expect(nudgeText).toContain("Pick up the work immediately")
	})

	it("paused ferment that remains paused does not emit the resume nudge", () => {
		const draft = h.eventStorage.create("Stays Paused")
		h.runtime.setActive(draft)

		const applyAndPersist = createApplyAndPersist(h.runtime)
		const scoped = applyAndPersist(draft.id, {
			type: "scope",
			title: "Stays Paused",
			goal: "g",
			successCriteria: ["c"],
			constraints: [],
			assumptions: "a",
			phases: [{ name: "P1", goal: "g", steps: [{ description: "s1" }] }],
		})
		expect(scoped.ok).toBe(true)
		if (!scoped.ok) throw new Error(scoped.error.message)
		const activated = applyAndPersist(draft.id, {
			type: "activate_phase",
			phaseId: scoped.ferment.phases[0].id,
		})
		expect(activated.ok).toBe(true)
		if (!activated.ok) throw new Error(activated.error.message)
		const paused = applyAndPersist(draft.id, { type: "pause" })
		expect(paused.ok).toBe(true)
		if (!paused.ok) throw new Error(paused.error.message)

		// Simulate a resume that did not take effect: intercept the next
		// mutateWithEvents call (the resume attempt inside resumeFerment) and
		// force it to fail with a non-ok outcome. Because resume.ts only
		// reassigns `existing = out.ferment` when `out.ok`, leaving
		// existing.status === "paused" exercises the ferment_paused_notice branch.
		// We can't achieve this by mocking eventStorage.get alone: resume.ts
		// reassigns `existing` from the applyAndPersist return value, and
		// mutateWithEvents reads the underlying storage via this.storage.get
		// (not this.get), so a spy on eventStorage.get would not intercept the
		// mutate path.
		vi.spyOn(h.eventStorage, "mutateWithEvents").mockImplementationOnce(() => {
			return { ok: false, error: { code: "FERMENT_NOT_FOUND", message: "simulated resume failure" } }
		})

		resumeFerment(h.pi, draft.id, hasUIContext(), h.runtime)

		// No resume nudge should be sent to the model.
		const resumeNudge = h.sentMessages.find((m) => m.customType === "ferment_resume_nudge")
		expect(resumeNudge).toBeUndefined()

		// A user-facing paused notice should be sent instead.
		const pausedNotice = h.sentMessages.find((m) => m.customType === "ferment_paused_notice")
		expect(pausedNotice).toBeDefined()
		const noticeText = pausedNotice?.content?.map((c) => c.text ?? "").join("") ?? ""
		expect(noticeText).toContain("currently paused")
		expect(noticeText).toContain("/ferment resume")
	})
})
