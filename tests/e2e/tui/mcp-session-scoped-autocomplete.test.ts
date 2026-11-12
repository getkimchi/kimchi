import { expect, test } from "@microsoft/tui-test"
import { fullText, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runMcpKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

// Regression for the Discord report (2026-11-11): a server whose tools/list
// declares cacheScope:"private" (credential-scoped listings, #1670) showed
// "(not cached)" in the MCP panel right after a successful reconnect, and its
// prompt commands never appeared in slash autocomplete until /reload — the
// autocomplete provider snapshots the command list once, and mid-session
// pi.registerCommand did not rebuild it.
test("reconnect surfaces session-scoped prompt commands in autocomplete and the panel", async ({ terminal }) => {
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-session-scoped-autocomplete",
			mcp: {
				scenario: "cache-private-scope",
				// Hyphenated on purpose: exercises the sanitized-vs-raw
				// server-name lookup in the wrapper argument phase.
				serverName: "fixture-srv",
				lifecycle: "lazy",
			},
			responses: [],
		},
		async (fixture, trace) => {
			// Baseline: lazy server never connected — no prompt command exists yet.
			terminal.write("/mcp__")
			await waitForText(terminal, "/mcp__", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(fullText(terminal)).not.toContain("hello-world")
			trace.step("no prompt command before the first connect")

			terminal.keyEscape()
			terminal.write("\b\b\b\b\b\b")
			terminal.submit("/mcp reconnect fixture-srv")
			await waitForText(terminal, "MCP: Reconnected to fixture-srv", { timeoutMs: STREAM_TIMEOUT_MS })
			await fixture.mcp.waitForEvent("tools_listed")
			await fixture.mcp.waitForEvent("prompts_listed")
			trace.step("fixture reconnected; catalog + prompts fetched")

			terminal.keyEscape()
			terminal.write("\b\b\b\b\b\b")
			// The freshly registered prompt command must be visible in autocomplete
			// immediately, without a /reload round-trip.
			terminal.write("/mcp__")
			await waitForText(terminal, "hello-world", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("prompt command appears in autocomplete right after reconnect")

			terminal.keyEscape()
			terminal.write("\b\b\b\b\b\b")
			// Argument completion for a mid-session command resolves from the
			// live metadata too (the base provider only knows the snapshot).
			terminal.write("/mcp__fixture_srv__hello-world t")
			await waitForText(terminal, "topic=", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("argument autocomplete resolves from live metadata")

			terminal.keyEscape()
			// 32 chars: "/mcp__fixture_srv__hello-world t"
			terminal.write("\b".repeat(32))
			// The command is not cosmetic: running it must reach prompts/get.
			const execCheckpoint = fixture.mcp.checkpoint()
			terminal.submit("/mcp__fixture_srv__hello-world")
			await fixture.mcp.waitForEvent("prompts_get", { after: execCheckpoint, timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "fake response", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("completing the prompt command executes it")

			// A second reconnect must not double the dropdown row (snapshot/live
			// dedupe in the wrapper).
			terminal.submit("/mcp reconnect fixture-srv")
			await waitForText(terminal, "MCP: Reconnected to fixture-srv", { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.write("/mcp__")
			await waitForText(terminal, "hello-world", { timeoutMs: STREAM_TIMEOUT_MS })
			// Exact count in the visible viewport: a single dropdown row. pi-tui
			// prefixes non-selected rows with spaces, so a duplicated row would
			// push the total to 2. (Executed-command transcript has scrolled off.)
			expect(fullText(terminal).match(/mcp__fixture_srv__hello-world/g) ?? []).toHaveLength(1)
			trace.step("second reconnect keeps a single autocomplete row")

			terminal.keyEscape()
			terminal.write("\b\b\b\b\b\b")
			// Same open pattern as mcp-panel.test.ts: type, let autocomplete settle,
			// then submit; Enter accepts the completed /mcp line and runs it.
			terminal.write("/mcp")
			await waitForText(terminal, "/mcp", { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.submit("")
			await waitForText(terminal, "MCP Servers", { timeoutMs: STREAM_TIMEOUT_MS })
			// Session-scoped listings must not render as a cache miss. The panel
			// shows the same-session catalog with a session-scope affordance.
			expect(fullText(terminal)).not.toContain("(not cached)")
			expect(fullText(terminal)).toContain("session scope")
			trace.step("panel shows the session-scoped catalog instead of a cache miss")
		},
	)
})
