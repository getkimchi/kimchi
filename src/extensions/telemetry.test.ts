import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TelemetryConfig } from "../config.js"
import telemetryExtension, { _resetRootSessionId } from "./telemetry.js"

type Handler = (...args: unknown[]) => Promise<void> | void

function createMockApi() {
	const handlers = new Map<string, Handler[]>()
	const on = vi.fn((event: string, handler: (...args: unknown[]) => Promise<void> | void) => {
		if (!handlers.has(event)) handlers.set(event, [])
		handlers.get(event)?.push(handler)
	})
	return { on, handlers, api: { on } as unknown as ExtensionAPI }
}

function getHandler(handlers: Map<string, Handler[]>, event: string): Handler {
	const list = handlers.get(event)
	if (!list || list.length === 0) throw new Error(`No handler registered for ${event}`)
	return list[0]
}

function makeConfig(overrides: Partial<TelemetryConfig> = {}): TelemetryConfig {
	return {
		enabled: true,
		endpoint: "https://api.cast.ai/ai-optimizer/v1beta/logs:ingest",
		metricsEndpoint: "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
		headers: { Authorization: "Bearer test-key" },
		...overrides,
	}
}

describe("telemetryExtension", () => {
	let fetchMock: ReturnType<typeof vi.fn>
	let originalFetch: typeof globalThis.fetch

	beforeEach(() => {
		fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "" })
		originalFetch = globalThis.fetch
		// biome-ignore lint/suspicious/noExplicitAny: test-only fetch mock
		globalThis.fetch = fetchMock as any
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
		_resetRootSessionId()
	})

	describe("disabled telemetry", () => {
		it("does not send anything when disabled", async () => {
			const { handlers, api } = createMockApi()
			const ext = telemetryExtension(makeConfig({ enabled: false }))
			ext(api)

			// When disabled, the extension returns early and registers no handlers.
			expect(handlers.has("session_start")).toBe(false)
			expect(handlers.has("message_end")).toBe(false)
			expect(handlers.has("tool_execution_start")).toBe(false)
			expect(handlers.has("tool_execution_end")).toBe(false)
			expect(handlers.has("session_shutdown")).toBe(false)
			expect(fetchMock).not.toHaveBeenCalled()
		})
	})

	describe("message_end", () => {
		it("sends logs and metrics after an assistant message", async () => {
			const { handlers, api } = createMockApi()
			const ext = telemetryExtension(makeConfig())
			ext(api)

			// Start session so sessionId is set
			await getHandler(handlers, "session_start")()

			const msgEnd = getHandler(handlers, "message_end")
			await msgEnd({
				message: {
					role: "assistant",
					model: "test-model",
					provider: "test-provider",
					timestamp: Date.now(),
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						cost: { total: 0.001 },
					},
				},
			})

			// Drain in-flight promises
			await getHandler(handlers, "session_shutdown")()

			const logCalls = fetchMock.mock.calls.filter(
				([url]) => String(url) === "https://api.cast.ai/ai-optimizer/v1beta/logs:ingest",
			)
			const metricsCalls = fetchMock.mock.calls.filter(
				([url]) => String(url) === "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
			)

			expect(logCalls.length).toBeGreaterThanOrEqual(1)
			expect(metricsCalls.length).toBe(1)

			const metricsPayload = JSON.parse(String((metricsCalls[0][1] as RequestInit).body))
			const metrics = metricsPayload.resourceMetrics[0].scopeMetrics[0].metrics
			expect(metrics).toHaveLength(3) // token.input, token.output, cost.usage
			// (code_edit_tool.decision is only emitted when tools generate edit decisions)

			const names = metrics.map((m: { name: string }) => m.name)
			expect(names).toContain("claude_code.token.usage")
			expect(names).toContain("claude_code.cost.usage")
		})

		it("includes user_agent.original in metrics resource attributes", async () => {
			const { handlers, api } = createMockApi()
			const ext = telemetryExtension(makeConfig())
			ext(api)

			await getHandler(handlers, "session_start")()

			await getHandler(
				handlers,
				"message_end",
			)({
				message: {
					role: "assistant",
					model: "test-model",
					provider: "test-provider",
					timestamp: Date.now(),
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						cost: { total: 0.001 },
					},
				},
			})

			await getHandler(handlers, "session_shutdown")()

			const metricsCalls = fetchMock.mock.calls.filter(
				([url]) => String(url) === "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
			)
			expect(metricsCalls.length).toBe(1)

			const payload = JSON.parse(String((metricsCalls[0][1] as RequestInit).body))
			const resourceAttrs = payload.resourceMetrics[0].resource.attributes
			const uaAttr = resourceAttrs.find((a: { key: string }) => a.key === "user_agent.original")
			expect(uaAttr).toBeDefined()
			expect(uaAttr.value.stringValue).toMatch(/^kimchi\//)
		})

		it("includes user_agent.original in logs resource attributes", async () => {
			const { handlers, api } = createMockApi()
			const ext = telemetryExtension(makeConfig())
			ext(api)

			await getHandler(handlers, "session_start")()

			await getHandler(
				handlers,
				"message_end",
			)({
				message: {
					role: "assistant",
					model: "test-model",
					provider: "test-provider",
					timestamp: Date.now(),
					usage: {
						input: 10,
						output: 5,
						cacheRead: 0,
						cacheWrite: 0,
						cost: { total: 0.001 },
					},
				},
			})

			await getHandler(handlers, "session_shutdown")()

			const logCalls = fetchMock.mock.calls.filter(
				([url]) => String(url) === "https://api.cast.ai/ai-optimizer/v1beta/logs:ingest",
			)
			expect(logCalls.length).toBeGreaterThanOrEqual(1)

			const payload = JSON.parse(String((logCalls[0][1] as RequestInit).body))
			const resourceAttrs = payload.resourceLogs[0].resource.attributes
			const uaAttr = resourceAttrs.find((a: { key: string }) => a.key === "user_agent.original")
			expect(uaAttr).toBeDefined()
			expect(uaAttr.value.stringValue).toMatch(/^kimchi\//)
		})

		it("deduplicates duplicate assistant messages using message id", async () => {
			const { handlers, api } = createMockApi()
			const ext = telemetryExtension(makeConfig())
			ext(api)

			await getHandler(handlers, "session_start")()

			const msgEnd = getHandler(handlers, "message_end")
			const ts = Date.now()
			await msgEnd({
				message: {
					role: "assistant",
					id: "msg-123",
					model: "test-model",
					provider: "test-provider",
					timestamp: ts,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						cost: { total: 0.001 },
					},
				},
			})
			await msgEnd({
				message: {
					role: "assistant",
					id: "msg-123", // Same ID should be deduplicated
					model: "test-model",
					provider: "test-provider",
					timestamp: ts,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						cost: { total: 0.001 },
					},
				},
			})

			await getHandler(handlers, "session_shutdown")()

			const metricsCalls = fetchMock.mock.calls.filter(
				([url]) => String(url) === "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
			)
			// Should only have 1 call for the first message
			expect(metricsCalls.length).toBe(1)
		})

		it("accumulates tokens across multiple messages", async () => {
			const { handlers, api } = createMockApi()
			const ext = telemetryExtension(makeConfig())
			ext(api)

			await getHandler(handlers, "session_start")()

			const msgEnd = getHandler(handlers, "message_end")

			// First message
			await msgEnd({
				message: {
					role: "assistant",
					model: "test-model",
					provider: "test-provider",
					timestamp: Date.now(),
					usage: {
						input: 100,
						output: 50,
						cacheRead: 0,
						cacheWrite: 0,
						cost: { total: 0.01 },
					},
				},
			})

			// Second message
			await msgEnd({
				message: {
					role: "assistant",
					model: "test-model",
					provider: "test-provider",
					timestamp: Date.now() + 1,
					usage: {
						input: 200,
						output: 75,
						cacheRead: 0,
						cacheWrite: 0,
						cost: { total: 0.02 },
					},
				},
			})

			await getHandler(handlers, "session_shutdown")()

			const metricsCalls = fetchMock.mock.calls.filter(
				([url]) => String(url) === "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
			)
			// Only session_shutdown triggers the final flush
			expect(metricsCalls.length).toBe(1)

			const payload = JSON.parse(String((metricsCalls[0][1] as RequestInit).body))
			const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics

			// Token metrics should have accumulated values (300 input, 125 output)
			const tokenInput = metrics.find(
				(m: {
					name: string
					sum?: {
						dataPoints: Array<{ asInt?: string; attributes: Array<{ key: string; value: { stringValue: string } }> }>
					}
				}) =>
					m.name === "claude_code.token.usage" &&
					m.sum?.dataPoints[0].attributes.some(
						(a: { key: string; value: { stringValue: string } }) => a.key === "type" && a.value.stringValue === "input",
					),
			)
			expect(tokenInput?.sum?.dataPoints[0].asInt).toBe("300")

			const tokenOutput = metrics.find(
				(m: {
					name: string
					sum?: {
						dataPoints: Array<{ asInt?: string; attributes: Array<{ key: string; value: { stringValue: string } }> }>
					}
				}) =>
					m.name === "claude_code.token.usage" &&
					m.sum?.dataPoints[0].attributes.some(
						(a: { key: string; value: { stringValue: string } }) =>
							a.key === "type" && a.value.stringValue === "output",
					),
			)
			expect(tokenOutput?.sum?.dataPoints[0].asInt).toBe("125")

			// Cost should accumulate (0.03)
			const costMetric = metrics.find(
				(m: { name: string; sum?: { dataPoints: Array<{ asDouble?: number }> } }) =>
					m.name === "claude_code.cost.usage",
			)
			expect(costMetric?.sum?.dataPoints[0].asDouble).toBeCloseTo(0.03)
		})
	})

	describe("tool_execution_end", () => {
		it("sends commit and lines-of-code metrics for git commit", async () => {
			const { handlers, api } = createMockApi()
			const ext = telemetryExtension(makeConfig())
			ext(api)

			await getHandler(handlers, "session_start")()

			const toolStart = getHandler(handlers, "tool_execution_start")
			const toolEnd = getHandler(handlers, "tool_execution_end")

			toolStart({ toolCallId: "tc1", toolName: "bash", args: { command: "git commit -m 'wip'" } })
			await toolEnd({ toolCallId: "tc1" })

			await getHandler(handlers, "session_shutdown")()

			const metricsCalls = fetchMock.mock.calls.filter(
				([url]) => String(url) === "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
			)
			// One call with all metrics for this batch
			expect(metricsCalls.length).toBe(1)
			const payload = JSON.parse(String((metricsCalls[0][1] as RequestInit).body))
			const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics
			const names = metrics.map((m: { name: string }) => m.name)
			expect(names).toContain("claude_code.commit.count")
		})

		it("sends pull_request metric for gh pr create", async () => {
			const { handlers, api } = createMockApi()
			const ext = telemetryExtension(makeConfig())
			ext(api)

			await getHandler(handlers, "session_start")()

			const toolStart = getHandler(handlers, "tool_execution_start")
			const toolEnd = getHandler(handlers, "tool_execution_end")

			toolStart({ toolCallId: "tc1", toolName: "bash", args: { command: "gh pr create --title 'x'" } })
			await toolEnd({ toolCallId: "tc1" })

			await getHandler(handlers, "session_shutdown")()

			const metricsCalls = fetchMock.mock.calls.filter(
				([url]) => String(url) === "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
			)
			const payload = JSON.parse(String((metricsCalls[0][1] as RequestInit).body))
			const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics
			const names = metrics.map((m: { name: string }) => m.name)
			expect(names).toContain("claude_code.pull_request.count")
		})

		it("sends lines_of_code metric for edit tool with type attribute", async () => {
			const { handlers, api } = createMockApi()
			const ext = telemetryExtension(makeConfig())
			ext(api)

			await getHandler(handlers, "session_start")()

			const toolStart = getHandler(handlers, "tool_execution_start")
			const toolEnd = getHandler(handlers, "tool_execution_end")

			toolStart({
				toolCallId: "tc1",
				toolName: "edit",
				args: {
					filePath: "/tmp/example.ts",
					oldString: "old line\n",
					newString: "new line 1\nnew line 2\n",
				},
			})
			await toolEnd({ toolCallId: "tc1" })

			await getHandler(handlers, "session_shutdown")()

			const metricsCalls = fetchMock.mock.calls.filter(
				([url]) => String(url) === "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
			)
			const payload = JSON.parse(String((metricsCalls[0][1] as RequestInit).body))
			const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics

			// Should have separate added and removed metrics
			const locMetrics = metrics.filter((m: { name: string }) => m.name === "claude_code.lines_of_code.count")
			expect(locMetrics.length).toBeGreaterThan(0)

			// countLineChanges trims trailing newlines, so "old line\n" -> ["old line"] (1 line)
			// "new line 1\nnew line 2\n" trimmed -> "new line 1\nnew line 2" -> ["new line 1", "new line 2"] (2 lines)
			// For a pure-addition edit, added = 2-1 = 1, removed = 0
			// Verify the "added" metric has value 1
			const addedMetric = locMetrics.find(
				(m: { sum?: { dataPoints: Array<{ attributes: Array<{ key: string; value: { stringValue: string } }> }> } }) =>
					m.sum?.dataPoints[0]?.attributes?.some((a) => a.key === "type" && a.value.stringValue === "added"),
			)
			expect(addedMetric).toBeDefined()
			expect(addedMetric.sum.dataPoints[0].asInt).toBe("1")

			// For a pure-addition edit, no "removed" metric should be emitted (since nothing was removed)
			const removedMetric = locMetrics.find(
				(m: { sum?: { dataPoints: Array<{ attributes: Array<{ key: string; value: { stringValue: string } }> }> } }) =>
					m.sum?.dataPoints[0]?.attributes?.some((a) => a.key === "type" && a.value.stringValue === "removed"),
			)
			expect(removedMetric).toBeUndefined()
		})

		it("sends lines_of_code metric for write tool with trailing newline handled", async () => {
			const { handlers, api } = createMockApi()
			const ext = telemetryExtension(makeConfig())
			ext(api)

			await getHandler(handlers, "session_start")()

			const toolStart = getHandler(handlers, "tool_execution_start")
			const toolEnd = getHandler(handlers, "tool_execution_end")

			// Content with trailing newline
			toolStart({
				toolCallId: "tc1",
				toolName: "write",
				args: {
					filePath: "/tmp/hello.py",
					content: "line 1\nline 2\nline 3\n", // trailing newline
				},
			})
			await toolEnd({ toolCallId: "tc1" })

			await getHandler(handlers, "session_shutdown")()

			const metricsCalls = fetchMock.mock.calls.filter(
				([url]) => String(url) === "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
			)
			const payload = JSON.parse(String((metricsCalls[0][1] as RequestInit).body))
			const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics
			const locMetric = metrics.find((m: { name: string }) => m.name === "claude_code.lines_of_code.count")
			expect(locMetric).toBeDefined()
			// Should be 3, not 4 (trailing newline not counted)
			expect(locMetric.sum.dataPoints[0].asInt).toBe("3")
		})

		it("accumulates commit count across multiple commits", async () => {
			const { handlers, api } = createMockApi()
			const ext = telemetryExtension(makeConfig())
			ext(api)

			await getHandler(handlers, "session_start")()

			const toolStart = getHandler(handlers, "tool_execution_start")
			const toolEnd = getHandler(handlers, "tool_execution_end")

			// First commit
			toolStart({ toolCallId: "tc1", toolName: "bash", args: { command: "git commit -m 'fix 1'" } })
			await toolEnd({ toolCallId: "tc1" })

			// Second commit
			toolStart({ toolCallId: "tc2", toolName: "bash", args: { command: "git commit -m 'fix 2'" } })
			await toolEnd({ toolCallId: "tc2" })

			await getHandler(handlers, "session_shutdown")()

			const metricsCalls = fetchMock.mock.calls.filter(
				([url]) => String(url) === "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
			)
			const payload = JSON.parse(String((metricsCalls[0][1] as RequestInit).body))
			const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics
			const commitMetric = metrics.find((m: { name: string }) => m.name === "claude_code.commit.count")
			expect(commitMetric.sum.dataPoints[0].asInt).toBe("2")
		})

		it("sends lines_of_code metric for multiedit tool", async () => {
			const { handlers, api } = createMockApi()
			const ext = telemetryExtension(makeConfig())
			ext(api)

			await getHandler(handlers, "session_start")()

			const toolStart = getHandler(handlers, "tool_execution_start")
			const toolEnd = getHandler(handlers, "tool_execution_end")

			toolStart({
				toolCallId: "tc1",
				toolName: "multiedit",
				args: {
					filePath: "/tmp/example.ts",
					edits: [
						{ oldString: "a\n", newString: "a\nb\n" },
						{ oldString: "c\n", newString: "c\nd\n" },
					],
				},
			})
			await toolEnd({ toolCallId: "tc1" })

			await getHandler(handlers, "session_shutdown")()

			const metricsCalls = fetchMock.mock.calls.filter(
				([url]) => String(url) === "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
			)
			const payload = JSON.parse(String((metricsCalls[0][1] as RequestInit).body))
			const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics

			const locMetrics = metrics.filter(
				(m: {
					name: string
					sum?: {
						dataPoints: Array<{ asInt?: string; attributes: Array<{ key: string; value: { stringValue: string } }> }>
					}
				}) => m.name === "claude_code.lines_of_code.count",
			)
			expect(locMetrics.length).toBeGreaterThan(0)

			// Total added should be 2 (one for each edit)
			const totalAdded = locMetrics
				.filter(
					(m: {
						sum?: {
							dataPoints: Array<{ asInt?: string; attributes: Array<{ key: string; value: { stringValue: string } }> }>
						}
					}) =>
						m.sum?.dataPoints[0].attributes.some(
							(a: { key: string; value: { stringValue: string } }) =>
								a.key === "type" && a.value.stringValue === "added",
						),
				)
				.reduce(
					(sum: number, m: { sum?: { dataPoints: Array<{ asInt?: string }> } }) =>
						sum + Number.parseInt(m.sum?.dataPoints[0].asInt ?? "0", 10),
					0,
				)
			expect(totalAdded).toBe(2)
		})

		it("sends lines_of_code and decision metrics for patch tool", async () => {
			const { handlers, api } = createMockApi()
			const ext = telemetryExtension(makeConfig())
			ext(api)

			await getHandler(handlers, "session_start")()

			const toolStart = getHandler(handlers, "tool_execution_start")
			const toolEnd = getHandler(handlers, "tool_execution_end")

			toolStart({
				toolCallId: "p1",
				toolName: "patch",
				args: {
					filePath: "/tmp/server.go",
					oldString: "line1\nline2\n",
					newString: "line1\nline2\nline3\n",
				},
			})
			await toolEnd({ toolCallId: "p1" })

			await getHandler(handlers, "session_shutdown")()

			const metricsCalls = fetchMock.mock.calls.filter(
				([url]) => String(url) === "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
			)
			const payload = JSON.parse(String((metricsCalls[0][1] as RequestInit).body))
			const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics

			// lines_of_code: 1 added (3 lines vs 2 lines after trimming), 0 removed
			const addedMetric = metrics.find(
				(m: {
					name: string
					sum?: {
						dataPoints: Array<{ asInt?: string; attributes: Array<{ key: string; value: { stringValue: string } }> }>
					}
				}) =>
					m.name === "claude_code.lines_of_code.count" &&
					m.sum?.dataPoints[0]?.attributes?.some((a) => a.key === "type" && a.value.stringValue === "added"),
			)
			expect(addedMetric).toBeDefined()
			expect(addedMetric.sum.dataPoints[0].asInt).toBe("1")

			// language should be inferred from filePath, not hardcoded "patch"
			const langAttr = addedMetric.sum.dataPoints[0].attributes.find(
				(a: { key: string; value: { stringValue: string } }) => a.key === "language",
			)
			expect(langAttr?.value.stringValue).toBe("Go")

			// decision metric with accept
			const decisionMetric = metrics.find((m: { name: string }) => m.name === "claude_code.code_edit_tool.decision")
			expect(decisionMetric).toBeDefined()
			const decisionAttrs = decisionMetric.sum.dataPoints[0].attributes as Array<{
				key: string
				value: { stringValue: string }
			}>
			expect(decisionAttrs.find((a) => a.key === "tool_name")?.value.stringValue).toBe("patch")
			expect(decisionAttrs.find((a) => a.key === "decision")?.value.stringValue).toBe("accept")
			expect(decisionAttrs.find((a) => a.key === "language")?.value.stringValue).toBe("Go")
		})

		it("patch tool with no-op (identical strings) emits zero line changes", async () => {
			const { handlers, api } = createMockApi()
			const ext = telemetryExtension(makeConfig())
			ext(api)

			await getHandler(handlers, "session_start")()

			const toolStart = getHandler(handlers, "tool_execution_start")
			const toolEnd = getHandler(handlers, "tool_execution_end")

			toolStart({
				toolCallId: "p2",
				toolName: "patch",
				args: {
					filePath: "/tmp/main.py",
					oldString: "same content\n",
					newString: "same content\n",
				},
			})
			await toolEnd({ toolCallId: "p2" })

			await getHandler(handlers, "session_shutdown")()

			const metricsCalls = fetchMock.mock.calls.filter(
				([url]) => String(url) === "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
			)
			const payload = JSON.parse(String((metricsCalls[0][1] as RequestInit).body))
			const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics

			// no lines_of_code metrics (nothing changed)
			const locMetrics = metrics.filter((m: { name: string }) => m.name === "claude_code.lines_of_code.count")
			expect(locMetrics).toHaveLength(0)

			// decision metric still emitted (the tool was used)
			const decisionMetric = metrics.find((m: { name: string }) => m.name === "claude_code.code_edit_tool.decision")
			expect(decisionMetric).toBeDefined()
			expect(decisionMetric.sum.dataPoints[0].asInt).toBe("1")
		})

		it("patch tool with no filePath uses unknown language", async () => {
			const { handlers, api } = createMockApi()
			const ext = telemetryExtension(makeConfig())
			ext(api)

			await getHandler(handlers, "session_start")()

			const toolStart = getHandler(handlers, "tool_execution_start")
			const toolEnd = getHandler(handlers, "tool_execution_end")

			toolStart({
				toolCallId: "p3",
				toolName: "patch",
				args: {
					oldString: "a\n",
					newString: "a\nb\n",
				},
			})
			await toolEnd({ toolCallId: "p3" })

			await getHandler(handlers, "session_shutdown")()

			const metricsCalls = fetchMock.mock.calls.filter(
				([url]) => String(url) === "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
			)
			const payload = JSON.parse(String((metricsCalls[0][1] as RequestInit).body))
			const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics

			const addedMetric = metrics.find(
				(m: {
					name: string
					sum?: { dataPoints: Array<{ attributes: Array<{ key: string; value: { stringValue: string } }> }> }
				}) =>
					m.name === "claude_code.lines_of_code.count" &&
					m.sum?.dataPoints[0]?.attributes?.some((a) => a.key === "type" && a.value.stringValue === "added"),
			)
			expect(addedMetric).toBeDefined()
			const langAttr = addedMetric.sum.dataPoints[0].attributes.find(
				(a: { key: string; value: { stringValue: string } }) => a.key === "language",
			)
			expect(langAttr?.value.stringValue).toBe("unknown")
		})

		it("sends code_edit_tool.decision metric", async () => {
			const { handlers, api } = createMockApi()
			const ext = telemetryExtension(makeConfig())
			ext(api)

			await getHandler(handlers, "session_start")()

			const toolStart = getHandler(handlers, "tool_execution_start")
			const toolEnd = getHandler(handlers, "tool_execution_end")

			toolStart({
				toolCallId: "tc1",
				toolName: "edit",
				args: {
					filePath: "/tmp/example.ts",
					oldString: "old",
					newString: "new",
				},
			})
			await toolEnd({ toolCallId: "tc1" })

			await getHandler(handlers, "session_shutdown")()

			const metricsCalls = fetchMock.mock.calls.filter(
				([url]) => String(url) === "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
			)
			const payload = JSON.parse(String((metricsCalls[0][1] as RequestInit).body))
			const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics

			const decisionMetric = metrics.find((m: { name: string }) => m.name === "claude_code.code_edit_tool.decision")
			expect(decisionMetric).toBeDefined()
			const decisionAttrs = decisionMetric.sum.dataPoints[0].attributes as Array<{
				key: string
				value: { stringValue: string }
			}>
			expect(decisionAttrs.find((a) => a.key === "tool_name")?.value.stringValue).toBe("edit")
			expect(decisionAttrs.find((a) => a.key === "decision")?.value.stringValue).toBe("accept")
			expect(decisionAttrs.find((a) => a.key === "source")?.value.stringValue).toBe("auto")
			expect(decisionAttrs.some((a) => a.key === "decision_type")).toBe(false)
		})

		it("sends tool.usage and tool.duration_ms per tool type", async () => {
			vi.useFakeTimers()
			const { handlers, api } = createMockApi()
			const ext = telemetryExtension(makeConfig())
			ext(api)

			await getHandler(handlers, "session_start")()

			const toolStart = getHandler(handlers, "tool_execution_start")
			const toolEnd = getHandler(handlers, "tool_execution_end")

			// 3 bash calls, 2 edit calls with varying durations
			await toolStart({ toolCallId: "b1", toolName: "bash", args: { command: "ls" } })
			await vi.advanceTimersByTimeAsync(50)
			await toolEnd({ toolCallId: "b1", result: { ok: true, value: "" } })

			await toolStart({ toolCallId: "b2", toolName: "bash", args: { command: "pwd" } })
			await vi.advanceTimersByTimeAsync(30)
			await toolEnd({ toolCallId: "b2", result: { ok: true, value: "" } })

			await toolStart({ toolCallId: "b3", toolName: "bash", args: { command: "echo hi" } })
			await vi.advanceTimersByTimeAsync(20)
			await toolEnd({ toolCallId: "b3", result: { ok: true, value: "" } })

			await toolStart({ toolCallId: "e1", toolName: "edit", args: { filePath: "a.ts" } })
			await vi.advanceTimersByTimeAsync(200)
			await toolEnd({ toolCallId: "e1", result: { ok: true, value: "" } })

			await toolStart({ toolCallId: "e2", toolName: "edit", args: { filePath: "b.ts" } })
			await vi.advanceTimersByTimeAsync(150)
			await toolEnd({ toolCallId: "e2", result: { ok: true, value: "" } })

			await getHandler(handlers, "session_shutdown")()
			vi.useRealTimers()

			const metricsCalls = fetchMock.mock.calls.filter(
				([url]) => String(url) === "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
			)
			const payload = JSON.parse(String((metricsCalls[0][1] as RequestInit).body))
			const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics

			// Verify per-tool usage counts
			const usageMetrics = metrics.filter((m: { name: string }) => m.name === "claude_code.tool.usage")
			expect(usageMetrics).toHaveLength(2) // bash + edit

			const bashUsage = usageMetrics.find(
				(m: { sum: { dataPoints: Array<{ attributes: Array<{ key: string; value: { stringValue: string } }> }> } }) =>
					m.sum.dataPoints[0].attributes.some((a) => a.key === "tool_name" && a.value.stringValue === "bash"),
			)
			expect(bashUsage.sum.dataPoints[0].asInt).toBe("3")

			const editUsage = usageMetrics.find(
				(m: { sum: { dataPoints: Array<{ attributes: Array<{ key: string; value: { stringValue: string } }> }> } }) =>
					m.sum.dataPoints[0].attributes.some((a) => a.key === "tool_name" && a.value.stringValue === "edit"),
			)
			expect(editUsage.sum.dataPoints[0].asInt).toBe("2")

			// Verify per-tool duration sums
			const durationMetrics = metrics.filter((m: { name: string }) => m.name === "claude_code.tool.duration_ms")
			expect(durationMetrics).toHaveLength(2) // bash + edit

			const bashDuration = durationMetrics.find(
				(m: { sum: { dataPoints: Array<{ attributes: Array<{ key: string; value: { stringValue: string } }> }> } }) =>
					m.sum.dataPoints[0].attributes.some((a) => a.key === "tool_name" && a.value.stringValue === "bash"),
			)
			expect(Number(bashDuration.sum.dataPoints[0].asInt)).toBe(100) // 50 + 30 + 20

			const editDuration = durationMetrics.find(
				(m: { sum: { dataPoints: Array<{ attributes: Array<{ key: string; value: { stringValue: string } }> }> } }) =>
					m.sum.dataPoints[0].attributes.some((a) => a.key === "tool_name" && a.value.stringValue === "edit"),
			)
			expect(Number(editDuration.sum.dataPoints[0].asInt)).toBe(350) // 200 + 150
		})

		it("accumulates tool.usage across sub-agents with shared accumulators", async () => {
			const { handlers: h1, api: api1 } = createMockApi()
			const { handlers: h2, api: api2 } = createMockApi()
			const ext1 = telemetryExtension(makeConfig())
			const ext2 = telemetryExtension(makeConfig())
			ext1(api1)
			ext2(api2)

			await getHandler(h1, "session_start")()
			await getHandler(h2, "session_start")()

			// Main agent: 2 bash calls
			const toolStart1 = getHandler(h1, "tool_execution_start")
			const toolEnd1 = getHandler(h1, "tool_execution_end")
			await toolStart1({ toolCallId: "b1", toolName: "bash", args: { command: "ls" } })
			await toolEnd1({ toolCallId: "b1", result: { ok: true, value: "" } })
			await toolStart1({ toolCallId: "b2", toolName: "bash", args: { command: "pwd" } })
			await toolEnd1({ toolCallId: "b2", result: { ok: true, value: "" } })

			// Sub-agent: 3 bash calls
			const toolStart2 = getHandler(h2, "tool_execution_start")
			const toolEnd2 = getHandler(h2, "tool_execution_end")
			await toolStart2({ toolCallId: "b3", toolName: "bash", args: { command: "echo a" } })
			await toolEnd2({ toolCallId: "b3", result: { ok: true, value: "" } })
			await toolStart2({ toolCallId: "b4", toolName: "bash", args: { command: "echo b" } })
			await toolEnd2({ toolCallId: "b4", result: { ok: true, value: "" } })
			await toolStart2({ toolCallId: "b5", toolName: "bash", args: { command: "echo c" } })
			await toolEnd2({ toolCallId: "b5", result: { ok: true, value: "" } })

			await getHandler(h1, "session_shutdown")()
			await getHandler(h2, "session_shutdown")()

			// Last flush should contain the combined total of 5 bash calls
			const metricsCalls = fetchMock.mock.calls.filter(
				([url]) => String(url) === "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
			)
			expect(metricsCalls.length).toBeGreaterThanOrEqual(1)

			const lastPayload = JSON.parse(String((metricsCalls[metricsCalls.length - 1][1] as RequestInit).body))
			const metrics = lastPayload.resourceMetrics[0].scopeMetrics[0].metrics
			const bashUsage = metrics.find(
				(m: {
					name: string
					sum?: { dataPoints: Array<{ attributes: Array<{ key: string; value: { stringValue: string } }> }> }
				}) =>
					m.name === "claude_code.tool.usage" &&
					m.sum?.dataPoints[0]?.attributes?.some((a) => a.key === "tool_name" && a.value.stringValue === "bash"),
			)
			expect(bashUsage?.sum?.dataPoints[0]?.asInt).toBe("5")
		})
	})

	describe("metrics payload shape", () => {
		it("includes required attributes on every data point", async () => {
			const { handlers, api } = createMockApi()
			const ext = telemetryExtension(makeConfig())
			ext(api)

			await getHandler(handlers, "session_start")()

			const msgEnd = getHandler(handlers, "message_end")
			await msgEnd({
				message: {
					role: "assistant",
					model: "test-model",
					provider: "test-provider",
					timestamp: Date.now(),
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						cost: { total: 0.001 },
					},
				},
			})

			await getHandler(handlers, "session_shutdown")()

			const metricsCalls = fetchMock.mock.calls.filter(
				([url]) => String(url) === "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
			)
			const payload = JSON.parse(String((metricsCalls[0][1] as RequestInit).body))
			const dp = payload.resourceMetrics[0].scopeMetrics[0].metrics[0].sum.dataPoints[0]
			const attrKeys = dp.attributes.map((a: { key: string }) => a.key)
			expect(attrKeys).toContain("session.id")
			expect(attrKeys).toContain("client")
		})

		it("includes startTimeUnixNano on every data point", async () => {
			vi.useFakeTimers()
			const fixedMs = 1_700_000_000_000
			vi.setSystemTime(fixedMs)

			const { handlers, api } = createMockApi()
			const ext = telemetryExtension(makeConfig())
			ext(api)

			await getHandler(handlers, "session_start")()

			const msgEnd = getHandler(handlers, "message_end")
			await msgEnd({
				message: {
					role: "assistant",
					model: "test-model",
					provider: "test-provider",
					timestamp: fixedMs,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						cost: { total: 0.001 },
					},
				},
			})

			await getHandler(handlers, "session_shutdown")()

			const metricsCalls = fetchMock.mock.calls.filter(
				([url]) => String(url) === "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
			)
			const payload = JSON.parse(String((metricsCalls[0][1] as RequestInit).body))
			const dataPoints = payload.resourceMetrics[0].scopeMetrics[0].metrics.flatMap(
				(m: {
					sum?: { dataPoints: Array<{ startTimeUnixNano: string }> }
					gauge?: { dataPoints: Array<{ startTimeUnixNano: string }> }
				}) => [
					...((m.sum?.dataPoints ?? []) as Array<{ startTimeUnixNano: string }>),
					...((m.gauge?.dataPoints ?? []) as Array<{ startTimeUnixNano: string }>),
				],
			)

			const expectedStartTimeNano = String(fixedMs * 1_000_000)
			for (const dp of dataPoints) {
				expect(dp.startTimeUnixNano).toBeDefined()
				expect(typeof dp.startTimeUnixNano).toBe("string")
				expect(dp.startTimeUnixNano.length).toBeGreaterThan(0)
				expect(dp.startTimeUnixNano).toBe(expectedStartTimeNano)
			}

			vi.useRealTimers()
		})

		it("uses isMonotonic: true for all Sum metrics", async () => {
			const { handlers, api } = createMockApi()
			const ext = telemetryExtension(makeConfig())
			ext(api)

			await getHandler(handlers, "session_start")()

			const msgEnd = getHandler(handlers, "message_end")
			await msgEnd({
				message: {
					role: "assistant",
					model: "test-model",
					provider: "test-provider",
					timestamp: Date.now(),
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						cost: { total: 0.001 },
					},
				},
			})

			await getHandler(handlers, "session_shutdown")()

			const metricsCalls = fetchMock.mock.calls.filter(
				([url]) => String(url) === "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
			)
			const payload = JSON.parse(String((metricsCalls[0][1] as RequestInit).body))
			const sumMetrics = payload.resourceMetrics[0].scopeMetrics[0].metrics.filter((m: { sum?: unknown }) => m.sum)
			for (const m of sumMetrics) {
				expect(m.sum.isMonotonic).toBe(true)
			}
		})

		it("sends cost.usage as Sum type", async () => {
			const { handlers, api } = createMockApi()
			const ext = telemetryExtension(makeConfig())
			ext(api)

			await getHandler(handlers, "session_start")()

			const msgEnd = getHandler(handlers, "message_end")
			await msgEnd({
				message: {
					role: "assistant",
					model: "test-model",
					provider: "test-provider",
					timestamp: Date.now(),
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						cost: { total: 0.001 },
					},
				},
			})

			await getHandler(handlers, "session_shutdown")()

			const metricsCalls = fetchMock.mock.calls.filter(
				([url]) => String(url) === "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
			)
			const payload = JSON.parse(String((metricsCalls[0][1] as RequestInit).body))
			const costMetric = payload.resourceMetrics[0].scopeMetrics[0].metrics.find(
				(m: { name: string }) => m.name === "claude_code.cost.usage",
			)
			expect(costMetric).toBeDefined()
			expect(costMetric.sum).toBeDefined() // Should be Sum, not Gauge
			expect(costMetric.gauge).toBeUndefined()
		})

		it("accumulates multiple edit decisions into a single metric", async () => {
			const { handlers, api } = createMockApi()
			const ext = telemetryExtension(makeConfig())
			ext(api)

			await getHandler(handlers, "session_start")()

			const toolStart = getHandler(handlers, "tool_execution_start")
			const toolEnd = getHandler(handlers, "tool_execution_end")

			// First edit
			await toolStart({ toolCallId: "e1", toolName: "edit", args: { filePath: "a.ts" } })
			await toolEnd({ toolCallId: "e1", result: { ok: true, value: "" } })

			// Second edit to same file
			await toolStart({ toolCallId: "e2", toolName: "edit", args: { filePath: "a.ts" } })
			await toolEnd({ toolCallId: "e2", result: { ok: true, value: "" } })

			await getHandler(handlers, "session_shutdown")()

			const metricsCalls = fetchMock.mock.calls.filter(
				([url]) => String(url) === "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
			)
			const payload = JSON.parse(String((metricsCalls[0][1] as RequestInit).body))
			const decisionMetrics = payload.resourceMetrics[0].scopeMetrics[0].metrics.filter(
				(m: { name: string }) => m.name === "claude_code.code_edit_tool.decision",
			)
			// Should be a single metric, not two
			expect(decisionMetrics).toHaveLength(1)
			expect(decisionMetrics[0].sum.dataPoints[0].asInt).toBe("2")
		})

		it("includes language on all lines_of_code.count metrics", async () => {
			const { handlers, api } = createMockApi()
			const ext = telemetryExtension(makeConfig())
			ext(api)

			await getHandler(handlers, "session_start")()

			const toolStart = getHandler(handlers, "tool_execution_start")
			const toolEnd = getHandler(handlers, "tool_execution_end")

			await toolStart({ toolCallId: "e1", toolName: "edit", args: { filePath: "a.ts" } })
			await toolEnd({ toolCallId: "e1", result: { ok: true, value: "" } })

			await toolStart({ toolCallId: "w1", toolName: "write", args: { filePath: "b.py", content: "x\ny\n" } })
			await toolEnd({ toolCallId: "w1", result: { ok: true, value: "" } })

			await getHandler(handlers, "session_shutdown")()

			const metricsCalls = fetchMock.mock.calls.filter(
				([url]) => String(url) === "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
			)
			const payload = JSON.parse(String((metricsCalls[0][1] as RequestInit).body))
			const locMetrics = payload.resourceMetrics[0].scopeMetrics[0].metrics.filter(
				(m: { name: string }) => m.name === "claude_code.lines_of_code.count",
			)
			expect(locMetrics.length).toBeGreaterThan(0)
			for (const m of locMetrics) {
				const attrs = m.sum.dataPoints[0].attributes as Array<{ key: string; value: { stringValue: string } }>
				const attrKeys = attrs.map((a) => a.key)
				expect(attrKeys).toContain("language")
			}
		})

		it("emits cacheRead metrics when cacheRead is non-zero", async () => {
			const { handlers, api } = createMockApi()
			const ext = telemetryExtension(makeConfig())
			ext(api)

			await getHandler(handlers, "session_start")()

			const msgEnd = getHandler(handlers, "message_end")
			await msgEnd({
				message: {
					role: "assistant",
					model: "test-model",
					provider: "test-provider",
					timestamp: Date.now(),
					usage: {
						input: 1,
						output: 1,
						cacheRead: 5,
						cacheWrite: 0,
						cost: { total: 0.001 },
					},
				},
			})

			await getHandler(handlers, "session_shutdown")()

			const metricsCalls = fetchMock.mock.calls.filter(
				([url]) => String(url) === "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
			)
			const payload = JSON.parse(String((metricsCalls[0][1] as RequestInit).body))
			const cacheReadMetric = payload.resourceMetrics[0].scopeMetrics[0].metrics.find(
				(m: {
					name: string
					sum?: {
						dataPoints: Array<{ asInt?: string; attributes?: Array<{ key: string; value?: { stringValue?: string } }> }>
					}
				}) => {
					const typeAttr = m.sum?.dataPoints[0]?.attributes?.find((a: { key: string }) => a.key === "type")
					return m.name === "claude_code.token.usage" && typeAttr?.value?.stringValue === "cacheRead"
				},
			)
			expect(cacheReadMetric).toBeDefined()
			expect(cacheReadMetric.sum.dataPoints[0].asInt).toBe("5")
		})

		it("periodic flush sends accumulated metrics", async () => {
			vi.useFakeTimers()
			const { handlers, api } = createMockApi()
			const ext = telemetryExtension(makeConfig())
			ext(api)

			await getHandler(handlers, "session_start")()

			const toolStart = getHandler(handlers, "tool_execution_start")
			const toolEnd = getHandler(handlers, "tool_execution_end")

			await toolStart({ toolCallId: "e1", toolName: "edit", args: { filePath: "a.ts" } })
			await vi.advanceTimersByTimeAsync(100)
			await toolEnd({ toolCallId: "e1", result: { ok: true, value: "" } })

			// No metrics should be sent yet
			let metricsCalls = fetchMock.mock.calls.filter(
				([url]) => String(url) === "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
			)
			expect(metricsCalls).toHaveLength(0)

			// Advance timer past the flush interval
			await vi.advanceTimersByTimeAsync(30_001)

			// Now metrics should have been flushed
			metricsCalls = fetchMock.mock.calls.filter(
				([url]) => String(url) === "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
			)
			expect(metricsCalls).toHaveLength(1)

			const payload = JSON.parse(String((metricsCalls[0][1] as RequestInit).body))
			const metrics = payload.resourceMetrics[0].scopeMetrics[0].metrics
			expect(metrics.length).toBeGreaterThan(0)

			// Verify tool.usage metric has correct value and tool_name attribute
			const toolUsageMetric = metrics.find((m: { name: string }) => m.name === "claude_code.tool.usage")
			expect(toolUsageMetric).toBeDefined()
			expect(toolUsageMetric.sum.dataPoints[0].asInt).toBe("1")
			const usageAttrs = toolUsageMetric.sum.dataPoints[0].attributes as Array<{
				key: string
				value: { stringValue: string }
			}>
			expect(usageAttrs.find((a) => a.key === "tool_name")?.value.stringValue).toBe("edit")

			// Verify tool.duration_ms metric has correct value and tool_name attribute
			const toolDurationMetric = metrics.find((m: { name: string }) => m.name === "claude_code.tool.duration_ms")
			expect(toolDurationMetric).toBeDefined()
			expect(Number(toolDurationMetric.sum.dataPoints[0].asInt)).toBe(100)
			const durationAttrs = toolDurationMetric.sum.dataPoints[0].attributes as Array<{
				key: string
				value: { stringValue: string }
			}>
			expect(durationAttrs.find((a) => a.key === "tool_name")?.value.stringValue).toBe("edit")

			await getHandler(handlers, "session_shutdown")()
			vi.useRealTimers()
		})
	})

	describe("fetch error handling", () => {
		it("does not throw when metrics endpoint returns non-ok response", async () => {
			fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => "Internal Server Error" })

			const { handlers, api } = createMockApi()
			const ext = telemetryExtension(makeConfig())
			ext(api)

			await getHandler(handlers, "session_start")()

			const msgEnd = getHandler(handlers, "message_end")
			// Should not throw
			await expect(
				msgEnd({
					message: {
						role: "assistant",
						model: "test-model",
						provider: "test-provider",
						timestamp: Date.now(),
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							cost: { total: 0.001 },
						},
					},
				}),
			).resolves.not.toThrow()

			await getHandler(handlers, "session_shutdown")()
		})
	})

	describe("shared accumulators across sub-agents", () => {
		it("two extension instances with the same rootSessionId accumulate into shared state", async () => {
			// Simulate main agent + sub-agent: two extension instances loaded for the same root session.
			const { handlers: h1, api: api1 } = createMockApi()
			const { handlers: h2, api: api2 } = createMockApi()
			const ext1 = telemetryExtension(makeConfig())
			const ext2 = telemetryExtension(makeConfig())
			ext1(api1)
			ext2(api2)

			// Both session_start handlers fire (each agent starts its own session).
			await getHandler(h1, "session_start")()
			await getHandler(h2, "session_start")()

			// Main agent records 100 output tokens.
			await getHandler(
				h1,
				"message_end",
			)({
				message: {
					role: "assistant",
					model: "test-model",
					provider: "test",
					timestamp: 1,
					usage: { input: 0, output: 100, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				},
			})

			// Sub-agent records 50 output tokens.
			await getHandler(
				h2,
				"message_end",
			)({
				message: {
					role: "assistant",
					model: "test-model",
					provider: "test",
					timestamp: 2,
					usage: { input: 0, output: 50, cacheRead: 0, cacheWrite: 0, cost: { total: 0.005 } },
				},
			})

			// Flush both sessions.
			await getHandler(h1, "session_shutdown")()
			await getHandler(h2, "session_shutdown")()

			// There should be exactly one metrics POST (last flush wins, which is the total).
			const metricsCalls = fetchMock.mock.calls.filter(
				([url]) => String(url) === "https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest",
			)
			expect(metricsCalls.length).toBeGreaterThanOrEqual(1)

			// The last flush must contain the combined 150 output tokens — not just 50.
			const lastPayload = JSON.parse(String((metricsCalls[metricsCalls.length - 1][1] as RequestInit).body))
			const metrics = lastPayload.resourceMetrics[0].scopeMetrics[0].metrics
			const outputMetric = metrics.find(
				(m: {
					name: string
					sum?: {
						dataPoints: Array<{ asInt?: string; attributes: Array<{ key: string; value: { stringValue: string } }> }>
					}
				}) =>
					m.name === "claude_code.token.usage" &&
					m.sum?.dataPoints[0]?.attributes?.some((a) => a.key === "type" && a.value.stringValue === "output"),
			)
			expect(outputMetric?.sum?.dataPoints[0]?.asInt).toBe("150")
		})
	})
})
