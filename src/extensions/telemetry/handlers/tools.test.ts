import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TelemetryConfig } from "../../../config.js"
import { createContext } from "../../__mocks__/context.js"
import { _resetSharedAccumulators, TelemetryContext } from "../session-context.js"
import { handleToolExecutionEnd, handleToolExecutionStart, resultSizeChars } from "./tools.js"

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
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			// model set via createContext above
			const toolCallId = "tc-read-1"

			handleToolExecutionStart(ctx, { toolCallId, toolName: "read", args: { path: "/src/app.ts" } })
			handleToolExecutionEnd(ctx, piCtx, { toolCallId, isError: false })

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
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const toolCallId = "tc-read-2"

			handleToolExecutionStart(ctx, { toolCallId, toolName: "read", args: {} })
			handleToolExecutionEnd(ctx, piCtx, { toolCallId, isError: false })

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
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const toolCallId = "tc-write-1"

			handleToolExecutionStart(ctx, {
				toolCallId,
				toolName: "write",
				args: { path: "/src/utils.py", content: "line1\nline2\nline3\n" },
			})
			handleToolExecutionEnd(ctx, piCtx, { toolCallId, isError: false })

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
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const toolCallId = "tc-edit-1"

			handleToolExecutionStart(ctx, {
				toolCallId,
				toolName: "edit",
				args: { path: "/src/main.go", edits: [{ oldText: "a\nb\nc", newText: "a\nx\ny\nz\nc" }] },
			})
			handleToolExecutionEnd(ctx, piCtx, { toolCallId, isError: false })

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
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const toolCallId = "tc-bash-1"

			handleToolExecutionStart(ctx, { toolCallId, toolName: "bash", args: { command: "ls -la" } })
			handleToolExecutionEnd(ctx, piCtx, { toolCallId, isError: false })

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
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const toolCallId = "tc-bash-err"

			handleToolExecutionStart(ctx, { toolCallId, toolName: "bash", args: { command: "false" } })
			handleToolExecutionEnd(ctx, piCtx, {
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
			expect(error?.attrs.model).toBe("claude-3-5-sonnet")
		})
	})

	// -----------------------------------------------------------------------
	// cumulative metrics
	// -----------------------------------------------------------------------

	describe("cumulative metrics", () => {
		it("accumulates commit count for bash git commit", () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const toolCallId = "tc-commit"

			handleToolExecutionStart(ctx, {
				toolCallId,
				toolName: "bash",
				args: { command: 'git commit -m "test"' },
			})
			handleToolExecutionEnd(ctx, piCtx, { toolCallId, isError: false })

			expect(ctx.cumulative.commitCount).toBe(1)
		})

		it("accumulates LOC for edit tool", () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const toolCallId = "tc-edit-loc"

			handleToolExecutionStart(ctx, {
				toolCallId,
				toolName: "edit",
				args: { path: "/src/app.ts", edits: [{ oldText: "a", newText: "a\nb\nc" }] },
			})
			handleToolExecutionEnd(ctx, piCtx, { toolCallId, isError: false })

			expect(ctx.cumulative.locByLanguage.TypeScript).toBeDefined()
			expect(ctx.cumulative.locByLanguage.TypeScript.added).toBeGreaterThan(0)
		})
	})

	// -----------------------------------------------------------------------
	// tool usage & duration tracking
	// -----------------------------------------------------------------------

	describe("tool usage & duration tracking", () => {
		it("accumulates tool usage count for each tool call", () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())

			handleToolExecutionStart(ctx, { toolCallId: "b1", toolName: "bash", args: { command: "ls" } })
			handleToolExecutionEnd(ctx, piCtx, { toolCallId: "b1", isError: false })
			handleToolExecutionStart(ctx, { toolCallId: "b2", toolName: "bash", args: { command: "pwd" } })
			handleToolExecutionEnd(ctx, piCtx, { toolCallId: "b2", isError: false })
			handleToolExecutionStart(ctx, { toolCallId: "e1", toolName: "edit", args: { path: "a.ts" } })
			handleToolExecutionEnd(ctx, piCtx, { toolCallId: "e1", isError: false })

			expect(ctx.cumulative.toolUsage.bash).toBe(2)
			expect(ctx.cumulative.toolUsage.edit).toBe(1)
		})

		it("records tool start times and cleans them up on end", () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())

			handleToolExecutionStart(ctx, { toolCallId: "b1", toolName: "bash", args: { command: "ls" } })
			expect(ctx.toolStartTimes.has("b1")).toBe(true)

			handleToolExecutionEnd(ctx, piCtx, { toolCallId: "b1", isError: false })
			expect(ctx.toolStartTimes.has("b1")).toBe(false)
		})
	})

	// -----------------------------------------------------------------------
	// resultSizeChars
	// -----------------------------------------------------------------------

	describe("resultSizeChars", () => {
		it("returns 0 for null result", () => {
			expect(resultSizeChars(null)).toBe(0)
		})

		it("returns 0 for result with empty content array", () => {
			expect(resultSizeChars({ content: [] })).toBe(0)
		})

		it("sums text lengths from all content blocks", () => {
			expect(resultSizeChars({ content: [{ text: "hello" }, { text: " world" }] })).toBe(11)
		})

		it("ignores content blocks without text property", () => {
			expect(resultSizeChars({ content: [{ text: "hi" }, { other: "field" }] })).toBe(2)
		})
	})

	// -----------------------------------------------------------------------
	// tool result size attrs
	// -----------------------------------------------------------------------

	describe("tool result size attrs", () => {
		it("emits file_size_chars and read_is_truncated=false when no limit is set", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			// model set via createContext above
			const toolCallId = "tc-read-size"

			// No limit arg — full file returned, not truncated
			handleToolExecutionStart(ctx, { toolCallId, toolName: "read", args: { path: "/src/app.ts" } })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId,
				isError: false,
				result: { content: [{ text: "file contents here" }] },
			})

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			const fileRead = events.find((e) => e.eventName === "file_read")
			expect(fileRead?.attrs.file_size_chars).toBe(String("file contents here".length))
			expect(fileRead?.attrs.read_is_truncated).toBe("false")
		})

		it("emits read_is_truncated=true when a limit arg is set", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			// model set via createContext above
			const toolCallId = "tc-read-limited"

			// limit arg present — caller capped the lines, result may be truncated
			handleToolExecutionStart(ctx, { toolCallId, toolName: "read", args: { path: "/src/app.ts", limit: 50 } })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId,
				isError: false,
				result: { content: [{ text: "file contents here" }] },
			})

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			const fileRead = events.find((e) => e.eventName === "file_read")
			expect(fileRead?.attrs.read_is_truncated).toBe("true")
		})

		it("emits bash_output_size_chars on command_executed", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const toolCallId = "tc-bash-size"

			handleToolExecutionStart(ctx, { toolCallId, toolName: "bash", args: { command: "ls" } })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId,
				isError: false,
				result: { content: [{ text: "file1.txt\nfile2.txt\n" }] },
			})

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			const cmdExec = events.find((e) => e.eventName === "command_executed")
			expect(cmdExec?.attrs.bash_output_size_chars).toBe(String("file1.txt\nfile2.txt\n".length))
		})

		it("emits tool_result_size_chars on tool_result", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const toolCallId = "tc-read-size-tr"

			handleToolExecutionStart(ctx, { toolCallId, toolName: "read", args: { path: "/src/app.ts" } })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId,
				isError: false,
				result: { content: [{ text: "hello world" }] },
			})

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			const toolResult = events.find((e) => e.eventName === "tool_result")
			expect(toolResult?.attrs.tool_result_size_chars).toBe(String("hello world".length))
		})
	})

	// -----------------------------------------------------------------------
	// edge cases
	// -----------------------------------------------------------------------

	describe("edge cases", () => {
		it("ignores toolCallId not found in pendingArgs", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			// No start call, just end — should not throw
			handleToolExecutionEnd(ctx, piCtx, { toolCallId: "unknown-id", isError: false })

			await Promise.allSettled([...ctx.inFlight])
			expect(fetchMock).not.toHaveBeenCalled()
		})
	})
})
