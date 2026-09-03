import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runMcpKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { gatewayMcpCall, modelReply, toolResultText } from "./support/mcp-model-script.js"

test.use(TUI_TEST_CONFIG)

test("returns MCP argument validation failures to the model without ending the session", async ({ terminal }) => {
	const invalidEcho = gatewayMcpCall("echo", {})
	const validationMessage = "fixture validation: message must be a string"
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-invalid-arguments",
			mcp: {
				behavior: {
					tools: [
						{
							name: "echo",
							arguments: {},
							response: {
								type: "result",
								value: { isError: true, content: [{ type: "text", text: validationMessage }] },
							},
						},
					],
				},
			},
			responses: [invalidEcho.response, modelReply("Kimchi surfaced the MCP validation error and continued.")],
		},
		async (fixture, trace) => {
			terminal.submit("Call MCP echo with invalid arguments")
			await waitForText(terminal, "Kimchi surfaced the MCP validation error and continued.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await fixture.mcp.waitForEvent("tool_called", { where: { name: "echo", arguments: {} } })
			expect(toolResultText(fixture.fake.requests, invalidEcho)).toContain(validationMessage)
			trace.step("invalid MCP arguments reached the server and returned as a bounded tool error")
		},
	)
})

test("settles the agent turn when a stdio MCP server exits during a call", async ({ terminal }) => {
	const disconnect = gatewayMcpCall("disconnect")
	const disconnectExitCode = 17
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-disconnect-during-call",
			mcp: {
				behavior: {
					tools: [
						{
							name: "disconnect",
							response: { type: "exit", code: disconnectExitCode },
						},
					],
				},
			},
			responses: [disconnect.response, modelReply("Kimchi recovered after the MCP server disconnected.")],
		},
		async (fixture, trace) => {
			terminal.submit("Exercise an MCP server disconnect")
			await waitForText(terminal, "Kimchi recovered after the MCP server disconnected.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			const exited = await fixture.mcp.waitForEvent("process_exited", {
				where: { code: disconnectExitCode },
			})
			expect(exited.code).toBe(disconnectExitCode)
			expect(toolResultText(fixture.fake.requests, disconnect)).toContain("Failed to call tool")
			trace.step("transport disconnect became a model-facing error and the turn settled")
		},
	)
})

test("starts Kimchi in a usable degraded state when an eager MCP server fails startup", async ({ terminal }) => {
	const echo = gatewayMcpCall("echo", {})
	const startupExitCode = 23
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-startup-failure",
			mcp: {
				lifecycle: "eager",
				behavior: { startup: { type: "exit", code: startupExitCode } },
			},
			responses: [echo.response, modelReply("The main Kimchi session remained usable after MCP startup failed.")],
		},
		async (fixture, trace) => {
			await fixture.mcp.waitForEvent("process_exited", { where: { code: startupExitCode } })
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
	const slowResult = "fixture slow call completed"
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-bounded-slow-call",
			mcp: {
				behavior: {
					tools: [
						{
							name: "slow",
							response: {
								type: "delayed-result",
								delayMs: 2_000,
								value: { content: [{ type: "text", text: slowResult }] },
							},
						},
					],
				},
			},
			responses: [slow.response, modelReply("The bounded slow MCP call completed.")],
		},
		async (fixture, trace) => {
			terminal.submit("Wait for the bounded MCP operation")
			await fixture.mcp.waitForEvent("slow_call_started")
			await waitForText(terminal, "The bounded slow MCP call completed.", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(fixture.mcp.hasEvent("slow_call_completed")).toBe(true)
			expect(toolResultText(fixture.fake.requests, slow)).toContain(slowResult)
			trace.step("bounded delayed MCP request completed and the turn settled")
		},
	)
})

// Known product bug: the MCP gateway tool receives Pi's AbortSignal but currently ignores
// it, so cancelling an agent turn does not send MCP notifications/cancelled to the server.
// Fixed upstream in pi-mcp-adapter v2.11.0 by PR #159; remove test.fail once the bundled
// adapter includes that fix.
test.fail("propagates agent-turn cancellation to an in-flight MCP request", async ({ terminal }) => {
	const slow = gatewayMcpCall("slow")
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-call-cancellation",
			mcp: {
				behavior: {
					tools: [
						{
							name: "slow",
							response: {
								type: "delayed-result",
								delayMs: 2_000,
								value: { content: [{ type: "text", text: "fixture slow call completed" }] },
							},
						},
					],
				},
			},
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
