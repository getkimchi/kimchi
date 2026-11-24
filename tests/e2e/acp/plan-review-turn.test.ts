// ACP integration: submit_plan holds the PromptRequest open across the plan
// review so the approved execution turn lands INSIDE it — the client sees a
// single end_turn, sent after execution completes, instead of an end_turn at
// plan submission followed by an untracked internal turn (which previously
// also broke the NEXT client prompt with "a prompt is already in progress").
//
// The hold is pi-event-driven (submit_plan tool_execution_end → hold;
// agent_start → execution began; agent_settled → drained), plus one
// permissions notification for pi-invisible closes (rework / dismissal).

import type { ClientCapabilities } from "@agentclientprotocol/sdk/unstable"
import { afterEach, describe, expect, it } from "vitest"
import { EXECUTE_LOCAL_DECISION_OPTION } from "../../../src/extensions/ferment/plan-review.js"
import { ADVERTISED_CAPABILITIES } from "../../../src/modes/acp/capabilities.js"
import { type AcpFixture, PROMPT_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

const FULL_CAPABILITIES: ClientCapabilities = {
	fs: { readTextFile: false, writeTextFile: false },
	elicitation: { form: {} },
}

const PI_META = { "kimchi.dev": { ...ADVERTISED_CAPABILITIES } } as const

const PLAN_CONTENT =
	"# Plan: Cache Layer\n\n## Goal\nAdd caching layer.\n\n## Chunks\n\n### Chunk 1: Add cache primitive\n- **Accept When**: round-trip works"

function submitPlanResponse() {
	return {
		stream: ["Here is my plan."],
		toolCalls: [{ function: { name: "submit_plan", arguments: JSON.stringify({ plan: PLAN_CONTENT }) } }],
	}
}

function toolResponse(name: string, args: Record<string, unknown>) {
	return { toolCalls: [{ function: { name, arguments: JSON.stringify(args) } }] }
}

function stalePlanResponses() {
	return [
		toolResponse("create_todos", { todos: [{ content: "Finalize the plan", status: "in_progress" }] }),
		toolResponse("bash", { command: "printf 'finalize 1\\n'" }),
		toolResponse("bash", { command: "printf 'finalize 2\\n'" }),
		submitPlanResponse(),
	]
}

function chatBodies(target: AcpFixture) {
	return target.fake.requests
		.filter((request) => request.method === "POST" && request.url.startsWith("/openai/v1/chat/completions"))
		.map((request) => JSON.stringify(request.body ?? ""))
}

describe("ACP integration — plan review held prompt", () => {
	let fixture: AcpFixture | undefined

	afterEach(async () => {
		await fixture?.stop()
		fixture = undefined
	})

	it(
		"execute: prompt stays open across review, execution streams inside it, follow-up prompt works",
		async () => {
			fixture = await startAcpFixture({
				artifactName: "plan-review-execute",
				extraArgs: ["--plan"],
				responses: [submitPlanResponse(), { stream: ["Plan executed."] }, { stream: ["follow-up ok"] }],
				clientCapabilities: FULL_CAPABILITIES,
				clientMeta: PI_META,
			})
			const sessionId = await newSession(fixture, fixture.workDir)
			fixture.client.answerNextElicitationWith({ action: "accept", content: { value: EXECUTE_LOCAL_DECISION_OPTION } })

			// The held prompt resolves only after the approved execution turn
			// drives agent_settled — a single end_turn for the whole flow.
			const t1 = await prompt(fixture, sessionId, "Make me a plan for the cache layer")
			expect(t1.stopReason, "plan review prompt stop reason").toBe("end_turn")
			expect(t1.chunks, "execution streamed inside the held prompt").toContain("Plan executed.")

			// The client saw the plan-review menu while the prompt was in flight.
			expect(fixture.client.elicitationRequests.length, "plan review menu shown").toBeGreaterThan(0)
			expect(JSON.stringify(fixture.client.elicitationRequests[0].params)).toContain("Plan complete")

			// The original bug: the next prompt failed with "a prompt is already
			// in progress". The session must be genuinely idle now.
			const t2 = await prompt(fixture, sessionId, "How did the execution go?")
			expect(t2.stopReason).toBe("end_turn")
			expect(t2.chunks).toContain("follow-up ok")
		},
		PROMPT_TIMEOUT_MS,
	)

	it(
		"execute: plan check-in is delivered with the approval turn",
		async () => {
			fixture = await startAcpFixture({
				artifactName: "plan-review-todo-checkin",
				extraArgs: ["--plan"],
				responses: [
					...stalePlanResponses(),
					toolResponse("bash", { command: "printf 'blocked until reconciliation\\n'" }),
					toolResponse("mark_todo", { id: 1, status: "completed" }),
					toolResponse("bash", { command: "printf 'executed\\n'" }),
					{ stream: ["Plan executed with reconciled todos."] },
				],
				clientCapabilities: FULL_CAPABILITIES,
				clientMeta: PI_META,
			})
			const sessionId = await newSession(fixture, fixture.workDir)
			fixture.client.answerNextElicitationWith({ action: "accept", content: { value: EXECUTE_LOCAL_DECISION_OPTION } })

			const result = await prompt(fixture, sessionId, "Plan and execute the cache layer")
			expect(result.stopReason).toBe("end_turn")
			expect(result.chunks).toContain("Plan executed with reconciled todos.")

			const bodies = chatBodies(fixture)
			// Requests 0–3 produce the list, Finalize the plan with two work
			// calls, then submit. Request 4 begins approved execution and must
			// carry both the approval and the deferred check-in instruction.
			const checkinTurn = bodies.findIndex((body) => body.includes("The plan was submitted for review"))
			expect(checkinTurn).toBe(4)
			expect(bodies[checkinTurn]).toContain("The user approved the plan")
			expect(bodies[checkinTurn + 1]).toContain("check-in pending (input revision 1)")
		},
		PROMPT_TIMEOUT_MS,
	)

	it(
		"rework: no model turn occurs during review and the next prompt carries the deferred check-in",
		async () => {
			fixture = await startAcpFixture({
				artifactName: "plan-review-rework",
				extraArgs: ["--plan"],
				responses: [...stalePlanResponses(), { stream: ["revised plan"] }],
				clientCapabilities: FULL_CAPABILITIES,
				clientMeta: PI_META,
			})
			const sessionId = await newSession(fixture, fixture.workDir)
			fixture.client.answerNextElicitationWith({ action: "accept", content: { value: "Rework the plan" } })

			const t1 = await prompt(fixture, sessionId, "Make me a plan for the cache layer")
			expect(t1.stopReason).toBe("end_turn")
			expect(t1.chunks).toContain("Here is my plan.")
			// Four requests create the stale list, finalize the plan twice, and
			// submit it. No model request is valid before or after the rework
			// decision while the held prompt closes.
			expect(chatBodies(fixture)).toHaveLength(4)
			expect(t1.chunks).not.toContain("revised plan")

			const t2 = await prompt(fixture, sessionId, "Revise the plan")
			expect(t2.stopReason).toBe("end_turn")
			expect(t2.chunks).toContain("revised plan")
			const bodies = chatBodies(fixture)
			expect(bodies[4]).toContain("Revise the plan")
			expect(bodies[4]).toContain("The plan was submitted for review")
		},
		PROMPT_TIMEOUT_MS,
	)

	it(
		"dismissal: no model turn occurs during review and the next prompt carries the deferred check-in",
		async () => {
			fixture = await startAcpFixture({
				artifactName: "plan-review-dismissal",
				extraArgs: ["--plan"],
				responses: [...stalePlanResponses(), { stream: ["clean slate"] }],
				clientCapabilities: FULL_CAPABILITIES,
				clientMeta: PI_META,
			})
			const sessionId = await newSession(fixture, fixture.workDir)
			// Dismiss the review menu (accept with no value → select returns
			// undefined). The recorded-client default is exactly that.
			const t1 = await prompt(fixture, sessionId, "Make me a plan for the cache layer")
			expect(t1.stopReason).toBe("end_turn")
			expect(chatBodies(fixture)).toHaveLength(4)
			expect(t1.chunks).not.toContain("clean slate")

			const t2 = await prompt(fixture, sessionId, "Start over")
			expect(t2.stopReason).toBe("end_turn")
			expect(t2.chunks).toContain("clean slate")
			const bodies = chatBodies(fixture)
			expect(bodies[4]).toContain("Start over")
			expect(bodies[4]).toContain("The plan was submitted for review")
		},
		PROMPT_TIMEOUT_MS,
	)
})
