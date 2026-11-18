import { expect, Key, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runMcpKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { mcpResourceResult, mcpToolResult } from "./support/mcp-fixture.js"
import {
	describeMcpTool,
	directMcpCall,
	emptyMcpCall,
	gatewayMcpCall,
	modelReply,
	requireRequestAdvertisingTool,
	searchMcpTools,
	toolResultText,
} from "./support/mcp-model-script.js"

test.use(TUI_TEST_CONFIG)

const SENTINEL = "kimchi-mcp-e2e"

test("calls a stdio MCP tool through the real Kimchi session", async ({ terminal }) => {
	const echo = gatewayMcpCall("echo", { message: SENTINEL })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-stdio",
			mcp: {
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: `fixture echo: ${SENTINEL}` }] },
							{ message: SENTINEL },
						),
					],
				},
			},
			responses: [echo.response, modelReply("The MCP fixture returned the expected echo.")],
		},
		async (fixture, trace) => {
			terminal.submit("Use the MCP fixture to echo the test sentinel")

			await waitForText(terminal, "The MCP fixture returned the expected echo.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			trace.step("final response visible after MCP tool result")

			const called = await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: SENTINEL } },
				description: "echo tool invocation",
			})
			expect(called.arguments).toEqual({ message: SENTINEL })

			expect(fixture.mcp.hasEvent("initialized")).toBe(true)
			expect(fixture.mcp.hasEvent("tools_listed")).toBe(true)

			expect(toolResultText(fixture.fake.requests, echo)).toContain(`fixture echo: ${SENTINEL}`)
			trace.step("fixture invocation and model-facing tool result verified")
		},
	)
})

test("registers and calls a direct MCP tool on the first session", async ({ terminal }) => {
	const echo = directMcpCall("echo", { message: "direct-first-session" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-stdio-direct-tool",
			mcp: {
				directTools: ["echo"],
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: direct-first-session" }] },
							{ message: "direct-first-session" },
						),
					],
				},
			},
			responses: [echo.response, modelReply("The direct MCP tool worked without restarting Kimchi.")],
		},
		async (fixture, trace) => {
			terminal.submit("Call the direct MCP echo tool")
			await waitForText(terminal, "The direct MCP tool worked without restarting Kimchi.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})

			requireRequestAdvertisingTool(fixture.fake.requests, echo.modelToolName)
			const event = await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "direct-first-session" } },
			})
			expect(event.arguments).toEqual({ message: "direct-first-session" })
			expect(toolResultText(fixture.fake.requests, echo)).toContain("fixture echo: direct-first-session")
			trace.step("first-session direct tool registration and invocation verified")
		},
	)
})

test("reads through an annotated direct MCP tool in plan mode while hiding writes", async ({ terminal }) => {
	const read = directMcpCall("getJiraIssue", {})
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-stdio-plan-read-only",
			extraArgs: ["--plan=true"],
			mcp: {
				directTools: ["getJiraIssue", "get_write_access"],
				behavior: {
					catalogTools: [
						{
							name: "getJiraIssue",
							description: "Read a fixture issue",
							inputSchema: { type: "object", properties: {}, additionalProperties: false },
							annotations: { readOnlyHint: true },
						},
						{
							name: "get_write_access",
							description: "Change fixture permissions",
							inputSchema: { type: "object", properties: {}, additionalProperties: false },
							annotations: { readOnlyHint: false },
						},
					],
					tools: [
						mcpToolResult("getJiraIssue", {
							content: [{ type: "text", text: "Fixture issue: planning read succeeded" }],
						}),
					],
				},
			},
			responses: [read.response, modelReply("I read the issue while staying in plan mode.")],
		},
		async (fixture, trace) => {
			terminal.submit("Read the fixture issue to inform the plan")
			await waitForText(terminal, "I read the issue while staying in plan mode.", { timeoutMs: STREAM_TIMEOUT_MS })

			requireRequestAdvertisingTool(fixture.fake.requests, read.modelToolName)
			const request = fixture.fake.requests.find((candidate) => candidate.url.startsWith("/openai/v1/chat/completions"))
			const tools = (request?.body as { tools?: Array<{ function?: { name?: string } }> } | undefined)?.tools ?? []
			const mcpTools = tools
				.map((tool) => tool.function?.name)
				.filter((name) => name === "mcp" || name?.startsWith("fixture_"))
			expect(mcpTools.sort()).toEqual(["mcp", read.modelToolName].sort())
			expect(fixture.mcp.hasEvent("tool_called", { name: "getJiraIssue" })).toBe(true)
			expect(fixture.mcp.hasEvent("tool_called", { name: "get_write_access" })).toBe(false)
			expect(toolResultText(fixture.fake.requests, read)).toContain("Fixture issue: planning read succeeded")
			trace.step("annotated MCP read executed; gateway stayed available and writable direct tool stayed hidden")
		},
	)
})

