import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import type { McpConfig } from "pi-mcp-adapter/types"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runMcpKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { mcpToolResult } from "./support/mcp-fixture.js"
import { gatewayMcpCall, modelReply, toolResultText } from "./support/mcp-model-script.js"

test.use(TUI_TEST_CONFIG)

function moveFixtureConfig(homeDir: string, destination: string): void {
	const source = join(homeDir, ".config", "kimchi", "harness", "mcp.json")
	mkdirSync(dirname(destination), { recursive: true })
	renameSync(source, destination)
}

function writeConflictingStandardConfig(workDir: string): void {
	writeFileSync(
		join(workDir, ".mcp.json"),
		JSON.stringify({
			mcpServers: {
				fixture: { command: process.execPath, args: ["-e", "process.exit(19)"] },
			},
		}),
		"utf8",
	)
}

async function exerciseSelectedConfig(
	terminal: Parameters<typeof runMcpKimchiSession>[0],
	options: { artifactName: string; destination: (workDir: string) => string; extraArgs?: string[] },
): Promise<void> {
	const echo = gatewayMcpCall("echo", { message: options.artifactName })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: options.artifactName,
			extraArgs: options.extraArgs,
			mcp: {
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: `fixture echo: ${options.artifactName}` }] },
							{ message: options.artifactName },
						),
					],
				},
			},
			responses: [echo.response, modelReply("The selected MCP configuration won the collision.")],
			seedHome: (homeDir, workDir) => {
				moveFixtureConfig(homeDir, options.destination(workDir))
				writeConflictingStandardConfig(workDir)
			},
		},
		async (fixture, trace) => {
			terminal.submit("Call the selected MCP fixture")
			await waitForText(terminal, "The selected MCP configuration won the collision.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: options.artifactName } },
			})
			expect(toolResultText(fixture.fake.requests, echo)).toContain(`fixture echo: ${options.artifactName}`)
			trace.step("selected config server handled a same-name collision with the standard project source")
		},
	)
}

test("legacy project MCP config wins a same-name standard project collision", async ({ terminal }) => {
	await exerciseSelectedConfig(terminal, {
		artifactName: "mcp-config-legacy-precedence",
		destination: (workDir) => join(workDir, ".kimchi", "mcp.json"),
		extraArgs: ["--approve"],
	})
})

test("explicit MCP config wins a same-name standard project collision", async ({ terminal }) => {
	await exerciseSelectedConfig(terminal, {
		artifactName: "mcp-config-explicit-precedence",
		destination: (workDir) => join(workDir, "chosen-mcp.json"),
		extraArgs: ["--mcp-config", "chosen-mcp.json"],
	})
})

test("can use both personal and legacy project MCP servers in the same session", async ({ terminal }) => {
	const personal = gatewayMcpCall("echo", { message: "personal" })
	const project = gatewayMcpCall("echo", { message: "project" }, { serverName: "project" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-config-global-and-legacy",
			extraArgs: ["--approve"],
			mcp: {
				behavior: {
					tools: [mcpToolResult("echo", { content: [{ type: "text", text: "Personal server replied." }] })],
				},
				additionalStdioServers: {
					project: {
						behavior: {
							tools: [mcpToolResult("echo", { content: [{ type: "text", text: "Project server replied." }] })],
						},
					},
				},
			},
			responses: [personal.response, project.response, modelReply("Both personal and project MCP servers replied.")],
			seedHome: (homeDir, workDir) => {
				const globalPath = join(homeDir, ".config", "kimchi", "harness", "mcp.json")
				const global: McpConfig = JSON.parse(readFileSync(globalPath, "utf8"))
				const { project, ...personalServers } = global.mcpServers
				writeFileSync(globalPath, JSON.stringify({ ...global, mcpServers: personalServers }))
				const legacyPath = join(workDir, ".kimchi", "mcp.json")
				mkdirSync(dirname(legacyPath), { recursive: true })
				writeFileSync(legacyPath, JSON.stringify({ mcpServers: { project } }))
			},
		},
		async (fixture, trace) => {
			terminal.submit("Use the personal and project MCP echo servers")
			await waitForText(terminal, "Both personal and project MCP servers replied.", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(toolResultText(fixture.fake.requests, personal)).toContain("Personal server replied.")
			expect(toolResultText(fixture.fake.requests, project)).toContain("Project server replied.")
			trace.step("personal and legacy project servers both returned results in one session")
		},
	)
})
