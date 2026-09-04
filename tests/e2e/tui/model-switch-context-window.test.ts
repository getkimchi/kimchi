import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText, waitForTurnToSettle } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const MODELS = [
	{ slug: "basic", displayName: "Fake Large", contextWindow: 200_000, maxTokens: 8_192 },
	{ slug: "small", displayName: "Fake Small", contextWindow: 100_000, maxTokens: 8_192 },
]
const OVERAGE_PROMPT = "Context is 55,015 tokens over small's safe limit (150,015 current vs 95,000 safe)"

function requestModel(body: unknown): string | undefined {
	return body && typeof body === "object" && "model" in body && typeof body.model === "string" ? body.model : undefined
}

test("compacts with the current model before switching to a smaller model", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "model-switch-compacts-before-smaller-model",
			models: MODELS,
			responses: [
				{
					stream: ["Large context ready."],
					usage: { prompt_tokens: 150_000, completion_tokens: 0 },
				},
				{ stream: ["Compacted context summary."] },
				{ stream: ["Small model after compaction."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Prime the large context")
			await waitForText(terminal, "Large context ready.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("large-model context recorded")

			terminal.submit("/model fake/small")
			await waitForText(terminal, OVERAGE_PROMPT, { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("exact token overage shown")

			terminal.submit("")
			await waitForText(terminal, "Model: small", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("compaction completed before model switch")

			terminal.submit("Confirm the compacted model")
			await waitForText(terminal, "Small model after compaction.", { timeoutMs: STREAM_TIMEOUT_MS })

			const chatRequests = fixture.fake.requests.filter(
				(request) =>
					request.url.startsWith("/openai/v1/chat/completions") &&
					["basic", "small"].includes(requestModel(request.body) ?? ""),
			)
			expect(chatRequests).toHaveLength(3)
			expect(chatRequests.map((request) => requestModel(request.body))).toEqual(["basic", "basic", "small"])
		},
	)
})

test("starts a fresh smaller-model session without the oversized history", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "model-switch-starts-fresh-smaller-model-session",
			models: MODELS,
			responses: [
				{
					stream: ["Large context ready."],
					usage: { prompt_tokens: 150_000, completion_tokens: 0 },
				},
				{ stream: ["Small model in a fresh session."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Prime the large context")
			await waitForText(terminal, "Large context ready.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("large-model context recorded")

			terminal.submit("/model fake/small")
			await waitForText(terminal, OVERAGE_PROMPT, { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("exact token overage shown")

			terminal.keyDown()
			terminal.submit("")
			await waitForText(terminal, "Started a new session with fake/small.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("fresh smaller-model session started")

			terminal.submit("Confirm the fresh model")
			await waitForText(terminal, "Small model in a fresh session.", { timeoutMs: STREAM_TIMEOUT_MS })

			const chatRequests = fixture.fake.requests.filter(
				(request) =>
					request.url.startsWith("/openai/v1/chat/completions") &&
					["basic", "small"].includes(requestModel(request.body) ?? ""),
			)
			expect(chatRequests).toHaveLength(2)
			expect(chatRequests.map((request) => requestModel(request.body))).toEqual(["basic", "small"])
			expect(JSON.stringify(chatRequests[1]?.body)).not.toContain("Prime the large context")
		},
	)
})
