// ACP integration: todo writes surface as stable-v1 `plan` session updates.
//
// IDEs (Zed natively) render `sessionUpdate: "plan"` as a live checklist.
// This test drives create_todos / update_todos / clear_todos tool calls via a
// scripted model and asserts the plan snapshots the client receives: full-
// replacement semantics, the mapped entry lifecycle (incl. activeForm content
// and blocked Todo metadata), scope metadata under Plan._meta, empty entries
// on clear, and per-session isolation of the notification stream.

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { ClientCapabilities } from "@agentclientprotocol/sdk"
import { afterEach, describe, expect, it } from "vitest"
import { ADVERTISED_CAPABILITIES } from "../../../src/modes/acp/capabilities.js"
import { type AcpFixture, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

const FULL_CAPABILITIES: ClientCapabilities = {
	fs: { readTextFile: false, writeTextFile: false },
	elicitation: { form: {} },
}

const PI_META = { "kimchi.dev": { ...ADVERTISED_CAPABILITIES } } as const
const FERMENT_ID = "ferment-plan-e2e"
const PHASE_ID = "phase-1"
const STEP_ID = "step-1"
const STEP_DESCRIPTION = "Write unit tests"
const PLAN_WAIT_MS = 90_000

function textResponse(text: string) {
	return { stream: [text] }
}

function toolCallResponse(name: string, args: Record<string, unknown>) {
	return {
		stream: ["Working."],
		toolCalls: [{ function: { name, arguments: JSON.stringify(args) } }],
	}
}

interface PlanEntryLike {
	_meta?: unknown
	content: string
	status: string
}

function planSnapshots(fixture: AcpFixture, sessionId: string): Array<{ entries: PlanEntryLike[]; _meta?: unknown }> {
	return fixture.client.sessionUpdates
		.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "plan")
		.map((u) => u.update as { entries: PlanEntryLike[]; _meta?: unknown })
}

async function waitForPlanSnapshot(
	fixture: AcpFixture,
	sessionId: string,
	predicate: (entries: PlanEntryLike[]) => boolean,
	context: string,
	timeoutMs = PLAN_WAIT_MS,
): Promise<PlanEntryLike[]> {
	const startedAt = Date.now()
	while (Date.now() - startedAt < timeoutMs) {
		const match = planSnapshots(fixture, sessionId).find(({ entries }) => predicate(entries))
		if (match) return match.entries
		await delay(100)
	}
	throw new Error(`${context}: ${JSON.stringify(planSnapshots(fixture, sessionId))}`)
}

function fermentLifecycleResponses() {
	const ids = { ferment_id: FERMENT_ID, phase_id: PHASE_ID }
	const stepGates = [
		{ id: "S1", verdict: "pass", rationale: "Summary matches work", evidence: "ACP E2E" },
		{ id: "S2", verdict: "pass", rationale: "Verification is honest", evidence: "ACP E2E" },
		{ id: "S3", verdict: "pass", rationale: "Edge cases considered", evidence: "ACP E2E" },
	]
	const phaseGates = [
		{ id: "F1", verdict: "pass", rationale: "Verification ran", evidence: "ACP E2E" },
		{ id: "F2", verdict: "pass", rationale: "Goal met", evidence: "ACP E2E" },
		{ id: "F3", verdict: "pass", rationale: "Nothing deferred", evidence: "ACP E2E" },
	]
	return [
		toolCallResponse("activate_ferment_phase", ids),
		textResponse("Phase activated."),
		toolCallResponse("start_ferment_step", { ...ids, step_id: STEP_ID }),
		textResponse("Step started."),
		toolCallResponse("complete_ferment_step", {
			...ids,
			step_id: STEP_ID,
			summary: "Tests written.",
			gates: stepGates,
		}),
		textResponse("Step completed."),
		toolCallResponse("complete_ferment_phase", {
			...ids,
			summary: "Phase completed.",
			evidence: "ACP E2E",
			gates: phaseGates,
		}),
		textResponse("Phase completed."),
		textResponse("Understood."),
		textResponse("Understood."),
	]
}

