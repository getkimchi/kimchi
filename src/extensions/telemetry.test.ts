import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
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

	beforeEach(() => {
		fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => "" })
		// biome-ignore lint/suspicious/noExplicitAny: test-only fetch mock
		globalThis.fetch = fetchMock as any
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
			expect(metrics).toHaveLength(3)

			const names = metrics.map((m: { name: string }) => m.name)
			expect(names).toContain("claude_code.token.usage")
			expect(names).toContain("claude_code.cost.usage")
		})

		it("deduplicates duplicate assistant messages", async () => {
			const { handlers, api } = createMockApi()
			const ext = telemetryExtension(makeConfig())
			ext(api)

			await getHandler(handlers, "session_start")()

			const msgEnd = getHandler(handlers, "message_end")
			const ts = Date.now()
			await msgEnd({
				message: {
					role: "assistant",
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
			expect(metricsCalls.length).toBe(1)
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

		it("sends lines_of_code metric for edit tool", async () => {
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
			const locMetric = metrics.find((m: { name: string }) => m.name === "claude_code.lines_of_code.count")
			expect(locMetric).toBeDefined()
			// oldString had 1 line, newString has 2 lines → countLineChanges({ added: 2-1=1, removed: 0 })
			// So total = 1+0 = 1, not 3. The function returns full replacement, not diff.
			expect(locMetric.sum.dataPoints[0].asInt).toBe("1")
			expect(
				locMetric.sum.dataPoints[0].attributes.some(
					(a: { key: string; value: { stringValue: string } }) => a.key === "language",
				),
			).toBe(true)
		})

		it("sends lines_of_code metric for write tool", async () => {
			const { handlers, api } = createMockApi()
			const ext = telemetryExtension(makeConfig())
			ext(api)

			await getHandler(handlers, "session_start")()

			const toolStart = getHandler(handlers, "tool_execution_start")
			const toolEnd = getHandler(handlers, "tool_execution_end")

			toolStart({
				toolCallId: "tc1",
				toolName: "write",
				args: {
					filePath: "/tmp/hello.py",
					content: "line 1\nline 2\nline 3",
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
			// 3 lines in content
			expect(locMetric.sum.dataPoints[0].asInt).toBe("3")
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
	})
})
