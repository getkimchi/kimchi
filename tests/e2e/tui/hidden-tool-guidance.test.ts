import { expect, test } from "@microsoft/tui-test"
import { STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const TOOL_CALL_ID = "call_hidden_bash"
const EXPECTED_GUIDANCE =
	'Tool bash not found: "bash" is not available in the current tool list. Continue with an available tool and retry only if "bash" appears there later.'
const NO_COMPACTION_MODEL = { slug: "basic", displayName: "Fake Basic", contextWindow: 200_000, maxTokens: 8192 }

function findToolResult(body: unknown): Record<string, unknown> | undefined {
	if (!body || typeof body !== "object") return undefined
	const messages = (body as Record<string, unknown>).messages
	if (!Array.isArray(messages)) return undefined
	return messages.find((message): message is Record<string, unknown> => {
		return Boolean(
			message &&
				typeof message === "object" &&
				(message as Record<string, unknown>).role === "tool" &&
				(message as Record<string, unknown>).tool_call_id === TOOL_CALL_ID,
		)
	})
}

test("hidden Bash rejection guides the next model turn", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "hidden-tool-guidance",
			gitInit: true,
			models: [NO_COMPACTION_MODEL],
			extraArgs: ["--ferment-oneshot=true"],
			responses: [
				{
					stream: ["Trying Bash during planning."],
					toolCalls: [
						{
							id: TOOL_CALL_ID,
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: "echo should-not-run" }),
							},
						},
					],
				},
				{ stream: ["Continuing with the available planning tools."] },
			],
		},
		async (fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			terminal.submit("Plan a safe test change")

			await waitForText(terminal, "Continuing with the available planning tools", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})

			const continuationRequest = fixture.fake.requests.find((request) => findToolResult(request.body))
			const toolResult = findToolResult(continuationRequest?.body)
			expect(toolResult).toBeDefined()
			expect(toolResult?.content).toBe(EXPECTED_GUIDANCE)
			trace.step("next model turn received reason-neutral hidden-tool guidance")
		},
	)
})
