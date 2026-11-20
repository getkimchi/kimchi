import { expect, test } from "@microsoft/tui-test"
import type { Terminal } from "@microsoft/tui-test/lib/terminal/term.js"
import {
	fullText,
	INPUT_TIMEOUT_MS,
	STREAM_TIMEOUT_MS,
	waitForText,
	waitForTurnToSettle,
} from "./support/assertions.js"
import { runMcpKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const EMPTY_EDITOR = "❯  ask anything or type / for commands"

async function clearEditor(terminal: Terminal, autocompleteText?: string): Promise<void> {
	if (autocompleteText) {
		terminal.keyEscape()
		// Do not let Escape share a stdin chunk with the clear key: Escape +
		// Backspace is Alt+Backspace, which leaves autocomplete active.
		await waitForText(terminal, (text) => !text.includes(autocompleteText), { timeoutMs: INPUT_TIMEOUT_MS })
	}
	terminal.keyPress("u", { ctrl: true })
	await waitForText(terminal, EMPTY_EDITOR, { timeoutMs: INPUT_TIMEOUT_MS })
}

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

			await clearEditor(terminal)
			terminal.submit("/mcp reconnect fixture-srv")
			await waitForText(terminal, "MCP: Reconnected to fixture-srv", { timeoutMs: STREAM_TIMEOUT_MS })
			await fixture.mcp.waitForEvent("tools_listed")
			await fixture.mcp.waitForEvent("prompts_listed")
			trace.step("fixture reconnected; catalog + prompts fetched")

			// The freshly registered prompt command must be visible in autocomplete
			// immediately, without a /reload round-trip.
			terminal.write("/mcp__")
			await waitForText(terminal, "hello-world", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("prompt command appears in autocomplete right after reconnect")

			await clearEditor(terminal, "MCP: Say hello from the fixture")
			// Argument completion for a mid-session command resolves from the
			// live metadata too (the base provider only knows the snapshot).
			terminal.write("/mcp__fixture_srv__hello-world t")
			await waitForText(terminal, "topic=", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("argument autocomplete resolves from live metadata")

			await clearEditor(terminal, "Topic to greet")
			// The command is not cosmetic: running it must reach prompts/get.
			const execCheckpoint = fixture.mcp.checkpoint()
			terminal.submit("/mcp__fixture_srv__hello-world")
			await fixture.mcp.waitForEvent("prompts_get", { after: execCheckpoint, timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "fake response", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			trace.step("completing the prompt command executes it")

			// A second reconnect must not double the dropdown row (snapshot/live
			// dedupe in the wrapper). Anchor to fresh discovery rather than the
			// previous reconnect banner already present in the terminal history.
			const reconnectCheckpoint = fixture.mcp.checkpoint()
			terminal.submit("/mcp reconnect fixture-srv")
			await waitForText(terminal, "MCP: Reconnected to fixture-srv", { timeoutMs: STREAM_TIMEOUT_MS })
			await fixture.mcp.waitForEvent("tools_listed", { after: reconnectCheckpoint, timeoutMs: STREAM_TIMEOUT_MS })
			await fixture.mcp.waitForEvent("prompts_listed", { after: reconnectCheckpoint, timeoutMs: STREAM_TIMEOUT_MS })
			terminal.write("/mcp__")
			await waitForText(terminal, "hello-world", { timeoutMs: STREAM_TIMEOUT_MS })
			// Exact count in the visible viewport: a single dropdown row. pi-tui
			// prefixes non-selected rows with spaces, so a duplicated row would
			// push the total to 2. (Executed-command transcript has scrolled off.)
			expect(fullText(terminal).match(/mcp__fixture_srv__hello-world/g) ?? []).toHaveLength(1)
			trace.step("second reconnect keeps a single autocomplete row")

			await clearEditor(terminal, "MCP: Say hello from the fixture")
			// Same open pattern as mcp-panel.test.ts: type, let autocomplete settle,
			// then submit; Enter accepts the completed /mcp line and runs it.
			terminal.write("/mcp")
			await waitForText(terminal, /^❯ \/mcp$/m, { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.submit("")
			await waitForText(terminal, "MCP Servers", { timeoutMs: STREAM_TIMEOUT_MS })
			// Session-scoped listings must not render as a cache miss. 5.3.2's
			// withSessionMetadata() overlays this session's private catalog.
			expect(fullText(terminal)).not.toContain("(not cached)")
			expect(fullText(terminal)).toContain("fixture-srv  0/6")
			trace.step("panel shows this session's catalog through the upstream overlay")
		},
	)
})

test("in-panel reconnect shows a private catalog through the upstream session overlay", async ({ terminal }) => {
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-session-scoped-panel-reconnect",
			mcp: {
				scenario: "cache-private-scope",
				serverName: "fixture-srv",
				lifecycle: "lazy",
			},
			responses: [],
		},
		async (fixture, trace) => {
			terminal.write("/mcp")
			await waitForText(terminal, /^❯ \/mcp$/m, { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.submit("")
			await waitForText(terminal, "MCP Servers", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("MCP panel opened for a private-scoped lazy server")

			const checkpoint = fixture.mcp.checkpoint()
			terminal.keyPress("r", { ctrl: true })
			// Prove that ctrl+r actually initiates a fresh server process and
			// discovery, rather than accepting an already-visible startup row.
			await fixture.mcp.waitForEvent("process_started", { after: checkpoint, timeoutMs: STREAM_TIMEOUT_MS })
			await fixture.mcp.waitForEvent("tools_listed", { after: checkpoint, timeoutMs: STREAM_TIMEOUT_MS })
			await fixture.mcp.waitForEvent("prompts_listed", { after: checkpoint, timeoutMs: STREAM_TIMEOUT_MS })
			// The refresh must use withSessionMetadata(), not loadMetadataCache()
			// alone: private and zero-TTL catalogs never validate persistently.
			expect(fullText(terminal)).not.toContain("(not cached)")
			expect(fullText(terminal)).toContain("fixture-srv  0/6")
			trace.step("in-panel ctrl+r renders the session's private catalog")
		},
	)
})

test("accepting a live MCP autocomplete suggestion executes the prompt", async ({ terminal }) => {
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-session-scoped-autocomplete-accept",
			mcp: { scenario: "cache-private-scope", serverName: "fixture-srv", lifecycle: "lazy" },
			responses: [],
		},
		async (fixture, trace) => {
			terminal.submit("/mcp reconnect fixture-srv")
			await waitForText(terminal, "MCP: Reconnected to fixture-srv", { timeoutMs: STREAM_TIMEOUT_MS })
			await fixture.mcp.waitForEvent("prompts_listed")

			const prefix = "/mcp__fixture_srv__hello-"
			terminal.write(prefix)
			await waitForText(terminal, `❯ ${prefix}`, { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "hello-world", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("partial-prefix command and live suggestion are visible")

			const checkpoint = fixture.mcp.checkpoint()
			// Select-confirm applies the slash-command row, then submits it.
			terminal.submit("")
			await fixture.mcp.waitForEvent("prompts_get", { after: checkpoint, timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("accepted live suggestion executed prompts/get")
		},
	)
})
