// ACP integration: `plan` sessionUpdates derived from the ferment lifecycle.
//
// Drives a real kimchi ACP process with a seeded, planned ferment and a
// scripted fake model. Asserts the wire-level `plan` notifications the IDE
// client observes:
//   1. Create/update/clear lifecycle — activate phase → start step →
//      complete step → complete phase, asserting plan contents across it.
//   2. Session isolation — with two sessions on one process, plan
//      notifications only reach the session whose bus carries the ferment
//      events (the one that owned it when activation fired).
//
// Seeding approach: ACP (`--mode acp`) has no interactive path from draft to
// planned (promptPlanReview is TUI-only), so the fixture pre-seeds
// `workDir/.kimchi/ferments/<id>.json` with a planned ferment and sets
// KIMCHI_ACTIVE_FERMENT before spawn. Kimchi's env-var resume path shows an
// elicitation ("Resume?") which the test answers with "Resume".

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type * as acp from "@agentclientprotocol/sdk"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

const FERMENT_ID = "ferment-plan-e2e"
const PHASE_ID = "phase-1"
const STEP_1_ID = "step-1"
const STEP_2_ID = "step-2"
const STEP_1_DESC = "Write unit tests"
const STEP_2_DESC = "Wire the cache"

const PROMPT_TIMEOUT_LONG_MS = 90_000
const TEST_TIMEOUT_MS = 180_000

// ─── Script helpers ──────────────────────────────────────────────────────────

function toolCall(name: string, args: Record<string, unknown>) {
	return {
		function: { name, arguments: JSON.stringify(args) },
	} as const
}

const FERMENT_IDS = { ferment_id: FERMENT_ID, phase_id: PHASE_ID }

const STEP_GATES = [
	{ id: "S1", verdict: "pass", rationale: "Summary matches work", evidence: "e2e scripted run" },
	{ id: "S2", verdict: "pass", rationale: "Verify honesty", evidence: "e2e scripted run" },
	{ id: "S3", verdict: "pass", rationale: "Edge cases considered", evidence: "n/a" },
]

const PHASE_GATES = [
	{ id: "F1", verdict: "pass", rationale: "Real verification", evidence: "e2e scripted run" },
	{ id: "F2", verdict: "pass", rationale: "Output meets phase goal", evidence: "e2e scripted run" },
	{ id: "F3", verdict: "pass", rationale: "Nothing deferred", evidence: "n/a" },
]

function lifecycleScripts() {
	return [
		// Wake/resume (or first prompt) turn: activate the phase.
		{
			stream: ["Resuming and activating the phase."],
			toolCalls: [toolCall("activate_ferment_phase", { ferment_id: FERMENT_ID, phase_id: PHASE_ID })],
		},
		{ stream: ["Phase activated."] },
		// Start the first step.
		{
			stream: ["Starting step 1."],
			toolCalls: [toolCall("start_ferment_step", { ...FERMENT_IDS, step_id: STEP_1_ID })],
		},
		{ stream: ["Step started."] },
		// Complete the first step.
		{
			stream: ["Completing step 1."],
			toolCalls: [toolCall("complete_ferment_step", { ...FERMENT_IDS, step_id: STEP_1_ID, gates: STEP_GATES })],
		},
		{ stream: ["Step completed."] },
		// Complete the phase.
		{
			stream: ["Completing the phase."],
			toolCalls: [
				toolCall("complete_ferment_phase", {
					...FERMENT_IDS,
					summary: "Phase done in e2e.",
					evidence: "scripted completions",
					gates: PHASE_GATES,
				}),
			],
		},
		{ stream: ["Phase completed."] },
		// Catch-all tails: any follow-up/nudge turns terminate without tool calls.
		{ stream: ["Understood."] },
		{ stream: ["Understood."] },
		{ stream: ["Understood."] },
		{ stream: ["Understood."] },
		{ stream: ["Understood."] },
	]
}

// ─── Plan helpers ────────────────────────────────────────────────────────────

type PlanEntry = Extract<acp.SessionUpdate, { sessionUpdate: "plan" }>["entries"][number]

function planSnapshots(fixture: AcpFixture, sessionId: string): PlanEntry[][] {
	return fixture.client.sessionUpdates
		.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "plan")
		.map((u) => (u.update as Extract<acp.SessionUpdate, { sessionUpdate: "plan" }>).entries)
}

function latestPlan(fixture: AcpFixture, sessionId: string): PlanEntry[] | undefined {
	const snaps = planSnapshots(fixture, sessionId)
	return snaps[snaps.length - 1]
}

/**
 * Wait until the SNAPSHOT HISTORY for the session contains a snapshot
 * matching the predicate. History-based (race-tolerant): rapid lifecycle
 * transitions can supersede an intermediate snapshot within one poll
 * interval, but the append-only history never lies.
 */