function seedPlannedFerment(workDir: string): void {
	const now = new Date().toISOString()
	const ferment = {
		id: FERMENT_ID,
		name: "ACP plan E2E",
		status: "planned",
		goal: "Exercise Todo-backed ACP updates.",
		successCriteria: ["The phase completes"],
		constraints: [],
		assumptions: "",
		worktree: { path: workDir },
		scoping: {},
		phases: [
			{
				id: PHASE_ID,
				index: 1,
				name: "ACP checklist",
				goal: "Exercise the Todo bridge.",
				status: "planned",
				steps: [{ id: STEP_ID, index: 1, description: STEP_DESCRIPTION, status: "pending" }],
			},
		],
		decisions: [],
		memories: [],
		createdAt: now,
		updatedAt: now,
	}
	const fermentsDir = join(workDir, ".kimchi", "ferments")
	mkdirSync(fermentsDir, { recursive: true })
	writeFileSync(join(fermentsDir, `${FERMENT_ID}.json`), JSON.stringify(ferment, null, "\t"), "utf-8")

	const event = (type: string, payload: unknown, offset: number) =>
		JSON.stringify({
			id: `${FERMENT_ID}-e${offset}`,
			timestamp: new Date(Date.parse(now) + offset * 1000).toISOString(),
			type,
			preStateHash: "0",
			postStateHash: "0",
			payload,
		})
	const events = [
		event("ferment_created", { id: FERMENT_ID, name: ferment.name, createdAt: now, worktree: ferment.worktree }, 1),
		event("scoping_goal_set", { plain: ferment.goal, goal: { answer: ferment.goal } }, 2),
		event(
			"scoping_criteria_set",
			{ plain: ferment.successCriteria, criteria: { answer: ferment.successCriteria.join("\n") } },
			3,
		),
		event("scoping_phases_set", { phaseSnapshots: ferment.phases }, 4),
		event("ferment_planned", {}, 5),
	]
	writeFileSync(join(fermentsDir, `${FERMENT_ID}.events.jsonl`), `${events.join("\n")}\n`, "utf-8")
}

