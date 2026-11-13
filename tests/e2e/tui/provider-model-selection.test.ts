import { expect, test } from "@microsoft/tui-test"
import {
	INPUT_TIMEOUT_MS,
	STARTUP_TIMEOUT_MS,
	STREAM_TIMEOUT_MS,
	viewText,
	waitForText,
	waitForTurnToSettle,
} from "./support/assertions.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { PROVIDER_CATALOG } from "./support/provider-catalog.js"

test.use(TUI_TEST_CONFIG)

test("selects a gateway upstream and completes a streamed tool round trip with its own thinking settings", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "tui-provider-model-selection",
			providerId: "kimchi-dev",
			initialModel: "shared",
			models: PROVIDER_CATALOG,
			extraArgs: ["--thinking", "high"],
			responses: [
				{ toolCalls: [{ function: { name: "list_models", arguments: "{}" } }] },
				{ stream: ["Upstream ", "round trip."] },
			],
		},
		async (fixture, trace) => {
			await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
			terminal.submit("/model")
			await waitForText(terminal, "kimchi-dev/upstream", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			expect(viewText(terminal)).toContain("PROVIDER")
			trace.step("picker shows the upstream provider separately")
			terminal.keyEscape()
			terminal.submit("/model kimchi-dev/upstream/shared")
			await waitForText(terminal, "Default model: kimchi-dev/upstream/shared", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("List the models")
			await waitForText(terminal, "Upstream round trip.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			const chat = fixture.fake.requests.filter((r) => r.url.startsWith("/openai/v1/chat/completions"))
			expect(chat).toHaveLength(2)
			for (const request of chat) {
				expect(request.headers.authorization).toBe("Bearer fake")
				expect(request.headers["x-provider-type"]).toBe("upstream")
				expect(request.body).toMatchObject({ model: "shared" })
				expect(request.body).not.toHaveProperty("reasoning_effort")
			}
			expect(chat[1]?.body).toMatchObject({
				messages: expect.arrayContaining([
					expect.objectContaining({ role: "tool", content: expect.stringContaining("kimchi-dev/upstream/shared") }),
				]),
			})
			trace.step("selected upstream streams and receives the completed tool result without an effort override")
		},
	)
})
