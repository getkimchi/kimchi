import { expect, test } from "@microsoft/tui-test"
import { waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import {
	FOLLOW_UP_REPLY,
	REFUSAL_REASON,
	REFUSAL_TEXT,
	REFUSED_PROMPT,
	REFUSED_TURN_RESPONSES,
	sendsRefusedPrompt,
} from "./support/refused-turn.js"
import { chatRequests } from "./support/wire-requests.js"

test.use(TUI_TEST_CONFIG)

test("a refused prompt shows the usage-policy reason and does not poison the next prompt", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{ artifactName: "refused-turn", responses: REFUSED_TURN_RESPONSES },
		async (fixture) => {
			terminal.submit(REFUSED_PROMPT)
			await waitForText(terminal, REFUSAL_REASON)
			await expect(terminal.getByText(REFUSAL_TEXT)).not.toBeVisible()

			terminal.submit("hi")
			await expect(terminal.getByText(FOLLOW_UP_REPLY, { full: true })).toBeVisible()

			const requests = chatRequests(fixture)
			expect(requests.some(sendsRefusedPrompt)).toBe(true)
			expect(sendsRefusedPrompt(requests[requests.length - 1])).toBe(false)
		},
	)
})