describe("ACP integration — plan updates from todo writes", () => {
	let fixture: AcpFixture

	async function startWith(responses: Array<Record<string, unknown>>, extraArgs: string[] = []): Promise<void> {
		fixture = await startAcpFixture({
			artifactName: "plan-updates",
			responses,
			clientCapabilities: FULL_CAPABILITIES,
			clientMeta: PI_META,
			extraArgs,
		})
	}

	afterEach(async () => {
		await fixture.stop()
	})

	it("emits replacement plan snapshots across create, update, and clear", async () => {
		await startWith([
			// Turn 1: create two todos, one in progress with an activeForm.
			toolCallResponse("create_todos", {
				todos: [
					{ id: 1, content: "wire emission", status: "in_progress", activeForm: "wiring emission" },
					{ id: 2, content: "deploy", status: "blocked", note: "waiting on ops" },
				],
			}),
			textResponse("Todos created."),
			// Turn 2: complete the first, unblock the second into in_progress.
			toolCallResponse("update_todos", {
				todos: [
					{ id: 1, content: "wire emission", status: "completed" },
					{ id: 2, content: "deploy", status: "in_progress", activeForm: "deploying" },
				],
			}),
			textResponse("Todos updated."),
			// Turn 3: clear the list entirely.
			toolCallResponse("clear_todos", {}),
			textResponse("Todos cleared."),
		])
		const sessionId = await newSession(fixture, fixture.workDir)

		expect((await prompt(fixture, sessionId, "Create the todo list")).stopReason).toBe("end_turn")

		const afterCreate = planSnapshots(fixture, sessionId)
		expect(afterCreate).toHaveLength(1)
		expect(afterCreate[0].entries).toEqual([
			{ content: "wiring emission", priority: "medium", status: "in_progress" },
			{
				content: "deploy",
				priority: "medium",
				status: "pending",
				_meta: { "kimchi.dev": { todoStatus: "blocked", note: "waiting on ops" } },
			},
		])
		// Scope metadata rides Plan._meta; spec-compliant clients ignore it.
		expect(afterCreate[0]._meta).toEqual({ "kimchi.dev": { scope: { kind: "global" } } })

		expect((await prompt(fixture, sessionId, "Advance the todo list")).stopReason).toBe("end_turn")

		const afterUpdate = planSnapshots(fixture, sessionId)
		expect(afterUpdate).toHaveLength(2)
		// Full replacement, not a patch: the client swaps the whole list.
		expect(afterUpdate[1].entries).toEqual([
			{ content: "wire emission", priority: "medium", status: "completed" },
			{ content: "deploying", priority: "medium", status: "in_progress" },
		])

		expect((await prompt(fixture, sessionId, "Clear the todo list")).stopReason).toBe("end_turn")

		const afterClear = planSnapshots(fixture, sessionId)
		expect(afterClear).toHaveLength(3)
		expect(afterClear[2].entries).toEqual([])
	})

	it("scopes plan notifications to the owning session", async () => {
		await startWith([
			toolCallResponse("create_todos", {
				todos: [{ id: 1, content: "session B task", status: "pending" }],
			}),
			textResponse("Session B todos created."),
		])
		const sessionA = await newSession(fixture, fixture.workDir)
		const sessionB = await newSession(fixture, fixture.workDir)

		expect((await prompt(fixture, sessionB, "Create todos for session B")).stopReason).toBe("end_turn")

		const plansB = planSnapshots(fixture, sessionB)
		expect(plansB).toHaveLength(1)
		expect(plansB[0].entries).toEqual([{ content: "session B task", priority: "medium", status: "pending" }])
		expect(planSnapshots(fixture, sessionA)).toHaveLength(0)
	})

	it("emits regular Todo updates while the session is in plan mode", async () => {
		await startWith(
			[
				toolCallResponse("create_todos", {
					todos: [{ id: 1, content: "research the change", status: "in_progress" }],
				}),
				textResponse("Planning todos created."),
			],
			["--plan"],
		)
		const sessionId = await newSession(fixture, fixture.workDir)

		expect((await prompt(fixture, sessionId, "Track the planning work")).stopReason).toBe("end_turn")

		expect(planSnapshots(fixture, sessionId)).toEqual([
			{
				sessionUpdate: "plan",
				entries: [{ content: "research the change", priority: "medium", status: "in_progress" }],
				_meta: { "kimchi.dev": { scope: { kind: "global" } } },
			},
		])
	})

	it("mirrors the Ferment phase and step lifecycle through the Todo store", { timeout: 180_000 }, async () => {
		const previousActiveFerment = process.env.KIMCHI_ACTIVE_FERMENT
		process.env.KIMCHI_ACTIVE_FERMENT = FERMENT_ID
		try {
			await startWith(fermentLifecycleResponses())
			seedPlannedFerment(fixture.workDir)
			fixture.client.answerNextElicitationWith({ action: "accept", content: { value: "Resume" } })

			const sessionId = await newSession(fixture, fixture.workDir)
			const initial = await waitForPlanSnapshot(
				fixture,
				sessionId,
				(entries) => entries.some((entry) => entry.content.includes(STEP_DESCRIPTION)),
				"Ferment phase Todo snapshot did not arrive",
				8_000,
			).catch(async () => {
				await prompt(fixture, sessionId, "Continue the Ferment")
				return waitForPlanSnapshot(
					fixture,
					sessionId,
					(entries) => entries.some((entry) => entry.content.includes(STEP_DESCRIPTION)),
					"Prompt-driven Ferment phase Todo snapshot did not arrive",
				)
			})
			expect(initial.some((entry) => entry.status === "pending" && entry.content.includes(STEP_DESCRIPTION))).toBe(true)

			await prompt(fixture, sessionId, "Start the step")
			await waitForPlanSnapshot(
				fixture,
				sessionId,
				(entries) => entries.length === 1 && entries[0].status === "in_progress",
				"Ferment step Todo snapshot did not arrive",
			)

			await prompt(fixture, sessionId, "Complete the step")
			await waitForPlanSnapshot(
				fixture,
				sessionId,
				(entries) =>
					entries.length === 0 ||
					entries.some((entry) => entry.status === "completed" && entry.content.includes(STEP_DESCRIPTION)),
				"Completed Ferment step Todo snapshot did not arrive",
			)

			await prompt(fixture, sessionId, "Complete the phase")
			await waitForPlanSnapshot(
				fixture,
				sessionId,
				(entries) => entries.length === 0,
				"Cleared Ferment phase Todo snapshot did not arrive",
			)
		} finally {
			if (previousActiveFerment === undefined) Reflect.deleteProperty(process.env, "KIMCHI_ACTIVE_FERMENT")
			else process.env.KIMCHI_ACTIVE_FERMENT = previousActiveFerment
		}
	})
})
