import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runMcpKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { gatewayMcpCall, modelReply, toolResultText } from "./support/mcp-model-script.js"

test.use(TUI_TEST_CONFIG)

test("returns MCP argument validation failures to the model without ending the session", async ({ terminal }) => {
	const invalidEcho = gatewayMcpCall("echo", {})
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-invalid-arguments",
			mcp: {},
			responses: [invalidEcho.response, modelReply("Kimchi surfaced the MCP validation error and continued.")],
		},
		async (fixture, trace) => {
			terminal.submit("Call MCP echo with invalid arguments")
			await waitForText(terminal, "Kimchi surfaced the MCP validation error and continued.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await fixture.mcp.waitForEvent("tool_called", { where: { name: "echo", arguments: {} } })
			expect(toolResultText(fixture.fake.requests, invalidEcho)).toContain(
				"fixture validation: message must be a string",
			)
			trace.step("invalid MCP arguments reached the server and returned as a bounded tool error")
		},
	)
})

test("settles the agent turn when a stdio MCP server exits during a call", async ({ terminal }) => {
	const disconnect = gatewayMcpCall("disconnect")
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-disconnect-during-call",
			mcp: {},
			responses: [disconnect.response, modelReply("Kimchi recovered after the MCP server disconnected.")],
		},
		async (fixture, trace) => {
			terminal.submit("Exercise an MCP server disconnect")
			await waitForText(terminal, "Kimchi recovered after the MCP server disconnected.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			const exited = await fixture.mcp.waitForEvent("process_exited", { where: { code: 17 } })
			expect(exited.code).toBe(17)
			expect(toolResultText(fixture.fake.requests, disconnect)).toContain("Failed to call tool")
			trace.step("transport disconnect became a model-facing error and the turn settled")
		},
	)
})

test("starts Kimchi in a usable degraded state when an eager MCP server fails startup", async ({ terminal }) => {
	const echo = gatewayMcpCall("echo", {})
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-startup-failure",
			mcp: { scenario: "startup-failure", lifecycle: "eager" },
			responses: [echo.response, modelReply("The main Kimchi session remained usable after MCP startup failed.")],
		},
		async (fixture, trace) => {
			await fixture.mcp.waitForEvent("process_exited", { where: { code: 23 } })
			terminal.submit("Continue despite the broken MCP fixture")
			await waitForText(terminal, "The main Kimchi session remained usable after MCP startup failed.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			expect(toolResultText(fixture.fake.requests, echo)).toMatch(/failed|not (?:available|connected)|not found/i)
			trace.step("startup failure stayed isolated from the main agent session")
		},
	)
})

test("completes a bounded slow MCP call without hanging the session", async ({ terminal }) => {
	const slow = gatewayMcpCall("slow")
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-bounded-slow-call",
			mcp: {},
			responses: [slow.response, modelReply("The bounded slow MCP call completed.")],
		},
		async (fixture, trace) => {
			terminal.submit("Wait for the bounded MCP operation")
			await fixture.mcp.waitForEvent("slow_call_started")
			await waitForText(terminal, "The bounded slow MCP call completed.", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(fixture.mcp.hasEvent("slow_call_completed")).toBe(true)
			expect(toolResultText(fixture.fake.requests, slow)).toContain("fixture slow call completed")
			trace.step("bounded delayed MCP request completed and the turn settled")
		},
	)
})

// Known product bug: the MCP gateway tool receives Pi's AbortSignal but currently ignores
// it, so cancelling an agent turn does not send MCP notifications/cancelled to the server.
test.fail("propagates agent-turn cancellation to an in-flight MCP request", async ({ terminal }) => {
	const slow = gatewayMcpCall("slow")
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-call-cancellation",
			mcp: {},
			responses: [slow.response],
		},
		async (fixture, trace) => {
			terminal.submit("Start an MCP call that I will cancel")
			await fixture.mcp.waitForEvent("slow_call_started")
			terminal.keyCtrlC()
			await fixture.mcp.waitForEvent("slow_call_cancelled", {
				timeoutMs: 1_000,
				description: "MCP cancellation notification",
			})
			expect(fixture.mcp.hasEvent("slow_call_completed")).toBe(false)
			trace.step("agent cancellation reached the MCP server")
		},
	)
})