async function waitForSnapshotWith(
	fixture: AcpFixture,
	sessionId: string,
	predicate: (entries: PlanEntry[]) => boolean,
	timeoutMs = PROMPT_TIMEOUT_LONG_MS,
	context = "",
): Promise<PlanEntry[]> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		const hit = planSnapshots(fixture, sessionId).find((entries) => predicate(entries))
		if (hit) return hit
		await delay(100)
	}
	const seen = JSON.stringify(planSnapshots(fixture, sessionId), null, 1)
	throw new Error(`waitForSnapshotWith timed out (${context}) after ${timeoutMs}ms. Snapshots seen: ${seen}`)
}

// ─── Seeding ─────────────────────────────────────────────────────────────────

/**
 * Seed a planned ferment on disk in the event-store format (snapshot +
 * genesis events log — the store folds the log from scratch after the first
 * mutation, so both must exist and agree).
 */
function buildSeedState(workDir: string) {
	const now = new Date().toISOString()
	return {
		id: FERMENT_ID,
		name: "Plan E2E Ferment",
		status: "planned",
		goal: "Finish the e2e phase.",
		successCriteria: ["Phase completes"],
		constraints: [],
		assumptions: "",
		worktree: { path: workDir },
		scoping: {},
		phases: [
			{
				id: PHASE_ID,
				index: 1,
				name: "Cache integration",
				goal: "Deliver the cache integration.",
				status: "planned",
				steps: [
					{ id: STEP_1_ID, index: 1, description: STEP_1_DESC, status: "pending" },
					{ id: STEP_2_ID, index: 2, description: STEP_2_DESC, status: "pending" },
				],
			},
		],
		decisions: [] as unknown[],
		memories: [] as unknown[],
		createdAt: now,
		updatedAt: now,
	}
}

function seedPlannedFerment(workDir: string): void {
	const ferment = buildSeedState(workDir)
	writeFermentSeed(workDir, ferment)
}