test("reads Jira through the MCP gateway without leaving a resumed plan-mode session", async ({ terminal }) => {
	const read = gatewayMcpCall("getJiraIssue", { issueIdOrKey: "LLM-4358" })
	const resumedRead = gatewayMcpCall("getJiraIssue", { issueIdOrKey: "LLM-4358" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-stdio-plan-gateway-read",
			extraArgs: ["--plan=true"],
			mcp: {
				behavior: {
					catalogTools: [
						{
							name: "getJiraIssue",
							description: "Read a Jira issue",
							inputSchema: {
								type: "object",
								properties: { issueIdOrKey: { type: "string" } },
								additionalProperties: false,
							},
							annotations: { readOnlyHint: true },
						},
					],
					tools: [
						mcpToolResult("getJiraIssue", {
							content: [{ type: "text", text: "LLM-4358: Enable MCP access in plan mode" }],
						}),
					],
				},
			},
			responses: [
				// Session naming shares the fake model endpoint; keep its asynchronous request
				// from consuming either of the scripted gateway turns.
				{
					...modelReply("Read Jira through the gateway"),
					match: (request) => JSON.stringify(request.body).includes("Name the user's actual task"),
				},
				read.response,
				modelReply("I read LLM-4358 through the gateway while planning."),
				resumedRead.response,
				modelReply("The resumed plan-mode gateway read also succeeded."),
			],
		},
		async (fixture, trace) => {
			terminal.submit("Read LLM-4358 through the gateway to inform the plan")
			await waitForText(terminal, "I read LLM-4358 through the gateway while planning.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})

			requireRequestAdvertisingTool(fixture.fake.requests, "mcp")
			expect(
				fixture.mcp.hasEvent("tool_called", {
					name: "getJiraIssue",
					arguments: { issueIdOrKey: "LLM-4358" },
				}),
			).toBe(true)
			expect(toolResultText(fixture.fake.requests, read)).toContain("LLM-4358: Enable MCP access in plan mode")
			trace.step("read-only Jira gateway call executed without leaving plan mode")

			terminal.submit("/resume")
			await waitForText(terminal, "Resume session", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.keyPress(Key.Enter)
			await waitForText(terminal, "Resumed session", { timeoutMs: STARTUP_TIMEOUT_MS })
			terminal.submit("Read the issue again after resuming")
			await waitForText(terminal, "The resumed plan-mode gateway read also succeeded.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			// Title generation can finish after the resumed turn; inspect the latest
			// main-agent request rather than assuming it is the last recorded request.
			const agentRequests = fixture.fake.requests.filter(
				(request) =>
					request.body !== null &&
					typeof request.body === "object" &&
					"tools" in request.body &&
					Array.isArray(request.body.tools),
			)
			requireRequestAdvertisingTool(agentRequests.slice(-1), "mcp")
			expect(toolResultText(fixture.fake.requests, resumedRead)).toContain("LLM-4358: Enable MCP access in plan mode")
			expect(fixture.mcp.eventsOfType("tool_called").filter((event) => event.name === "getJiraIssue")).toHaveLength(2)
			trace.step("late registration leaves the gateway visible and callable after TUI resume")
		},
	)
})

test("refuses a mutating gateway tool call in plan mode without downstream effects", async ({ terminal }) => {
	const write = gatewayMcpCall("get_write_access", { level: "admin" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-stdio-plan-gateway-write-blocked",
			extraArgs: ["--plan=true"],
			mcp: {
				behavior: {
					catalogTools: [
						{
							name: "get_write_access",
							description: "Change fixture permissions",
							inputSchema: {
								type: "object",
								properties: { level: { type: "string" } },
								additionalProperties: false,
							},
							annotations: { readOnlyHint: false },
						},
					],
					tools: [
						mcpToolResult("get_write_access", {
							content: [{ type: "text", text: "MUTATION EXECUTED" }],
						}),
					],
				},
			},
			responses: [write.response, modelReply("The mutation was blocked in plan mode.")],
		},
		async (fixture, trace) => {
			terminal.submit("Attempt the write even though plan mode is active")
			await waitForText(terminal, "The mutation was blocked in plan mode.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})

			const result = toolResultText(fixture.fake.requests, write)
			expect(result).toContain("This MCP gateway call is unavailable in plan mode.")
			expect(result).not.toContain("MUTATION EXECUTED")
			expect(fixture.mcp.hasEvent("tool_called", { name: "get_write_access" })).toBe(false)
			trace.step("plan refusal reached the model and the mutating MCP tool was never called")
		},
	)
})

test("can call MCP after executing a plan started with --plan", async ({ terminal }) => {
	const echo = gatewayMcpCall("echo", { message: "after-plan" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-stdio-after-plan",
			extraArgs: ["--plan=true"],
			extraEnv: { KIMCHI_PERMISSIONS: "plan" },
			mcp: {
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: after-plan" }] },
							{ message: "after-plan" },
						),
					],
				},
			},
			responses: [
				{
					stream: ["Plan: execute the MCP echo after approval.\n"],
					toolCalls: [
						{
							id: "call_submit_plan",
							type: "function",
							function: {
								name: "submit_plan",
								arguments: JSON.stringify({ plan: "Execute the MCP echo after approval." }),
							},
						},
					],
				},
				echo.response,
				modelReply("MCP remained available after plan approval."),
			],
		},
		async (fixture, trace) => {
			terminal.submit("Plan and then use the MCP echo fixture")
			await waitForText(terminal, "Execute the plan", { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.keyPress(Key.Enter)
			trace.step("approved the plan and transitioned to execution")
			await waitForText(terminal, "Allow the assistant to run this?", { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.keyPress(Key.Enter)
			trace.step("approved the MCP call in auto mode")

			await waitForText(terminal, "MCP remained available after plan approval.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			const called = await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "after-plan" } },
			})
			expect(called.arguments).toEqual({ message: "after-plan" })
			trace.step("MCP gateway call succeeded after plan mode exited")
		},
	)
})

test("delivers an MCP isError result to the next model turn", async ({ terminal }) => {
	const failure = gatewayMcpCall("fail")
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-stdio-tool-error",
			mcp: {
				behavior: {
					tools: [
						mcpToolResult("fail", {
							isError: true,
							content: [{ type: "text", text: "fixture failure: requested by test" }],
						}),
					],
				},
			},
			responses: [failure.response, modelReply("Kimchi handled the MCP tool error and the session continued.")],
		},
		async (fixture, trace) => {
			terminal.submit("Exercise the MCP fixture failure")
			await waitForText(terminal, "Kimchi handled the MCP tool error and the session continued.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})

			expect(toolResultText(fixture.fake.requests, failure)).toContain("Error: fixture failure: requested by test")
			expect(fixture.mcp.hasEvent("tool_called", { name: "fail", arguments: {} })).toBe(true)
			trace.step("MCP isError result reached the model and the turn settled")
		},
	)
})

test("reads an MCP resource through the gateway", async ({ terminal }) => {
	const resource = gatewayMcpCall("read_fixture_note")
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-stdio-resource",
			mcp: {
				behavior: {
					resources: [
						mcpResourceResult("fixture://note", {
							contents: [
								{
									uri: "fixture://note",
									mimeType: "text/plain",
									text: "fixture resource: kimchi-mcp-resource",
								},
							],
						}),
					],
				},
			},
			responses: [resource.response, modelReply("The MCP resource content reached the model.")],
		},
		async (fixture, trace) => {
			terminal.submit("Read the MCP fixture resource")
			await waitForText(terminal, "The MCP resource content reached the model.", { timeoutMs: STREAM_TIMEOUT_MS })

			const resourceEvent = await fixture.mcp.waitForEvent("resource_read", {
				where: { uri: "fixture://note" },
			})
			expect(resourceEvent.uri).toBe("fixture://note")
			expect(toolResultText(fixture.fake.requests, resource)).toContain("fixture resource: kimchi-mcp-resource")
			trace.step("resource read crossed MCP and model boundaries")
		},
	)
})

test("reads an MCP resource through the gateway in plan mode", async ({ terminal }) => {
	const resource = gatewayMcpCall("read_fixture_note")
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-stdio-plan-resource",
			extraArgs: ["--plan=true"],
			mcp: {
				behavior: {
					resources: [
						mcpResourceResult("fixture://note", {
							contents: [
								{
									uri: "fixture://note",
									mimeType: "text/plain",
									text: "fixture resource: kimchi-mcp-resource",
								},
							],
						}),
					],
				},
			},
			responses: [resource.response, modelReply("The MCP resource was read without leaving plan mode.")],
		},
		async (fixture, trace) => {
			terminal.submit("Read the MCP fixture resource before planning")
			await waitForText(terminal, "The MCP resource was read without leaving plan mode.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})

			const resourceEvent = await fixture.mcp.waitForEvent("resource_read", {
				where: { uri: "fixture://note" },
			})
			expect(resourceEvent.uri).toBe("fixture://note")
			expect(toolResultText(fixture.fake.requests, resource)).toContain("fixture resource: kimchi-mcp-resource")
			trace.step("nested resource read crossed MCP and model boundaries in plan mode")
		},
	)
})

