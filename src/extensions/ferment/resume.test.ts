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
import { maybeInjectScopingStopNudge, resetAllScopingStopNudgeCounts } from "./nudge.js"
import {
	deletePendingProposal,
	loadPendingProposal,
	PENDING_PROPOSAL_SCHEMA_VERSION,
	type PendingProposalData,
	savePendingProposal,
} from "./pending-proposal-store.js"
import { clearPendingPlanReviewTrigger } from "./plan-review-trigger.js"
import { resumeFerment } from "./resume.js"
import { createDefaultFermentRuntime, type FermentRuntime } from "./runtime.js"
import { clearAllPendingScopes, setPendingScope } from "./scoping.js"
import { confirmPendingScope } from "./scoping-confirmation.js"
import { clearAllScopingGates, clearAllStepStarts, setActive } from "./state.js"
import { createApplyAndPersist } from "./tool-helpers.js"

// ─── Harness ─────────────────────────────────────────────────────────────────

interface SendMessageCall {
	customType?: string
	content?: { text?: string }[]
}

/** Count messages across both actionable hidden custom types (the resume
 *  contract: at most one per resume). */
function actionableHidden(messages: SendMessageCall[]): SendMessageCall[] {
	return messages.filter(
		(m) => m.customType === "ferment_resume_nudge" || m.customType === "ferment_continuation_nudge",
	)
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
	resetAllScopingStopNudgeCounts()
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

		// No actionable hidden continuation is sent while a plan review is
		// pending — neither the resume nudge nor the continuation nudge.
		expect(actionableHidden(h.sentMessages)).toHaveLength(0)
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

		// Resume contract: exactly one actionable hidden message, and it is the
		// resume nudge — no continuation nudge should be sent for a draft.
		expect(actionableHidden(h.sentMessages)).toHaveLength(1)
		expect(h.sentMessages.find((m) => m.customType === "ferment_continuation_nudge")).toBeUndefined()
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

describe("resumeFerment planned state", () => {
	it("planned resume sends exactly one continuation nudge naming the activate_phase action", () => {
		const ferment = h.eventStorage.create("Planned Resume")
		h.runtime.setActive(ferment)

		const applyAndPersist = createApplyAndPersist(h.runtime)
		const scoped = applyAndPersist(ferment.id, {
			type: "scope",
			title: "Planned Resume",
			goal: "g",
			successCriteria: ["c"],
			constraints: [],
			assumptions: "a",
			phases: [{ name: "P1", goal: "g", steps: [{ description: "s1" }] }],
		})
		expect(scoped.ok).toBe(true)
		if (!scoped.ok) throw new Error(scoped.error.message)
		// A freshly scoped ferment lands in "planned" with all phases planned.
		expect(scoped.ferment.status).toBe("planned")

		resumeFerment(h.pi, ferment.id, { hasUI: false } as ExtensionCommandContext, h.runtime)

		// Resume contract: exactly one actionable hidden message.
		expect(actionableHidden(h.sentMessages)).toHaveLength(1)

		// It is the scheduler's contextual continuation nudge (not the resume
		// nudge) and it names the expected activate_phase action.
		const continuation = h.sentMessages.find((m) => m.customType === "ferment_continuation_nudge")
		expect(continuation).toBeDefined()
		const text = continuation?.content?.map((c) => c.text ?? "").join("") ?? ""
		expect(text).toContain("activate_ferment_phase")
		expect(text).toContain(scoped.ferment.phases[0].id)

		// No resume nudge is sent for a planned ferment.
		expect(h.sentMessages.find((m) => m.customType === "ferment_resume_nudge")).toBeUndefined()
		expect(h.sentMessages.filter((m) => m.customType === "ferment_breadcrumb")).toHaveLength(1)
		expect(h.pi.appendEntry).not.toHaveBeenCalledWith("ferment_breadcrumb", expect.anything())
	})

	it("continues a planned ferment whose final phase is complete", () => {
		const ferment = h.eventStorage.create("Ready To Complete")
		h.runtime.setActive(ferment)

		const applyAndPersist = createApplyAndPersist(h.runtime)
		const scoped = applyAndPersist(ferment.id, {
			type: "scope",
			title: "Ready To Complete",
			goal: "g",
			successCriteria: ["c"],
			constraints: [],
			assumptions: "a",
			phases: [{ name: "P1", goal: "g", steps: [] }],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		const phaseId = scoped.ferment.phases[0].id
		const activated = applyAndPersist(ferment.id, { type: "activate_phase", phaseId })
		if (!activated.ok) throw new Error(activated.error.message)
		const phaseDone = applyAndPersist(ferment.id, {
			type: "complete_phase",
			phaseId,
			summary: "done",
		})
		if (!phaseDone.ok) throw new Error(phaseDone.error.message)
		expect(phaseDone.ferment.status).toBe("planned")

		resumeFerment(h.pi, ferment.id, { hasUI: false } as ExtensionCommandContext, h.runtime)

		expect(actionableHidden(h.sentMessages)).toHaveLength(1)
		const continuation = h.sentMessages.find((message) => message.customType === "ferment_continuation_nudge")
		const text = continuation?.content?.map((content) => content.text ?? "").join("") ?? ""
		expect(text).toContain("complete_ferment")
		expect(h.sentMessages.find((message) => message.customType === "ferment_resume_nudge")).toBeUndefined()
	})
})

describe("resumeFerment running state", () => {
	it("paused ferment that resumes to running sends one continuation nudge with the resume imperative and next action", () => {
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

		// After resume, status should be running.
		const running = h.eventStorage.get(draft.id)
		expect(running?.status).toBe("running")

		// Resume contract: exactly one actionable hidden message.
		expect(actionableHidden(h.sentMessages)).toHaveLength(1)

		// It is the scheduler's contextual continuation nudge containing both
		// the resume imperative and the next-action instructions.
		const continuation = h.sentMessages.find((m) => m.customType === "ferment_continuation_nudge")
		expect(continuation).toBeDefined()
		const nudgeText = continuation?.content?.map((c) => c.text ?? "").join("") ?? ""
		expect(nudgeText).toContain("RESUMING ferment")
		expect(nudgeText).toContain("Pick up the work immediately")
		expect(nudgeText).toContain("start_ferment_step")

		// No resume nudge is sent for a running ferment.
		expect(h.sentMessages.find((m) => m.customType === "ferment_resume_nudge")).toBeUndefined()
		expect(h.sentMessages.filter((m) => m.customType === "ferment_breadcrumb")).toHaveLength(1)
		expect(h.pi.appendEntry).not.toHaveBeenCalledWith("ferment_breadcrumb", expect.anything())
	})
})

describe("resumeFerment still-paused state", () => {
	it("a failed resume attempt sends the paused notice and no actionable hidden message", () => {
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
		vi.spyOn(h.eventStorage, "mutateWithEvents").mockImplementationOnce(() => {
			return { ok: false, error: { code: "FERMENT_NOT_FOUND", message: "simulated resume failure" } }
		})

		expect(maybeInjectScopingStopNudge(h.pi, draft.id, ["read"], "stop")).toEqual({ kind: "scheduled" })
		expect(maybeInjectScopingStopNudge(h.pi, draft.id, ["read"], "stop")).toEqual({ kind: "scheduled" })
		expect(maybeInjectScopingStopNudge(h.pi, draft.id, ["read"], "stop")).toEqual({
			kind: "claimed",
			reason: "exhausted",
		})

		resumeFerment(h.pi, draft.id, hasUIContext(), h.runtime)

		// Resume contract: no actionable hidden message is sent.
		expect(actionableHidden(h.sentMessages)).toHaveLength(0)

		// A user-facing paused notice should be sent instead.
		const pausedNotice = h.sentMessages.find((m) => m.customType === "ferment_paused_notice")
		expect(pausedNotice).toBeDefined()
		const noticeText = pausedNotice?.content?.map((c) => c.text ?? "").join("") ?? ""
		expect(noticeText).toContain("currently paused")
		expect(noticeText).toContain("/ferment resume")
		expect(maybeInjectScopingStopNudge(h.pi, draft.id, ["read"], "stop")).toEqual({
			kind: "claimed",
			reason: "exhausted",
		})
	})
})

describe("resumeFerment early-return states", () => {
	it.each(["complete", "abandoned"] as const)("does not continue a %s ferment", (terminalStatus) => {
		const draft = h.eventStorage.create(`${terminalStatus} Resume`)
		const applyAndPersist = createApplyAndPersist(h.runtime)

		if (terminalStatus === "abandoned") {
			const abandoned = applyAndPersist(draft.id, { type: "abandon", reason: "done" })
			expect(abandoned.ok).toBe(true)
		} else {
			const scoped = applyAndPersist(draft.id, {
				type: "scope",
				title: "Complete Resume",
				goal: "g",
				successCriteria: ["c"],
				constraints: [],
				assumptions: "a",
				phases: [{ name: "P1", goal: "g", steps: [] }],
			})
			if (!scoped.ok) throw new Error(scoped.error.message)
			const phaseId = scoped.ferment.phases[0].id
			const activated = applyAndPersist(draft.id, { type: "activate_phase", phaseId })
			if (!activated.ok) throw new Error(activated.error.message)
			const completedPhase = applyAndPersist(draft.id, {
				type: "complete_phase",
				phaseId,
				summary: "done",
			})
			if (!completedPhase.ok) throw new Error(completedPhase.error.message)
			const completed = applyAndPersist(draft.id, { type: "complete_ferment", finalSummary: "done" })
			expect(completed.ok).toBe(true)
		}

		resumeFerment(h.pi, draft.id, hasUIContext(), h.runtime)

		expect(actionableHidden(h.sentMessages)).toHaveLength(0)
		expect(h.sentMessages).toHaveLength(0)
		expect(h.runtime.getActive()).toBeUndefined()
	})

	it("sends a warning without continuing when the worktree check blocks resume", () => {
		const ferment = h.eventStorage.create("Blocked Worktree Resume")
		vi.spyOn(h.eventStorage, "get").mockReturnValue({
			...ferment,
			worktree: { ...ferment.worktree, path: join(tmpdir(), "different-worktree") },
		})

		resumeFerment(h.pi, ferment.id, hasUIContext(), h.runtime)

		expect(actionableHidden(h.sentMessages)).toHaveLength(0)
		expect(h.sentMessages.find((message) => message.customType === "ferment_worktree_warning")).toBeDefined()
		expect(h.sentMessages.find((message) => message.customType === "ferment_breadcrumb")).toBeUndefined()
	})
})

describe("resumeFerment scoping-stop budget reset", () => {
	it("resets the scoping-stop budget so a resumed draft gets a fresh nudge budget", () => {
		// /ferment resume calls resumeFerment directly without
		// a session_start. Before the fix, the process-global
		// scopingStopNudgeCounts was never cleared on resume, so a draft that
		// reached exhaustion stayed permanently `claimed` — no recovery nudge
		// was ever sent again within the same session. resumeFerment must reset
		// the budget just like session_start does.
		const draft = h.eventStorage.create("Exhausted Then Resumed")
		h.runtime.setActive(draft)

		// Exhaust the scoping-stop budget via the function under test.
		expect(maybeInjectScopingStopNudge(h.pi, draft.id, ["read"], "stop")).toEqual({ kind: "scheduled" })
		expect(maybeInjectScopingStopNudge(h.pi, draft.id, ["read"], "stop")).toEqual({ kind: "scheduled" })
		expect(maybeInjectScopingStopNudge(h.pi, draft.id, ["read"], "stop")).toEqual({
			kind: "claimed",
			reason: "exhausted",
		})

		// Same-session explicit resume — no session_start fires.
		resumeFerment(h.pi, draft.id, { hasUI: false } as ExtensionCommandContext, h.runtime)

		// After resume, the same qualifying turn must schedule a nudge again.
		expect(maybeInjectScopingStopNudge(h.pi, draft.id, ["read"], "stop")).toEqual({ kind: "scheduled" })

		h.runtime.setActive(undefined)
	})
})
