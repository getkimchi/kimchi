// ACP integration: submit_plan holds the PromptRequest open across the plan
// review so the approved execution turn lands INSIDE it — the client sees a
// single end_turn, sent after execution completes, instead of an end_turn at
// plan submission followed by an untracked internal turn (which previously
// also broke the NEXT client prompt with "a prompt is already in progress").
//
// The hold is pi-event-driven (submit_plan tool_execution_end → hold;
// agent_start → execution began; agent_settled → drained), plus one
// permissions notification for pi-invisible closes (rework / dismissal).

import type { ClientCapabilities } from "@agentclientprotocol/sdk"
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
		"rework: end_turn after the decision with no execution turn",
		async () => {
			fixture = await startAcpFixture({
				artifactName: "plan-review-rework",
				extraArgs: ["--plan"],
				responses: [submitPlanResponse(), { stream: ["revised plan"] }],
				clientCapabilities: FULL_CAPABILITIES,
				clientMeta: PI_META,
			})
			const sessionId = await newSession(fixture, fixture.workDir)
			fixture.client.answerNextElicitationWith({ action: "accept", content: { value: "Rework the plan" } })

			const t1 = await prompt(fixture, sessionId, "Make me a plan for the cache layer")
			expect(t1.stopReason).toBe("end_turn")
			expect(t1.chunks).toContain("Here is my plan.")
			// No execution turn started — the follow-up response is unread.
			expect(t1.chunks).not.toContain("revised plan")

			const t2 = await prompt(fixture, sessionId, "Revise the plan")
			expect(t2.stopReason).toBe("end_turn")
			expect(t2.chunks).toContain("revised plan")
		},
		PROMPT_TIMEOUT_MS,
	)

	it(
		"dismissal: menu cancelled with no decision closes the held prompt with end_turn",
		async () => {
			fixture = await startAcpFixture({
				artifactName: "plan-review-dismissal",
				extraArgs: ["--plan"],
				responses: [submitPlanResponse(), { stream: ["clean slate"] }],
				clientCapabilities: FULL_CAPABILITIES,
				clientMeta: PI_META,
			})
			const sessionId = await newSession(fixture, fixture.workDir)
			// Dismiss the review menu (accept with no value → select returns
			// undefined). The recorded-client default is exactly that.
			const t1 = await prompt(fixture, sessionId, "Make me a plan for the cache layer")
			expect(t1.stopReason).toBe("end_turn")

			const t2 = await prompt(fixture, sessionId, "Start over")
			expect(t2.stopReason).toBe("end_turn")
			expect(t2.chunks).toContain("clean slate")
		},
		PROMPT_TIMEOUT_MS,
	)
})
