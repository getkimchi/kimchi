import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import type { MetadataCache } from "../../../src/extensions/mcp-adapter/metadata-cache.js"
import type { McpConfig } from "../../../src/extensions/mcp-adapter/types.js"
import { runRestartableMcpKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { mcpToolResult } from "./support/mcp-fixture.js"
import {
	directMcpCall,
	gatewayMcpCall,
	modelReply,
	searchMcpTools,
	toolResultText,
} from "./support/mcp-model-script.js"

test.use(TUI_TEST_CONFIG)

test("uses cached MCP metadata to call a direct tool after restart", async ({ terminal }) => {
	const warmCache = gatewayMcpCall("echo", { message: "warm-cache" })
	const afterRestart = directMcpCall("echo", { message: "after-restart" })
	await runRestartableMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-restart-cache",
			mcp: {
				directTools: ["echo"],
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: warm-cache" }] },
							{ message: "warm-cache" },
						),
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: after-restart" }] },
							{ message: "after-restart" },
						),
					],
				},
			},
			responses: [
				warmCache.response,
				modelReply("The first MCP session populated the cache."),
				afterRestart.response,
				modelReply("The cached direct MCP tool worked after restart."),
			],
		},
		async (fixture, session, trace) => {
			await session.turn(
				"Warm the MCP metadata cache through the gateway",
				"The first MCP session populated the cache.",
			)
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "warm-cache" } },
				description: "first-session gateway tool call",
			})
			expect(toolResultText(fixture.fake.requests, warmCache)).toContain("fixture echo: warm-cache")
			trace.step("first real session populated MCP metadata")

			await session.restart()
			trace.step("first Kimchi process exited and a second reached the ready prompt")
			await session.turn(
				"Call the cached direct MCP tool after restart",
				"The cached direct MCP tool worked after restart.",
			)
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "after-restart" } },
				description: "second-session direct tool call",
			})
			expect(toolResultText(fixture.fake.requests, afterRestart)).toContain("fixture echo: after-restart")
			trace.step("cached direct tool crossed MCP and model boundaries after restart")
		},
	)
})

test("invalidates cached MCP metadata when the server config changes", async ({ terminal }) => {
	const warmCache = gatewayMcpCall("echo", { message: "warm-config-cache" })
	const searchAfterChange = searchMcpTools("fixture_echo", { serverName: "fixture" })
	await runRestartableMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-restart-config-cache-invalidation",
			mcp: {
				lifecycle: "lazy",
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: warm-config-cache" }] },
							{ message: "warm-config-cache" },
						),
					],
				},
			},
			responses: [
				warmCache.response,
				modelReply("The config-sensitive MCP cache is warm."),
				searchAfterChange.response,
				modelReply("The stale MCP cache entry was removed."),
			],
		},
		async (fixture, session, trace) => {
			await session.turn("Warm the MCP metadata cache", "The config-sensitive MCP cache is warm.")
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "warm-config-cache" } },
			})

			const config = JSON.parse(readFileSync(fixture.mcp.configPath, "utf-8")) as McpConfig
			const definition = config.mcpServers.fixture
			if (!definition) throw new Error("Fixture MCP server is missing from its config")
			config.mcpServers.fixture = { ...definition, excludeTools: ["echo"] }
			writeFileSync(fixture.mcp.configPath, JSON.stringify(config, null, "\t"), "utf-8")
			await session.restart()
			const afterRestart = fixture.mcp.checkpoint()
			trace.step("Kimchi restarted after the MCP server definition changed")

			await session.turn("Search for the excluded cached MCP tool", "The stale MCP cache entry was removed.")
			expect(toolResultText(fixture.fake.requests, searchAfterChange)).toContain(
				'No tools matching "fixture_echo" in "fixture"',
			)
			expect(
				fixture.mcp
					.readEvents()
					.slice(afterRestart)
					.some((event) => event.type === "process_started"),
			).toBe(false)
			const cache = JSON.parse(readFileSync(join(fixture.agentDir, "mcp-cache.json"), "utf-8")) as MetadataCache
			expect(cache.servers.fixture).toBeUndefined()
			trace.step("stale metadata disappeared without starting the lazy server")
		},
	)
})
