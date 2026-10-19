// ACP integration — todo closure check and check-in gate parity.
//
// Mirrors the TUI workflows in tests/e2e/tui/todos-dangling-active.test.ts
// on the protocol surface: a request answered without work tools still gets
// the bounded once-per-request cleanup continuation for dangling todos, a
// real reconciliation followed by a text-only answer suppresses it, and the
// check-in gate releases work tools after a confirmation that writes
// nothing — with the gate state published under plan `_meta["kimchi.dev"]`.

import { setTimeout as delay } from "node:timers/promises"
import type { Plan } from "@agentclientprotocol/sdk"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, PROMPT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession } from "./support/scenarios.js"

const CLOSURE_PHRASE = "The turn ended with unfinished todos"

function providerBodies(fixture: AcpFixture): string[] {
	return fixture.fake.requests
		.filter((request) => request.method === "POST" && request.url.startsWith("/openai/v1/chat/completions"))
		.map((request) => JSON.stringify(request.body ?? ""))
}

function planUpdates(fixture: AcpFixture, sessionId: string): Plan[] {
	return fixture.client.sessionUpdates
		.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "plan")
		.map((u) => u.update as Plan)
}

function todoCheckinMeta(plan: Plan): { inputRevision: number; pendingScopes: unknown[] } | undefined {
	const meta = (
		plan._meta as { "kimchi.dev"?: { todoCheckin?: { inputRevision: number; pendingScopes: unknown[] } } }
	)?.["kimchi.dev"]
	return meta?.todoCheckin
}

describe("ACP integration — todo closure and check-in gate", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-todos-checkin",
			responses: [
				// Prompt 1: plan only. The create_todos write reconciles, so the
				// text-only answer needs no cleanup continuation.
				{
					toolCalls: [
						{
							function: {
								name: "create_todos",
								arguments: JSON.stringify({
									todos: [{ content: "Publish after approval", status: "pending" }],
								}),
							},
						},
					],
				},
				{ stream: ["Publishing is deferred."] },
				// Prompt 2: answered without any work tools — the bounded
				// closure check fires once for the old unfinished todo.
				{ stream: ["The total is 42."] },
				{
					toolCalls: [
						{
							function: {
								name: "mark_todo",
								arguments: JSON.stringify({ id: 1, status: "pending", note: "Deferred until approval" }),
							},
						},
					],
				},
				{ stream: ["Cleanup check finished."] },
				{ stream: ["<done>"] },
				// Prompt 3: the plan still fits — confirm the unchanged list
				// (input revision 3) and then work.
				{
					toolCalls: [
						{
							function: {
								name: "confirm_todos",
								arguments: JSON.stringify({
									inputRevision: 3,
									expected: [{ id: 1, status: "pending" }],
								}),
							},
						},
					],
				},
				{
					toolCalls: [{ function: { name: "bash", arguments: JSON.stringify({ command: "printf '42\\n'" }) } }],
				},
				{ stream: ["Verified 42. Publishing still waits for approval."] },
				// Work completed after the confirmation, so the bounded terminal
				// closure check stays eligible: one cleanup continuation.
				{
					toolCalls: [
						{
							function: {
								name: "mark_todo",
								arguments: JSON.stringify({ id: 1, status: "pending", note: "Still deferred" }),
							},
						},
					],
				},
				{ stream: ["Cleanup check finished."] },
			],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("runs the bounded cleanup without work tools, then releases the gate on confirmation", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)

		// Prompt 1: create + plan. The write reconciles the list for this
		// input, so the text-only settle needs no cleanup continuation.
		let result = await Promise.race([
			fixture.conn.prompt({
				sessionId,
				prompt: [{ type: "text", text: "Create a pending todo to publish after approval. Do no task work." }],
			}),
			delay(PROMPT_TIMEOUT_MS).then(() => ({ stopReason: "TIMEOUT" as const })),
		])
		expect(result.stopReason).toBe("end_turn")
		let bodies = providerBodies(fixture)
		expect(bodies).toHaveLength(2)
		expect(bodies.some((body) => body.includes(CLOSURE_PHRASE))).toBe(false)

		// Prompt 2: no work tools anywhere in the request — the once-per-request
		// cleanup continuation still fires for the dangling deferred todo.
		result = await Promise.race([
			fixture.conn.prompt({
				sessionId,
				prompt: [{ type: "text", text: "Just repeat the total; do not call tools or publish." }],
			}),
			delay(PROMPT_TIMEOUT_MS).then(() => ({ stopReason: "TIMEOUT" as const })),
		])
		expect(result.stopReason).toBe("end_turn")
		bodies = providerBodies(fixture)
		// Text answer, cleanup continuation (mark), final answer, and the
		// general continuation-nudge acknowledgement for the tool-less run.
		expect(bodies).toHaveLength(6)
		// The closure steer rode the continuation after the text-only answer;
		// it persists in history afterwards, so assert on its arrival turn.
		expect(bodies[2]).not.toContain(CLOSURE_PHRASE)
		expect(bodies[3]).toContain(CLOSURE_PHRASE)

		// The check-in gate opened with the second prompt (unfinished list,
		// new input) and surfaced in the plan metadata as a pending scope.
		const plans = planUpdates(fixture, sessionId)
		expect(plans.length).toBeGreaterThan(0)
		expect(
			plans.some((plan) => {
				const checkin = todoCheckinMeta(plan)
				return checkin?.pendingScopes?.some((scope) => (scope as { kind?: string }).kind === "global")
			}),
			"pending check-in scope published under plan _meta",
		).toBe(true)

		// Prompt 3: the plan is unchanged — the model confirms without a store
		// write (the gate releases), then works, then answers. The reconciled
		// list needs no extra cleanup continuation.
		result = await Promise.race([
			fixture.conn.prompt({
				sessionId,
				prompt: [{ type: "text", text: "Check the total with printf; the publishing plan is unchanged." }],
			}),
			delay(PROMPT_TIMEOUT_MS).then(() => ({ stopReason: "TIMEOUT" as const })),
		])
		expect(result.stopReason).toBe("end_turn")
		bodies = providerBodies(fixture)
		// Instruction rode the first request; then confirm, work, final
		// answer, and one bounded cleanup continuation after the work. The
		// earlier closure steer persists in history, so assert on the arrival
		// turn of this request's own closure check.
		expect(bodies).toHaveLength(11)
		const confirmTurn = bodies[6]
		expect(confirmTurn.includes("reconcile")).toBe(true)
		expect(bodies[9]).toContain(CLOSURE_PHRASE)

		// The gate closed after the confirmation: the last plan metadata
		// carries explicit empty pendingScopes, and the deferred entry
		// survives in the displayed entries.
		const lastPlan = plans.at(-1)
		expect(todoCheckinMeta(lastPlan ?? ({} as Plan))?.pendingScopes).toEqual([])
		expect(JSON.stringify(lastPlan?.entries)).toContain("Publish after approval")
	})
})

