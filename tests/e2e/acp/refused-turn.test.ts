// ACP integration — a prompt refused by the gateway content filter must not be
// replayed to the model, so the next prompt in the session is answered.

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	DETAILED_REFUSED_TURN_RESPONSES,
	FOLLOW_UP_REPLY,
	REFUSAL_REASON,
	REFUSAL_TEXT,
	REFUSED_PROMPT,
	REFUSED_TURN_RESPONSES,
	SAFEGUARDS_NOTICE,
	sendsRefusedPrompt,
} from "../tui/support/refused-turn.js"
import { chatRequests } from "../tui/support/wire-requests.js"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

describe("ACP integration — refused turn", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({ artifactName: "refused-turn", responses: REFUSED_TURN_RESPONSES })
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("ends a refused turn with stopReason refusal and answers the next prompt", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)

		const refused = await prompt(fixture, sessionId, REFUSED_PROMPT)
		expect(refused.stopReason).toBe("refusal")
		expect(refused.chunks).toContain(REFUSAL_REASON)
		// Unlike the TUI, ACP chunks are append-only: the canned text streamed before
		// the refusal was detected stays visible, and the reason follows it.
		expect(refused.chunks).toContain(REFUSAL_TEXT)
		const followUp = await prompt(fixture, sessionId, "hi")

		expect(followUp.stopReason).toBe("end_turn")
		expect(followUp.chunks).toContain(FOLLOW_UP_REPLY)
		const requests = chatRequests(fixture)
		expect(requests.some(sendsRefusedPrompt)).toBe(true)
		expect(sendsRefusedPrompt(requests[requests.length - 1])).toBe(false)
	})

	it("ends a guardrail refusal with stopReason refusal and the detailed safeguards notice", async () => {
		await fixture.stop()
		fixture = await startAcpFixture({
			artifactName: "refused-turn-details",
			responses: DETAILED_REFUSED_TURN_RESPONSES,
		})
		const sessionId = await newSession(fixture, fixture.workDir)

		const refused = await prompt(fixture, sessionId, REFUSED_PROMPT)

		expect(refused.stopReason).toBe("refusal")
		expect(refused.chunks).toContain(SAFEGUARDS_NOTICE)
		// ACP chunks are append-only: the canned text streamed before the refusal
		// was detected stays visible, followed by the notice — once, not twice.
		expect(refused.chunks.split(SAFEGUARDS_NOTICE)).toHaveLength(2)
		expect(refused.chunks).toContain(REFUSAL_TEXT)

		const followUp = await prompt(fixture, sessionId, "hi")

		expect(followUp.stopReason).toBe("end_turn")
		expect(followUp.chunks).toContain(FOLLOW_UP_REPLY)
		const requests = chatRequests(fixture)
		expect(requests.some(sendsRefusedPrompt)).toBe(true)
		expect(sendsRefusedPrompt(requests[requests.length - 1])).toBe(false)
	})
})
