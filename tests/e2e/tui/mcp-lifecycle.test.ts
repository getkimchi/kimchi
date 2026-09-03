import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runRestartableMcpKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { gatewayMcpCall, modelReply, parallelModelToolCalls, toolResultText } from "./support/mcp-model-script.js"

test.use(TUI_TEST_CONFIG)

test("starts a cached lazy MCP server only when a tool is called", async ({ terminal }) => {
	const warmCache = gatewayMcpCall("echo", { message: "warm-lazy-cache" })
	const lazyCall = gatewayMcpCall("echo", { message: "lazy-start" })
	await runRestartableMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-lifecycle-lazy",
			mcp: { lifecycle: "lazy" },
			responses: [
				warmCache.response,
				modelReply("The lazy MCP cache is warm."),
				lazyCall.response,
				modelReply("The lazy MCP server started on demand."),
			],
		},
		async (fixture, session, trace) => {
			await session.turn("Warm the lazy MCP metadata cache", "The lazy MCP cache is warm.")
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "warm-lazy-cache" } },
			})

			const beforeRestart = fixture.mcp.checkpoint()
			await session.restart()
			terminal.write("/mcp tools")
			await waitForText(terminal, "/mcp tools", { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.submit("")
			await waitForText(terminal, "MCP Tools:", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(
				fixture.mcp
					.readEvents()
					.slice(beforeRestart)
					.some((event) => event.type === "process_started"),
			).toBe(false)
			trace.step("cached lazy server stayed stopped after process restart")

			const onDemandCheckpoint = fixture.mcp.checkpoint()
			await session.turn("Call the lazy MCP server", "The lazy MCP server started on demand.")
			await fixture.mcp.waitForEvent("process_started", { after: onDemandCheckpoint })
			await fixture.mcp.waitForEvent("tool_called", {
				after: onDemandCheckpoint,
				where: { name: "echo", arguments: { message: "lazy-start" } },
			})
			expect(toolResultText(fixture.fake.requests, lazyCall)).toContain("fixture echo: lazy-start")
			trace.step("first post-restart call launched the lazy server")
		},
	)
})

test("recovers a crashed MCP server through the reconnect command", async ({ terminal }) => {
	const disconnect = gatewayMcpCall("disconnect")
	const afterRecovery = gatewayMcpCall("echo", { message: "manual-reconnect-recovered" })
	await runRestartableMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-lifecycle-manual-reconnect",
			mcp: { lifecycle: "keep-alive" },
			responses: [
				disconnect.response,
				modelReply("The MCP crash was contained."),
				afterRecovery.response,
				modelReply("The manually reconnected MCP server worked."),
			],
		},
		async (fixture, session, trace) => {
			const beforeCrash = fixture.mcp.checkpoint()
			await session.turn("Crash the MCP server", "The MCP crash was contained.")
			await fixture.mcp.waitForEvent("process_exited", { after: beforeCrash, where: { code: 17 } })
			const afterCrash = fixture.mcp.checkpoint()

			terminal.write("/mcp reconnect fixture")
			await waitForText(terminal, "/mcp reconnect fixture", { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.submit("")
			await waitForText(terminal, "MCP: Reconnected to fixture", { timeoutMs: STREAM_TIMEOUT_MS })
			const recoveryEvents = fixture.mcp.readEvents().slice(afterCrash)
			expect(recoveryEvents.filter((event) => event.type === "process_started")).toHaveLength(1)
			trace.step("manual reconnect launched one replacement MCP process")

			await session.turn("Call MCP after the manual reconnect", "The manually reconnected MCP server worked.")
			await fixture.mcp.waitForEvent("tool_called", {
				after: afterCrash,
				where: { name: "echo", arguments: { message: "manual-reconnect-recovered" } },
			})
			expect(toolResultText(fixture.fake.requests, afterRecovery)).toContain("fixture echo: manual-reconnect-recovered")
			trace.step("a tool call succeeded through the replacement MCP process")
		},
	)
})