describe("ACP integration — gated-input revision supersession", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-todos-checkin-superseded",
			responses: [
				// Prompt 1: create the list, then answer.
				{
					toolCalls: [
						{
							function: {
								name: "create_todos",
								arguments: JSON.stringify({ todos: [{ content: "Verify the input", status: "pending" }] }),
							},
						},
					],
				},
				{ stream: ["Tracking the task now."] },
				// Prompt 2 (input revision 2 — changed direction): work tools are
				// blocked while the check is pending; a repeated attempt returns the
				// current instructions.
				{
					toolCalls: [
						{ function: { name: "bash", arguments: JSON.stringify({ command: "printf 'first attempt\\n'" }) } },
					],
				},
				{
					toolCalls: [
						{ function: { name: "bash", arguments: JSON.stringify({ command: "printf 'second attempt\\n'" }) } },
					],
				},
				// A question to the user ends the turn — awaiting an answer, so
				// neither the closure check nor the continuation nudge fires.
				{ stream: ["Both attempts are blocked by the check-in. Should I proceed with the current direction?"] },
				// Prompt 3 (input revision 3 — the latest direction): the model
				// still holds revision 2 from the block reason, so its confirmation
				// is stale — rejected with the current revision.
				{
					toolCalls: [
						{
							function: {
								name: "confirm_todos",
								arguments: JSON.stringify({ inputRevision: 2, expected: [{ id: 1, status: "pending" }] }),
							},
						},
					],
				},
				// Reconciling against the latest direction is what unlocks work.
				{
					toolCalls: [
						{
							function: {
								name: "confirm_todos",
								arguments: JSON.stringify({ inputRevision: 3, expected: [{ id: 1, status: "pending" }] }),
							},
						},
					],
				},
				{ toolCalls: [{ function: { name: "bash", arguments: JSON.stringify({ command: "printf 'resumed\\n'" }) } }] },
				{ stream: ["All done with the new direction."] },
				{ stream: ["<done>"] },
			],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("requires reconciliation against the latest direction while gated", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)

		let result = await Promise.race([
			fixture.conn.prompt({
				sessionId,
				prompt: [{ type: "text", text: "Verify the input and keep the list accurate." }],
			}),
			delay(PROMPT_TIMEOUT_MS).then(() => ({ stopReason: "TIMEOUT" as const })),
		])
		expect(result.stopReason).toBe("end_turn")

		result = await Promise.race([
			fixture.conn.prompt({
				sessionId,
				prompt: [{ type: "text", text: "Now do it differently." }],
			}),
			delay(PROMPT_TIMEOUT_MS).then(() => ({ stopReason: "TIMEOUT" as const })),
		])
		expect(result.stopReason).toBe("end_turn")
		const bodies = providerBodies(fixture)
		// The gate blocked work against revision 2 and carried its instructions.
		expect(bodies.some((body) => body.includes("check-in pending (input revision 2)"))).toBe(true)

		result = await Promise.race([
			fixture.conn.prompt({
				sessionId,
				prompt: [{ type: "text", text: "Actually, redo it the new way instead." }],
			}),
			delay(PROMPT_TIMEOUT_MS).then(() => ({ stopReason: "TIMEOUT" as const })),
		])
		expect(result.stopReason).toBe("end_turn")

		// The newer direction superseded the pending check: the revision-2
		// confirmation was rejected as stale, only revision 3 released work,
		// no block ever carried revision 3, and the work ran.
		const history = JSON.stringify(providerBodies(fixture))
		expect(history).toContain("The accepted input revision is now 3 (you confirmed revision 2)")
		expect(history).toContain("Confirmed 1 todos")
		expect(history).not.toContain("check-in pending (input revision 3)")
		expect(history).toContain("resumed")
	})
})

