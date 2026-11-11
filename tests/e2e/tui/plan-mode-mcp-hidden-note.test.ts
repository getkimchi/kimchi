import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runMcpKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { mcpToolResult } from "./support/mcp-fixture.js"
import { modelReply } from "./support/mcp-model-script.js"

test.use(TUI_TEST_CONFIG)

const NOTE_FRAGMENT = "Plan mode is active: the `mcp` gateway"

interface ChatRequestBody {
	messages?: Array<{ role?: string; content?: unknown }>
}

function firstChatSystemPrompt(fixture: { fake: { requests: Array<{ url: string; body: unknown }> } }): string {
	const request = fixture.fake.requests.find((candidate) => candidate.url.startsWith("/openai/v1/chat/completions"))
	const messages = (request?.body as ChatRequestBody | undefined)?.messages ?? []
	const system = messages.find((message) => message.role === "system")
	return typeof system?.content === "string" ? system.content : JSON.stringify(system?.content ?? "")
}

// The permissions planning profile hides the `mcp` gateway and non-read-only
// MCP tools but told nobody — the next model request just lacked them, so the
// model answered "no MCP tools are accessible", which users read as a
// connector/auth failure (and some started re-authorizing). The harness now
// appends a note to the system prompt of every plan-mode request when MCP
// tools were hidden, so the model can name the actual state.
test("plan mode with a hidden MCP surface adds a system-prompt note naming plan mode", async ({ terminal }) => {
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "plan-mode-mcp-hidden-note",
			extraArgs: ["--plan=true"],
			mcp: {
				behavior: {
					catalogTools: [
						{
							name: "get_write_access",
							description: "Change fixture permissions",
							inputSchema: { type: "object", properties: {}, additionalProperties: false },
						},
					],
					tools: [mcpToolResult("get_write_access", { content: [{ type: "text", text: "unused" }] })],
				},
			},
			responses: [modelReply("The tool stays hidden while plan mode is on.")],
		},
		async (_fixture, trace) => {
			terminal.submit("Can you read the Jira ticket for this plan?")
			await waitForText(terminal, "The tool stays hidden while plan mode is on.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("reply received in plan mode")

			const systemPrompt = firstChatSystemPrompt(_fixture)
			expect(systemPrompt).toContain(NOTE_FRAGMENT)
			expect(systemPrompt).toContain("say it is unavailable in plan mode")
			trace.step("system prompt carries the plan-mode MCP note")
		},
	)
})

test("the note disappears for the same session after leaving plan mode", async ({ terminal }) => {
	// Under --plan the first prompt carries the note; switching modes and
	// prompting again must drop it (the profile re-application runs per
	// before_agent_start).
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "plan-mode-mcp-hidden-note-exit",
			extraArgs: ["--plan=true"],
			mcp: {
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: post-plan" }] },
							{ message: "post-plan" },
						),
					],
				},
			},
			responses: [modelReply("Plan-mode answer."), modelReply("Echo ran after leaving plan mode.")],
		},
		async (fixture, trace) => {
			terminal.submit("Plan the change")
			await waitForText(terminal, "Plan-mode answer.", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(firstChatSystemPrompt(fixture)).toContain(NOTE_FRAGMENT)
			trace.step("first plan-mode request carried the note")

			// Leave plan mode (auto) via the mode cycle and prompt again.
			// Mode order: default → plan → auto → yolo; from plan, one shift+tab
			// press reaches auto.
			terminal.write("\x1b[Z") // shift+tab
			await waitForText(terminal, "auto → shift+tab", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("left plan mode")

			terminal.submit("Echo the sentinel now")
			await waitForText(terminal, "Echo ran after leaving plan mode.", { timeoutMs: STREAM_TIMEOUT_MS })

			const requests = fixture.fake.requests.filter((r) => r.url.startsWith("/openai/v1/chat/completions"))
			expect(requests.length).toBeGreaterThanOrEqual(2)
			const lastBody = requests[requests.length - 1].body as ChatRequestBody
			const lastSystem = lastBody.messages?.find((m) => m.role === "system")
			const lastSystemText =
				typeof lastSystem?.content === "string" ? lastSystem.content : JSON.stringify(lastSystem?.content ?? "")
			expect(lastSystemText).not.toContain(NOTE_FRAGMENT)
			trace.step("post-plan request is clean of the note")
		},
	)
})