function writeFermentSeed(dir: string, ferment: ReturnType<typeof buildSeedState>): void {
	mkdirSync(join(dir, ".kimchi", "ferments"), { recursive: true })
	const fermentsDir = join(dir, ".kimchi", "ferments")

	// Snapshot (read on the pre-events path, and overwritten by mutations).
	writeFileSync(join(fermentsDir, `${ferment.id}.json`), JSON.stringify(ferment, null, "\t"), "utf-8")

	// Events log — the store switches to folding the log after the first
	// mutation, so a snapshot-only seed would crash folds with
	// "<event> requires existing state". Write a genesis history: created →
	// scoped (goal, criteria, phases) → planned. `applyFermentEvent` only
	// reads type/timestamp/payload, so hashes are placeholders.
	const ts = (n: number) => new Date(Date.parse(ferment.createdAt) + n * 1000).toISOString()
	const event = (type: string, payload: unknown, n: number) =>
		JSON.stringify({
			id: `${ferment.id}-e${n}`,
			timestamp: ts(n),
			type,
			preStateHash: "0",
			postStateHash: "0",
			payload,
		})
	const scopingPhases = (ferment.scoping as { phases?: unknown }).phases
	const lines = [
		event(
			"ferment_created",
			{
				id: ferment.id,
				name: ferment.name,
				createdAt: ferment.createdAt,
				worktree: ferment.worktree,
			},
			1,
		),
		event(
			"scoping_goal_set",
			{
				plain: ferment.goal,
				goal: { answer: ferment.goal },
			},
			2,
		),
		event(
			"scoping_criteria_set",
			{
				plain: ferment.successCriteria,
				criteria: { answer: (ferment.successCriteria as string[]).join("\n") },
			},
			3,
		),
		event(
			"scoping_phases_set",
			{
				phases: scopingPhases,
				phaseSnapshots: ferment.phases,
			},
			4,
		),
		event("ferment_planned", {}, 5),
	]
	writeFileSync(join(fermentsDir, `${ferment.id}.events.jsonl`), `${lines.join("\n")}\n`, "utf-8")
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("ACP integration — plan sessionUpdates from ferment lifecycle", () => {
	let fixture: AcpFixture
	let previousEnv: string | undefined

	beforeEach(async () => {
		previousEnv = process.env.KIMCHI_ACTIVE_FERMENT
		process.env.KIMCHI_ACTIVE_FERMENT = FERMENT_ID
		fixture = await startAcpFixture({
			artifactName: "plan-updates",
			responses: lifecycleScripts(),
			// Advertise elicitation so the "Resume?" select goes through
			// elicitation/create (hooked by answerNextElicitationWith below)
			// instead of requestPermission (auto-approved but not hooked).
			clientCapabilities: { elicitation: { form: {} } },
		})
		seedPlannedFerment(fixture.workDir)
	}, 60_000)

	afterEach(async () => {
		if (previousEnv === undefined) delete process.env.KIMCHI_ACTIVE_FERMENT
		else process.env.KIMCHI_ACTIVE_FERMENT = previousEnv
		await fixture.stop()
	})

	it("create/update/clear lifecycle emits plan snapshots with correct statuses", {
		timeout: TEST_TIMEOUT_MS,
	}, async () => {
		// The env-var resume path asks "Resume?" via an ACP elicitation (select).
		// Answer it before newSession blocks on the selection.
		fixture.client.answerNextElicitationWith({ action: "accept", content: { value: "Resume" } })

		const sessionId = await newSession(fixture, fixture.workDir)

		// The resume path may fire a wake turn on its own (consume the first two
		// scripted responses, including activate_ferment_phase → initial plan),
		// or stay idle under the manual continuation policy — in which case the
		// first client prompt absorbs those same scripts. Wait briefly for the
		// wake path; if no plan arrives, prod with an explicit prompt.
		// Under manual continuation policy the wake path never fires, so
		// prompt immediately instead of waiting 15s (which races with the
		// resume path's model turn on slow CI runners).
		await prompt(fixture, sessionId, "continue the ferment")
		const initial = await waitForSnapshotWith(
			fixture,
			sessionId,
			(entries) => entries.length === 3 && entries.every((e) => e.status === "pending"),
			PROMPT_TIMEOUT_LONG_MS,
			"initial plan",
		)

		expect(
			initial.map((e) => e.content),
			"initial plan: phase header + both steps",
		).toEqual(["[Phase 1] Cache integration", `↳ ${STEP_1_DESC}`, `↳ ${STEP_2_DESC}`])
		expect(
			initial.every((e) => e.priority === "medium"),
			"priority medium",
		).toBe(true)

		// Start step 1 → an in_progress entry appears in the snapshot history
		// (the bridge seeds the step-scope anchor; exact content is bridge-
		// shaped so assert on status. Content shape is covered by unit tests).
		await prompt(fixture, sessionId, "start step 1")
		await waitForSnapshotWith(
			fixture,
			sessionId,
			(entries) => entries.some((e) => e.status === "in_progress"),
			PROMPT_TIMEOUT_LONG_MS,
			"step started (in_progress entry)",
		)

		// Complete step 1 → its phase-scope entry becomes completed. The
		// ferment's auto-continuation follow-up can race ahead (even firing
		// complete_ferment_phase from the scripted queue), superseding the
		// "step completed" snapshot — so accept either the completed snapshot
		// or an already-empty plan from the snapshot history.
		await prompt(fixture, sessionId, "complete step 1")
		const afterStep = await waitForSnapshotWith(
			fixture,
			sessionId,
			(entries) =>
				entries.some((e) => e.status === "completed" && e.content.includes(STEP_1_DESC)) || entries.length === 0,
			PROMPT_TIMEOUT_LONG_MS,
			"step completed entry (or raced-to-clear)",
		)
		if (afterStep.length > 0) {
			expect(
				afterStep.some((e) => e.status === "completed" && e.content.includes(STEP_1_DESC)),
				"step 1 completed in plan",
			).toBe(true)
			expect(
				afterStep.some((e) => e.status === "pending" && e.content.includes(STEP_2_DESC)),
				"step 2 still pending",
			).toBe(true)
		}

		// Complete the phase (if the auto-continuation hasn't already) → the
		// bridge clears the ferment-scope todos and the plan shrinks to an
		// empty list — the "clear" half of the lifecycle. A prompt here just
		// drains a benign text response if the phase is already complete.
		await prompt(fixture, sessionId, "complete the phase")
		await waitForSnapshotWith(
			fixture,
			sessionId,
			(entries) => entries.length === 0,
			PROMPT_TIMEOUT_LONG_MS,
			"plan cleared after phase completion",
		)
		expect(latestPlan(fixture, sessionId), "latest plan is the cleared state").toEqual([])
	})

	it("plan notifications are session-scoped — a second session sees none", { timeout: TEST_TIMEOUT_MS }, async () => {
		fixture.client.answerNextElicitationWith({ action: "accept", content: { value: "Resume" } })

		const sessionA = await newSession(fixture, fixture.workDir)

		// Under manual continuation policy the wake path never fires, so
		// prompt immediately instead of waiting 15s (which races with the
		// resume path's model turn on slow CI runners — the resume turn
		// consumes the first scripted response, leaving the prompt with a
		// no-tool-call response and no plan snapshot).
		await prompt(fixture, sessionA, "continue the ferment")
		await waitForSnapshotWith(
			fixture,
			sessionA,
			(entries) => entries.length === 3 && entries.every((e) => e.status === "pending"),
			PROMPT_TIMEOUT_LONG_MS,
			"session A initial plan",
		)

		// A second session on the same process must not get plan notifications:
		// the ferment events are emitted on session A's bus and the todo bridge
		// wrote session A's bucket, so session B's tracker has nothing to
		// correlate and emits nothing.
		const sessionB = await newSession(fixture, fixture.workDir)
		await delay(2_000) // give B's tracker a chance to misfire if it would

		expect(planSnapshots(fixture, sessionA).length, "session A received plan snapshots").toBeGreaterThan(0)
		expect(planSnapshots(fixture, sessionB), "session B received no plan snapshots").toHaveLength(0)
	})
})
