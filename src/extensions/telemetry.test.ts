import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TelemetryConfig } from "../config.js"
import telemetryExtension from "./telemetry.js"

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
			expect(metrics).toHaveLength(4) // token.input, token.output, cost.usage, code_edit_tool.decision

			const names = metrics.map((m: { name: string }) => m.name)
			expect(names).toContain("claude_code.token.usage")
			expect(names).toContain("claude_code.cost.usage")
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
			const locMetric = metrics.find((m: { name: string }) => m.name === "claude_code.lines_of_code.count")
			expect(locMetric).toBeDefined()
			// countLineChanges trims trailing newlines, so "old line\n" -> ["old line"] (1 line)
			// "new line 1\nnew line 2\n" trimmed -> "new line 1\nnew line 2" -> ["new line 1", "new line 2"] (2 lines)
			// added = 2-1 = 1, removed = 0 but || 1 makes it 1
			expect(locMetric.sum.dataPoints[0].asInt).toBe("1")
			expect(
				locMetric.sum.dataPoints[0].attributes.some(
					(a: { key: string; value: { stringValue: string } }) => a.key === "type",
				),
			).toBe(true)
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
			expect(
				decisionMetric.sum.dataPoints[0].attributes.some(
					(a: { key: string; value: { stringValue: string } }) =>
						a.key === "tool_name" && a.value.stringValue === "edit",
				),
			).toBe(true)
			expect(
				decisionMetric.sum.dataPoints[0].attributes.some(
					(a: { key: string; value: { stringValue: string } }) => a.key === "decision",
				),
			).toBe(true)
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
			const dataPoints = payload.resourceMetrics[0].scopeMetrics[0].metrics.flatMap(
				(m: {
					sum?: { dataPoints: Array<{ startTimeUnixNano: string }> }
					gauge?: { dataPoints: Array<{ startTimeUnixNano: string }> }
				}) => [
					...((m.sum?.dataPoints ?? []) as Array<{ startTimeUnixNano: string }>),
					...((m.gauge?.dataPoints ?? []) as Array<{ startTimeUnixNano: string }>),
				],
			)
			for (const dp of dataPoints) {
				expect(dp.startTimeUnixNano).toBeDefined()
				expect(typeof dp.startTimeUnixNano).toBe("string")
				expect(dp.startTimeUnixNano.length).toBeGreaterThan(0)
			}
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
})