test("preserves MCP text and safely represents image content for a text-only model", async ({ terminal }) => {
	const mixedContent = gatewayMcpCall("mixed_content")
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-stdio-mixed-content",
			mcp: {
				behavior: {
					tools: [
						mcpToolResult("mixed_content", {
							content: [
								{ type: "text", text: "fixture mixed content: kimchi-mcp-mixed" },
								{
									type: "image",
									mimeType: "image/png",
									data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
								},
							],
							structuredContent: { fixture: "kimchi-mcp-structured", count: 1 },
						}),
					],
				},
			},
			responses: [mixedContent.response, modelReply("The MCP text and image content both reached the model.")],
		},
		async (fixture, trace) => {
			terminal.submit("Request mixed text and image content from MCP")
			await waitForText(terminal, "The MCP text and image content both reached the model.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})

			const content = toolResultText(fixture.fake.requests, mixedContent)
			expect(content).toContain("fixture mixed content: kimchi-mcp-mixed")
			expect(content).toContain("[image removed: image/png — stripped for non-vision model compatibility]")
			expect(fixture.mcp.hasEvent("tool_called", { name: "mixed_content", arguments: {} })).toBe(true)
			trace.step("mixed MCP content followed the text-only model compatibility contract")
		},
	)
})

test("calls a discovered tool through the MCP gateway after search", async ({ terminal }) => {
	const search = searchMcpTools("fixture echo")
	const echo = gatewayMcpCall("echo", { message: "search-then-gateway-call" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-search-gateway-call",
			mcp: {
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: search-then-gateway-call" }] },
							{ message: "search-then-gateway-call" },
						),
					],
				},
			},
			responses: [search.response, echo.response, modelReply("The MCP gateway called the discovered tool.")],
		},
		async (fixture, trace) => {
			terminal.submit("Search MCP and then call the discovered echo tool")
			await waitForText(terminal, "The MCP gateway called the discovered tool.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "search-then-gateway-call" } },
			})
			requireRequestAdvertisingTool(fixture.fake.requests, echo.modelToolName)
			expect(toolResultText(fixture.fake.requests, echo)).toContain("fixture echo: search-then-gateway-call")
			trace.step("search followed by a gateway invocation of the discovered tool")
		},
	)
})

