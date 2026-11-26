import { setTimeout as delay } from "node:timers/promises"
import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText, waitForTurnToSettle } from "./support/assertions.js"
import type { FakeModel } from "./support/fake-openai-server.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const MODELS: FakeModel[] = [
	{
		slug: "routed",
		displayName: "Routed",
		provider: "ai-enabler",
		reasoning: true,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 8_192,
		metadata: { thinking_levels: ["low", "medium", "high"] },
	},
	{
		slug: "auto",
		displayName: "Auto",
		provider: "ai-enabler",
		reasoning: true,
		input: ["text"],
		contextWindow: 128_000,
		maxTokens: 8_192,
		metadata: { thinking_levels: ["low", "medium", "high"] },
	},
]

function chatRequests(fixture: { fake: { requests: { url: string; body: unknown }[] } }) {
	return fixture.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
}

function efforts(fixture: { fake: { requests: { url: string; body: unknown }[] } }) {
	return chatRequests(fixture).map((request) => (request.body as { reasoning_effort?: string }).reasoning_effort)
}

async function waitForChatCount(
	fixture: { fake: { requests: { url: string; body: unknown }[] } },
	count: number,
): Promise<void> {
	const deadline = Date.now() + STREAM_TIMEOUT_MS
	while (chatRequests(fixture).length < count) {
		if (Date.now() > deadline) throw new Error(`Expected ${count} chat requests; got ${chatRequests(fixture).length}`)
		await delay(50)
	}
}

test("a routed length-limited answer continues once at lower effort and keeps it after success", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "request-length-retains-lower-effort",
			providerId: "kimchi-dev",
			initialModel: "auto",
			models: MODELS,
			extraArgs: ["--thinking", "high"],
			responses: [
				{
					thinking: ["Only hidden reasoning before truncation."],
					stream: ["PARTIAL_SENTENCE"],
					finishReason: "length",
					responseModel: "routed",
					headers: { "x-auto-reasoning-effort": "high" },
				},
				{ stream: ["CONTINUATION_COMPLETE"] },
				{ stream: ["PREFERENCE_RETAINED"] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Give a partial answer")
			await waitForText(terminal, "CONTINUATION_COMPLETE", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("single lower-effort continuation completed")
			await waitForTurnToSettle(fixture.fake.requests)
			expect(efforts(fixture)).toEqual(["high", "medium"])
			const retryBody = JSON.stringify(chatRequests(fixture)[1].body)
			expect(retryBody).toContain("PARTIAL_SENTENCE")
			expect(retryBody).not.toContain("Only hidden reasoning before truncation.")
			expect(retryBody).toContain("Continue from its last visible character")

			terminal.submit("Check the following user turn")
			await waitForText(terminal, "PREFERENCE_RETAINED", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("lower preference retained on the next user turn")
			expect(efforts(fixture)).toEqual(["high", "medium", "medium"])
		},
	)
})

test("cancelling the lower-effort continuation restores the original effort", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "request-length-cancel-restores",
			providerId: "kimchi-dev",
			initialModel: "routed",
			models: MODELS,
			extraArgs: ["--thinking", "high"],
			responses: [
				{ thinking: ["Reasoning only"], finishReason: "length" },
				{ holdUntil: new Promise<void>(() => {}) },
				{ stream: ["ORIGINAL_EFFORT_RESTORED"] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Start a capped answer")
			await waitForChatCount(fixture, 2)
			trace.step("continuation is awaiting its provider response")
			terminal.write("\u001b")
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("continuation cancelled")
			terminal.submit("Check restored preference")
			await waitForText(terminal, "ORIGINAL_EFFORT_RESTORED", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(efforts(fixture)).toEqual(["high", "medium", "high"])
		},
	)
})