describe("ACP integration — staleness escalation", () => {
	let fixture: AcpFixture

	const workCall = (index: number) => ({
		toolCalls: [
			{ function: { name: "bash", arguments: JSON.stringify({ command: `printf 'work ${index} done\\n'` }) } },
		],
	})

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-todos-checkin-escalation",
			responses: [
				// Prompt 1: create the list, then fifty work calls — reminders
				// recur at every boundary of ten with no ceiling.
				{
					toolCalls: [
						{
							function: {
								name: "create_todos",
								arguments: JSON.stringify({ todos: [{ content: "Long task", status: "in_progress" }] }),
							},
						},
					],
				},
				...Array.from({ length: 50 }, (_, index) => workCall(index)),
				// The 51st work call is blocked: the list aged past 50 while
				// ignoring delivered boundary-30+ reminders, so the gate opened.
				workCall(50),
				// A wrong confirmation is rejected with the actual state…
				{
					toolCalls: [
						{
							function: {
								name: "confirm_todos",
								arguments: JSON.stringify({ inputRevision: 1, expected: [{ id: 1, status: "completed" }] }),
							},
						},
					],
				},
				// …and the matching one resumes work.
				{
					toolCalls: [
						{
							function: {
								name: "confirm_todos",
								arguments: JSON.stringify({ inputRevision: 1, expected: [{ id: 1, status: "in_progress" }] }),
							},
						},
					],
				},
				workCall(51),
				{ stream: ["All checked in and verified."] },
				{ stream: ["<done>"] },
			],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("escalates after ignored reminders, rejects a wrong confirm, resumes on the right one", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)

		const result = await Promise.race([
			fixture.conn.prompt({
				sessionId,
				prompt: [{ type: "text", text: "Do the long task. Keep the todo list accurate as you go." }],
			}),
			delay(PROMPT_TIMEOUT_MS).then(() => ({ stopReason: "TIMEOUT" as const })),
		])
		expect(result.stopReason).toBe("end_turn")

		const history = JSON.stringify(providerBodies(fixture))
		// Reminders recurred at every boundary of ten, scope-labelled.
		expect(history).toContain("10 changes since the global todo list was last updated")
		expect(history).toContain("50 changes since the global todo list was last updated")
		// The gate blocked the 51st work call with the check-in reason.
		expect(history).toContain("check-in pending (input revision 1)")
		// The wrong confirmation was rejected with the actual state…
		expect(history).toContain("status mismatches")
		expect(history).toContain("[in_progress] #1 Long task")
		// …the right one resumed work.
		expect(history).toContain("Confirmed 1 todos")
		expect(history).toContain("work 51 done")

		// The gate opened and closed on the plan metadata surface.
		const plans = planUpdates(fixture, sessionId)
		expect(
			plans.some((plan) => {
				const checkin = todoCheckinMeta(plan)
				return checkin?.pendingScopes?.some((scope) => (scope as { kind?: string }).kind === "global")
			}),
			"pending check-in scope published under plan _meta",
		).toBe(true)
		expect(todoCheckinMeta(plans.at(-1) ?? ({} as Plan))?.pendingScopes).toEqual([])
	})
})
