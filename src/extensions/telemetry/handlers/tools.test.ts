import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TelemetryConfig } from "../../../config.js"
import { SessionContext, _resetSharedAccumulators } from "../session-context.js"
import { handleToolExecutionEnd, handleToolExecutionStart } from "./tools.js"

vi.mock("../../../api/me.js", () => ({
	getMe: vi.fn().mockResolvedValue({ id: "test-user", email: "test@example.com" }),
}))

function makeConfig(overrides: Partial<TelemetryConfig> = {}): TelemetryConfig {
	return {
		enabled: true,
		endpoint: "https://test.example.com/logs",
		metricsEndpoint: "https://test.example.com/metrics",
		headers: { Authorization: "Bearer test" },
		apiKey: "",
		...overrides,
	}
}

function parseLogEvents(
	fetchMock: ReturnType<typeof vi.fn>,
): Array<{ eventName: string; attrs: Record<string, string> }> {
	return fetchMock.mock.calls
		.filter((call: unknown[]) => String(call[0]).includes("/logs"))
		.flatMap((call: unknown[]) => {
			const opts = call[1] as { body: string }
			const body = JSON.parse(opts.body)
			return body.resourceLogs[0].scopeLogs[0].logRecords.map(
				(rec: { eventName: string; attributes: Array<{ key: string; value: { stringValue: string } }> }) => {
					const attrs = Object.fromEntries(rec.attributes.map((a) => [a.key, a.value.stringValue]))
					return { eventName: rec.eventName, attrs }
				},
			)
		})
}