test("returns MCP server status for an empty gateway call", async ({ terminal }) => {
	const status = emptyMcpCall()
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-empty-call-status",
			// eager: adapter 5.x defers lazy servers until first use, but this
			// test asserts the status of *connected* servers ("1/1").
			mcp: { lifecycle: "eager" },
			responses: [status.response, modelReply("The empty MCP gateway call returned server status.")],
		},
		async (fixture, trace) => {
			terminal.submit("Show MCP status through an empty gateway call")
			await waitForText(terminal, "The empty MCP gateway call returned server status.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			expect(toolResultText(fixture.fake.requests, status)).toMatch(/MCP: 1\/1 servers/)
			trace.step("empty gateway call preserved the MCP status contract")
		},
	)
})

test("does not expose configured secrets through status or describe in plan mode", async ({ terminal }) => {
	const secret = "plan-mode-config-secret-sentinel"
	const status = emptyMcpCall()
	const describe = describeMcpTool("getJiraIssue")
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-stdio-plan-metadata-secret-redaction",
			extraArgs: ["--plan=true"],
			mcp: {
				serverEnv: { MCP_TEST_API_KEY: secret },
				behavior: {
					catalogTools: [
						{
							name: "getJiraIssue",
							description: "Read a Jira issue",
							inputSchema: { type: "object", properties: {}, additionalProperties: false },
							annotations: { readOnlyHint: true },
						},
					],
				},
			},
			responses: [
				status.response,
				describe.response,
				modelReply("Metadata was returned without configuration secrets."),
			],
		},
		async (fixture, trace) => {
			terminal.submit("Inspect server status and the Jira tool schema before planning")
			await waitForText(terminal, "Metadata was returned without configuration secrets.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})

			const statusText = toolResultText(fixture.fake.requests, status)
			const describeText = toolResultText(fixture.fake.requests, describe)
			expect(statusText).toContain("MCP:")
			expect(describeText).toContain("fixture_getJiraIssue")
			expect(statusText).not.toContain(secret)
			expect(describeText).not.toContain(secret)
			expect(JSON.stringify(fixture.fake.requests)).not.toContain(secret)
			trace.step("status and describe reached the model without the config secret")
		},
	)
})