test("single-flights concurrent calls that start a cached lazy MCP server", async ({ terminal }) => {
	const warmCache = gatewayMcpCall("echo", { message: "warm-concurrent-cache" })
	const firstSlowCall = gatewayMcpCall("slow", undefined, { id: "call_mcp_slow_first" })
	const secondSlowCall = gatewayMcpCall("slow", undefined, { id: "call_mcp_slow_second" })
	await runRestartableMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-lifecycle-lazy-concurrent",
			mcp: { lifecycle: "lazy" },
			responses: [
				warmCache.response,
				modelReply("The concurrent lazy MCP cache is warm."),
				parallelModelToolCalls(firstSlowCall, secondSlowCall),
				modelReply("Both concurrent lazy MCP calls completed."),
			],
		},
		async (fixture, session, trace) => {
			await session.turn("Warm the MCP cache", "The concurrent lazy MCP cache is warm.")
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "warm-concurrent-cache" } },
			})
			await session.restart()
			const beforeConcurrentCalls = fixture.mcp.checkpoint()

			await session.turn("Run two slow MCP calls together", "Both concurrent lazy MCP calls completed.", {
				timeoutMs: STREAM_TIMEOUT_MS + 5_000,
			})
			const events = fixture.mcp.readEvents().slice(beforeConcurrentCalls)
			expect(events.filter((event) => event.type === "process_started")).toHaveLength(1)
			expect(events.filter((event) => event.type === "slow_call_started")).toHaveLength(2)
			expect(events.filter((event) => event.type === "slow_call_completed")).toHaveLength(2)
			const secondStart = events.findIndex(
				(event, index) =>
					event.type === "slow_call_started" &&
					events.slice(0, index).some((previous) => previous.type === "slow_call_started"),
			)
			const firstCompletion = events.findIndex((event) => event.type === "slow_call_completed")
			expect(secondStart).toBeGreaterThan(-1)
			expect(firstCompletion).toBeGreaterThan(secondStart)
			expect(toolResultText(fixture.fake.requests, firstSlowCall)).toContain("fixture slow call completed")
			expect(toolResultText(fixture.fake.requests, secondSlowCall)).toContain("fixture slow call completed")
			trace.step("concurrent lazy calls shared one server startup and overlapped")
		},
	)
})

// Re-enable when the bundled pi-mcp-adapter is upgraded to >=2.12.0, which contains the
// upstream close-state fix. The current adapter cannot reconnect after a stdio process exit.
test.skip("reconnects a keep-alive MCP server after its process crashes", async ({ terminal }) => {
	const disconnect = gatewayMcpCall("disconnect")
	const afterRecovery = gatewayMcpCall("echo", { message: "keep-alive-recovered" })
	await runRestartableMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-lifecycle-keep-alive",
			mcp: { lifecycle: "keep-alive" },
			responses: [
				disconnect.response,
				modelReply("The keep-alive crash was contained."),
				afterRecovery.response,
				modelReply("The keep-alive MCP server recovered."),
			],
		},
		async (fixture, session, trace) => {
			const beforeCrash = fixture.mcp.checkpoint()
			await session.turn("Crash the keep-alive MCP server", "The keep-alive crash was contained.")
			await fixture.mcp.waitForEvent("process_exited", { after: beforeCrash, where: { code: 17 } })
			const afterCrash = fixture.mcp.checkpoint()

			await fixture.mcp.waitForEvent("process_started", {
				after: afterCrash,
				timeoutMs: 32_000,
				description: "keep-alive MCP process restart",
			})
			await session.turn("Call MCP after keep-alive recovery", "The keep-alive MCP server recovered.")
			expect(toolResultText(fixture.fake.requests, afterRecovery)).toContain("fixture echo: keep-alive-recovered")
			trace.step("keep-alive health check relaunched the crashed server")
		},
	)
})