describe("handlers/tools", () => {
	let originalFetch: typeof globalThis.fetch
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		originalFetch = globalThis.fetch
		fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			status: 200,
			text: vi.fn().mockResolvedValue(""),
		} as unknown as Response)
		globalThis.fetch = fetchMock
	})

	afterEach(() => {
		globalThis.fetch = originalFetch
		_resetSharedAccumulators()
		vi.restoreAllMocks()
	})

	// -----------------------------------------------------------------------
	// read tool
	// -----------------------------------------------------------------------

	describe("read tool", () => {
		it("emits tool_result and kimchi.file_read with language and file_hash", async () => {
			const ctx = new SessionContext(makeConfig(), "cli")
			ctx.currentModel = "claude-3-5-sonnet"
			const toolCallId = "tc-read-1"

			handleToolExecutionStart(ctx, { toolCallId, toolName: "read", args: { path: "/src/app.ts" } })
			handleToolExecutionEnd(ctx, { toolCallId, isError: false })

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			const toolResult = events.find((e) => e.eventName === "tool_result")
			expect(toolResult).toBeDefined()
			expect(toolResult?.attrs.tool_name).toBe("read")
			expect(toolResult?.attrs.success).toBe("true")
			expect(toolResult?.attrs.model).toBe("claude-3-5-sonnet")

			const fileRead = events.find((e) => e.eventName === "file_read")
			expect(fileRead).toBeDefined()
			expect(fileRead?.attrs.language).toBe("TypeScript")
			expect(fileRead?.attrs.file_hash).toMatch(/^[0-9a-f]{12}$/)
			expect(fileRead?.attrs.model).toBe("claude-3-5-sonnet")
			expect(fileRead?.attrs.source).toBe("cli")
		})

		it("does NOT emit kimchi.file_read when path is empty", async () => {
			const ctx = new SessionContext(makeConfig(), "cli")
			const toolCallId = "tc-read-2"

			handleToolExecutionStart(ctx, { toolCallId, toolName: "read", args: {} })
			handleToolExecutionEnd(ctx, { toolCallId, isError: false })

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			const fileRead = events.find((e) => e.eventName === "file_read")
			expect(fileRead).toBeUndefined()
		})
	})

	// -----------------------------------------------------------------------
	// write tool
	// -----------------------------------------------------------------------

	describe("write tool", () => {
		it("emits tool_result and kimchi.file_written with lines_added, language, file_hash", async () => {
			const ctx = new SessionContext(makeConfig(), "cli")
			const toolCallId = "tc-write-1"

			handleToolExecutionStart(ctx, {
				toolCallId,
				toolName: "write",
				args: { path: "/src/utils.py", content: "line1\nline2\nline3\n" },
			})
			handleToolExecutionEnd(ctx, { toolCallId, isError: false })

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			const toolResult = events.find((e) => e.eventName === "tool_result")
			expect(toolResult).toBeDefined()
			expect(toolResult?.attrs.tool_name).toBe("write")

			const fileWritten = events.find((e) => e.eventName === "file_written")
			expect(fileWritten).toBeDefined()
			expect(fileWritten?.attrs.language).toBe("Python")
			expect(fileWritten?.attrs.file_hash).toMatch(/^[0-9a-f]{12}$/)
			expect(fileWritten?.attrs.lines_added).toBe("3")
		})
	})

	// -----------------------------------------------------------------------
	// edit tool
	// -----------------------------------------------------------------------

	describe("edit tool", () => {
		it("emits tool_result and kimchi.file_edited with file_hash, language, lines_added, lines_deleted", async () => {
			const ctx = new SessionContext(makeConfig(), "cli")
			const toolCallId = "tc-edit-1"

			handleToolExecutionStart(ctx, {
				toolCallId,
				toolName: "edit",
				args: { path: "/src/main.go", edits: [{ oldText: "a\nb\nc", newText: "a\nx\ny\nz\nc" }] },
			})
			handleToolExecutionEnd(ctx, { toolCallId, isError: false })

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			const toolResult = events.find((e) => e.eventName === "tool_result")
			expect(toolResult).toBeDefined()
			expect(toolResult?.attrs.tool_name).toBe("edit")

			const fileEdited = events.find((e) => e.eventName === "file_edited")
			expect(fileEdited).toBeDefined()
			expect(fileEdited?.attrs.language).toBe("Go")
			expect(fileEdited?.attrs.file_hash).toMatch(/^[0-9a-f]{12}$/)
			expect(Number(fileEdited?.attrs.lines_added)).toBeGreaterThanOrEqual(0)
			expect(Number(fileEdited?.attrs.lines_deleted)).toBeGreaterThanOrEqual(0)
		})
	})

	// -----------------------------------------------------------------------
	// bash tool
	// -----------------------------------------------------------------------

	describe("bash tool", () => {
		it("emits tool_result and kimchi.command_executed", async () => {
			const ctx = new SessionContext(makeConfig(), "cli")
			const toolCallId = "tc-bash-1"

			handleToolExecutionStart(ctx, { toolCallId, toolName: "bash", args: { command: "ls -la" } })
			handleToolExecutionEnd(ctx, { toolCallId, isError: false })

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			const toolResult = events.find((e) => e.eventName === "tool_result")
			expect(toolResult).toBeDefined()
			expect(toolResult?.attrs.tool_name).toBe("bash")
			expect(toolResult?.attrs.success).toBe("true")

			const cmdExec = events.find((e) => e.eventName === "command_executed")
			expect(cmdExec).toBeDefined()
			expect(cmdExec?.attrs.command_type).toBe("bash")
			expect(cmdExec?.attrs.exit_code).toBe("0")
		})

		it("emits kimchi.error on tool failure", async () => {
			const ctx = new SessionContext(makeConfig(), "cli")
			const toolCallId = "tc-bash-err"

			handleToolExecutionStart(ctx, { toolCallId, toolName: "bash", args: { command: "false" } })
			handleToolExecutionEnd(ctx, {
				toolCallId,
				isError: true,
				result: { content: [{ type: "text", text: "command failed with exit code 1" }] },
			})

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			const toolResult = events.find((e) => e.eventName === "tool_result")
			expect(toolResult).toBeDefined()
			expect(toolResult?.attrs.success).toBe("false")

			const cmdExec = events.find((e) => e.eventName === "command_executed")
			expect(cmdExec).toBeDefined()
			expect(cmdExec?.attrs.exit_code).toBe("1")

			const error = events.find((e) => e.eventName === "error")
			expect(error).toBeDefined()
			expect(error?.attrs.error_type).toBe("tool_failure")
			expect(error?.attrs.error_message).toBe("command failed with exit code 1")
			expect(error?.attrs.model).toBe("unknown")
		})
	})

	// -----------------------------------------------------------------------
	// cumulative metrics
	// -----------------------------------------------------------------------

	describe("cumulative metrics", () => {
		it("accumulates commit count for bash git commit", () => {
			const ctx = new SessionContext(makeConfig(), "cli")
			const toolCallId = "tc-commit"

			handleToolExecutionStart(ctx, {
				toolCallId,
				toolName: "bash",
				args: { command: 'git commit -m "test"' },
			})
			handleToolExecutionEnd(ctx, { toolCallId, isError: false })

			expect(ctx.cumulative.commitCount).toBe(1)
		})

		it("accumulates LOC for edit tool", () => {
			const ctx = new SessionContext(makeConfig(), "cli")
			const toolCallId = "tc-edit-loc"

			handleToolExecutionStart(ctx, {
				toolCallId,
				toolName: "edit",
				args: { path: "/src/app.ts", edits: [{ oldText: "a", newText: "a\nb\nc" }] },
			})
			handleToolExecutionEnd(ctx, { toolCallId, isError: false })

			expect(ctx.cumulative.locByLanguage.TypeScript).toBeDefined()
			expect(ctx.cumulative.locByLanguage.TypeScript.added).toBeGreaterThan(0)
		})
	})

	// -----------------------------------------------------------------------
	// tool usage & duration tracking
	// -----------------------------------------------------------------------

	describe("tool usage & duration tracking", () => {
		it("accumulates tool usage count for each tool call", () => {
			const ctx = new SessionContext(makeConfig(), "cli")

			handleToolExecutionStart(ctx, { toolCallId: "b1", toolName: "bash", args: { command: "ls" } })
			handleToolExecutionEnd(ctx, { toolCallId: "b1", isError: false })
			handleToolExecutionStart(ctx, { toolCallId: "b2", toolName: "bash", args: { command: "pwd" } })
			handleToolExecutionEnd(ctx, { toolCallId: "b2", isError: false })
			handleToolExecutionStart(ctx, { toolCallId: "e1", toolName: "edit", args: { path: "a.ts" } })
			handleToolExecutionEnd(ctx, { toolCallId: "e1", isError: false })

			expect(ctx.cumulative.toolUsage.bash).toBe(2)
			expect(ctx.cumulative.toolUsage.edit).toBe(1)
		})

		it("records tool start times and cleans them up on end", () => {
			const ctx = new SessionContext(makeConfig(), "cli")

			handleToolExecutionStart(ctx, { toolCallId: "b1", toolName: "bash", args: { command: "ls" } })
			expect(ctx.toolStartTimes.has("b1")).toBe(true)

			handleToolExecutionEnd(ctx, { toolCallId: "b1", isError: false })
			expect(ctx.toolStartTimes.has("b1")).toBe(false)
		})
	})

	// -----------------------------------------------------------------------
	// edge cases
	// -----------------------------------------------------------------------

	describe("edge cases", () => {
		it("ignores toolCallId not found in pendingArgs", async () => {
			const ctx = new SessionContext(makeConfig(), "cli")
			// No start call, just end — should not throw
			handleToolExecutionEnd(ctx, { toolCallId: "unknown-id", isError: false })

			await Promise.allSettled([...ctx.inFlight])
			expect(fetchMock).not.toHaveBeenCalled()
		})
	})
})
