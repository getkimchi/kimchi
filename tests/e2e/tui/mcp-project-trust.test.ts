import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { expect, test } from "@microsoft/tui-test"
import { STARTUP_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runKimchiSession, runMcpKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("does not execute an untrusted repository MCP server during startup", async ({ terminal }) => {
	let sentinel = ""
	await runKimchiSession(
		terminal,
		{
			artifactName: "mcp-project-trust-denied",
			trustWorkDir: false,
			responses: [],
			seedHome: (_homeDir, workDir) => {
				sentinel = join(workDir, "project-mcp-started")
				const configPath = join(workDir, ".kimchi", "mcp.json")
				mkdirSync(dirname(configPath), { recursive: true })
				writeFileSync(
					configPath,
					JSON.stringify({
						mcpServers: {
							untrusted: {
								command: process.execPath,
								args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(sentinel)}, "started")`],
							},
						},
					}),
				)
			},
			beforeReady: async (t) => {
				await waitForText(t, "Trust (this session only)", { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
				// Let the select options finish rendering before submitting — an early
				// Enter can land on an unhighlighted dialog and cancel it.
				await delay(250)
				expect(existsSync(sentinel)).toBe(false)
				// Option order varies (a "Trust parent folder" entry appears when the
				// temp parent is eligible), so walk to the bottom: the last entry is
				// always "Do not trust (this session only)".
				t.keyDown(8)
				t.submit("")
			},
		},
		async (_fixture, trace) => {
			await delay(500)
			expect(existsSync(sentinel)).toBe(false)
			await waitForText(terminal, "This project is not trusted.")
			trace.step("repository MCP process remained stopped after trust was denied")
		},
	)
})

test("starts a repository MCP server after the user trusts the project", async ({ terminal }) => {
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-project-trust-accepted",
			trustWorkDir: false,
			mcp: {},
			responses: [],
			seedHome: (homeDir, workDir) => {
				// Move the fixture's global config into the project layer.
				const source = join(homeDir, ".config", "kimchi", "harness", "mcp.json")
				const destination = join(workDir, ".kimchi", "mcp.json")
				mkdirSync(dirname(destination), { recursive: true })
				writeFileSync(destination, readFileSync(source, "utf-8"), "utf-8")
			},
			beforeReady: async (t) => {
				await waitForText(t, "Trust (this session only)", { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
				await delay(250)
				t.submit("")
			},
		},
		async (fixture, trace) => {
			await fixture.mcp.waitForEvent("initialized", {
				description: "trusted repository MCP server initialization",
			})
			trace.step("trusted repository MCP server initialized normally")
		},
	)
})