test("routes same-named tools across multiple servers using production defaults", async ({ terminal }) => {
	const primaryEcho = gatewayMcpCall("echo", { message: "from-primary" })
	const secondaryEcho = gatewayMcpCall("echo", { message: "from-secondary" }, { serverName: "secondary" })
	await runMcpKimchiSession(
		terminal,
		{
			artifactName: "mcp-stdio-multiple-servers",
			mcp: {
				behavior: {
					tools: [
						mcpToolResult(
							"echo",
							{ content: [{ type: "text", text: "fixture echo: from-primary" }] },
							{ message: "from-primary" },
						),
					],
				},
				additionalStdioServers: {
					secondary: {
						behavior: {
							tools: [
								mcpToolResult(
									"echo",
									{ content: [{ type: "text", text: "fixture echo: from-secondary" }] },
									{ message: "from-secondary" },
								),
							],
						},
					},
				},
			},
			responses: [
				primaryEcho.response,
				modelReply("The primary MCP server answered."),
				secondaryEcho.response,
				modelReply("The secondary MCP server answered."),
			],
		},
		async (fixture, trace) => {
			terminal.submit("Call echo on the primary MCP server")
			await waitForText(terminal, "The primary MCP server answered.", { timeoutMs: STREAM_TIMEOUT_MS })
			await fixture.mcp.waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "from-primary" } },
			})
			expect(fixture.mcp.server("secondary").hasEvent("tool_called", { name: "echo" })).toBe(false)
			expect(toolResultText(fixture.fake.requests, primaryEcho)).toContain("fixture echo: from-primary")

			terminal.submit("Call echo on the secondary MCP server")
			await waitForText(terminal, "The secondary MCP server answered.", { timeoutMs: STREAM_TIMEOUT_MS })
			await fixture.mcp.server("secondary").waitForEvent("tool_called", {
				where: { name: "echo", arguments: { message: "from-secondary" } },
			})
			expect(toolResultText(fixture.fake.requests, secondaryEcho)).toContain("fixture echo: from-secondary")
			trace.step("default prefixing routed identical tool names to distinct real MCP servers")
		},
	)
})
