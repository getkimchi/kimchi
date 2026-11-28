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
import { chatRequests } from "./support/wire-requests.js"

test.use(TUI_TEST_CONFIG)

test("the /model picker separates duplicate models by PROVIDER and /model switches upstream routing", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "tui-provider-model-selection",
			providerId: "kimchi-dev",
			initialModel: "shared",
			models: PROVIDER_CATALOG,
			responses: [
				{
					toolCalls: [
						{
							id: "call_tui_upstream",
							type: "function",
							function: { name: "bash", arguments: JSON.stringify({ command: "printf tui-upstream-ok" }) },
						},
					],
				},
				{ stream: ["TUI upstream complete."] },
			],
		},
		async (fixture, trace) => {
			await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })

			terminal.submit("/model")
			await waitForText(terminal, "PROVIDER", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			terminal.write("shared")
			await waitForText(terminal, "shared (kimchi-dev/upstream)", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			const picker = viewText(terminal)
			expect(picker).toMatch(/shared \(kimchi-dev\)\s+kimchi-dev\s+128k/)
			expect(picker).toMatch(/shared \(kimchi-dev\/upstream\)\s+kimchi-dev\/upstream\s+128k/)
			trace.step("picker lists both providers separately")

			terminal.keyEscape()
			await waitForText(terminal, PROMPT_READY, { timeoutMs: INPUT_TIMEOUT_MS, full: false })

			terminal.submit("/model kimchi-dev/upstream/shared")
			await waitForText(terminal, "Model: shared", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("switched session model to kimchi-dev/upstream/shared")

			const reqCountBeforeTurn = chatRequests(fixture).length
			terminal.submit("Run printf tui-upstream-ok via bash.")
			await waitForText(terminal, "TUI upstream complete.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("upstream turn settled")

			const reqs = chatRequests(fixture).slice(reqCountBeforeTurn)
			expect(reqs).toHaveLength(2)
			for (const req of reqs) {
				expect(req.headers["x-provider-type"]).toBe("upstream")
				expect(req.headers.authorization).toBe("Bearer fake")
				expect((req.body as { model?: unknown }).model).toBe("shared")
				expect((req.body as { reasoning_effort?: unknown }).reasoning_effort).toBeUndefined()
			}
		},
	)
})
