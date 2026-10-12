// ACP integration — a prompt refused by the gateway content filter must not be
// replayed to the model, so the next prompt in the session is answered.

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	FOLLOW_UP_REPLY,
	REFUSED_PROMPT,
	REFUSED_TURN_RESPONSES,
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

	it("answers the next prompt after a content-filter refusal", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)

		await prompt(fixture, sessionId, REFUSED_PROMPT)
		const followUp = await prompt(fixture, sessionId, "hi")

		expect(followUp.stopReason).toBe("end_turn")
		expect(followUp.chunks).toContain(FOLLOW_UP_REPLY)
		const requests = chatRequests(fixture)
		expect(requests.some(sendsRefusedPrompt)).toBe(true)
		expect(sendsRefusedPrompt(requests[requests.length - 1])).toBe(false)
	})
})
