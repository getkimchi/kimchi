import { readFile } from "node:fs/promises"
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest"
import type { TelemetryConfig } from "../../../config.js"
import { createContext } from "../../__mocks__/context.js"
import { _resetSharedAccumulators, TelemetryContext } from "../session-context.js"
import {
	CODEMODE_TRUNCATION_WARNING,
	handleToolExecutionEnd,
	handleToolExecutionStart,
	resultSizeChars,
} from "./tools.js"

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
	let fetchMock: Mock

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
			expect(cmdExec?.attrs.command_outcome).toBe("success")
			expect(cmdExec?.attrs.exit_code).toBe("0")
			expect(cmdExec?.attrs.canonicalization).toBe("v1")
		})

		it("records a non-zero exit as a command outcome, not an error", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const toolCallId = "tc-bash-exit-2"

			handleToolExecutionStart(ctx, { toolCallId, toolName: "bash", args: { command: "false" } })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId,
				isError: true,
				result: { content: [{ type: "text", text: "usage error\n\nCommand exited with code 2" }] },
			})

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			// An ordinary non-zero exit is an execution result: exactly one
			// command record with the real code, no error, no extra outcome.
			const cmdExecs = events.filter((e) => e.eventName === "command_executed")
			expect(cmdExecs).toHaveLength(1)
			expect(cmdExecs[0].attrs.command_outcome).toBe("nonzero_exit")
			expect(cmdExecs[0].attrs.exit_code).toBe("2")
			expect(cmdExecs[0].attrs.tool_use_id).toBe(toolCallId)
			expect(events.find((e) => e.eventName === "error")).toBeUndefined()
			expect(events.find((e) => e.eventName === "tool_outcome")).toBeUndefined()
		})

		it("records exit codes 22 and 127 without fabricating or dropping them", async () => {
			for (const code of [22, 127]) {
				const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
				const ctx = new TelemetryContext(makeConfig())
				const toolCallId = `tc-bash-exit-${code}`

				handleToolExecutionStart(ctx, { toolCallId, toolName: "bash", args: { command: "curl" } })
				handleToolExecutionEnd(ctx, piCtx, {
					toolCallId,
					isError: true,
					result: { content: [{ type: "text", text: `Command exited with code ${code}` }] },
				})

				ctx.flushLogBuffer()
				await Promise.allSettled([...ctx.inFlight])
				// fetchMock accumulates across loop iterations — select this call's record.
				const events = parseLogEvents(fetchMock).filter((e) => e.attrs.tool_use_id === toolCallId)
				const cmdExec = events.find((e) => e.eventName === "command_executed")
				expect(cmdExec?.attrs.exit_code).toBe(String(code))
				expect(cmdExec?.attrs.command_outcome).toBe("nonzero_exit")
				expect(events.find((e) => e.eventName === "error")).toBeUndefined()
			}
		})

		it("records a timeout with timeout_seconds and no fabricated exit code", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const toolCallId = "tc-bash-timeout"

			handleToolExecutionStart(ctx, { toolCallId, toolName: "bash", args: { command: "sleep 5", timeout: 1 } })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId,
				isError: true,
				result: { content: [{ type: "text", text: "Command timed out after 1 seconds" }] },
			})

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			const cmdExec = events.find((e) => e.eventName === "command_executed")
			expect(cmdExec?.attrs.command_outcome).toBe("timeout")
			expect(cmdExec?.attrs.timeout_seconds).toBe("1")
			expect(cmdExec?.attrs.exit_code).toBeUndefined()
			// A model-requested timeout is an execution outcome, not an anomaly.
			expect(events.find((e) => e.eventName === "error")).toBeUndefined()
		})

		it("records a fractional timeout with its real value and no fabricated exit code", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const toolCallId = "tc-bash-frac-timeout"

			handleToolExecutionStart(ctx, { toolCallId, toolName: "bash", args: { command: "sleep 1", timeout: 0.5 } })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId,
				isError: true,
				// Upstream reports the timeout value raw — fractional included.
				result: { content: [{ type: "text", text: "Command timed out after 0.5 seconds" }] },
			})

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			const cmdExec = events.find((e) => e.eventName === "command_executed")
			expect(cmdExec?.attrs.command_outcome).toBe("timeout")
			expect(cmdExec?.attrs.timeout_seconds).toBe("0.5")
			expect(cmdExec?.attrs.exit_code).toBeUndefined()
			expect(events.find((e) => e.eventName === "error")).toBeUndefined()
		})

		it("stamps the request trace context on command_executed for successful and failed commands", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			ctx.lastTraceContext = { traceId: "aaaabbbbccccddddeeeeffff00001111", spanId: "1122334455667788" }

			handleToolExecutionStart(ctx, { toolCallId: "tc-cmd-trace-ok", toolName: "bash", args: { command: "true" } })
			handleToolExecutionEnd(ctx, piCtx, { toolCallId: "tc-cmd-trace-ok", isError: false })

			handleToolExecutionStart(ctx, { toolCallId: "tc-cmd-trace-fail", toolName: "bash", args: { command: "false" } })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId: "tc-cmd-trace-fail",
				isError: true,
				result: { content: [{ type: "text", text: "Command exited with code 1" }] },
			})

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const commands = parseLogEvents(fetchMock).filter(
				(e) => e.eventName === "command_executed" && (e.attrs.tool_use_id ?? "").startsWith("tc-cmd-trace"),
			)

			const ok = commands.find((e) => e.attrs.tool_use_id === "tc-cmd-trace-ok")
			expect(ok?.attrs.command_outcome).toBe("success")
			expect(ok?.attrs["request.trace_id"]).toBe("aaaabbbbccccddddeeeeffff00001111")
			expect(ok?.attrs["request.span_id"]).toBe("1122334455667788")

			// Ordinary non-zero exits no longer emit an error record — the
			// command record is their only link to the provider request trace.
			const failed = commands.find((e) => e.attrs.tool_use_id === "tc-cmd-trace-fail")
			expect(failed?.attrs.command_outcome).toBe("nonzero_exit")
			expect(failed?.attrs["request.trace_id"]).toBe("aaaabbbbccccddddeeeeffff00001111")
			expect(failed?.attrs["request.span_id"]).toBe("1122334455667788")
		})

		it("emits kimchi.error for an unrecognized bash failure (fail-open fallback)", async () => {
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

			// Unknown bash error: conservative execution_error record with no
			// fabricated exit code, plus the raw-slice error event (today's behavior).
			const cmdExec = events.find((e) => e.eventName === "command_executed")
			expect(cmdExec).toBeDefined()
			expect(cmdExec?.attrs.command_outcome).toBe("execution_error")
			expect(cmdExec?.attrs.exit_code).toBeUndefined()

			const error = events.find((e) => e.eventName === "error")
			expect(error).toBeDefined()
			expect(error?.attrs.error_type).toBe("tool_failure")
			expect(error?.attrs.error_message).toBe("command failed with exit code 1")
			expect(error?.attrs.model).toBe("claude-3-5-sonnet")
			expect(error?.attrs.canonicalization).toBe("v1")
		})

		it("stamps the request trace context on tool_failure error events", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			ctx.lastTraceContext = { traceId: "aaaabbbbccccddddeeeeffff00001111", spanId: "1122334455667788" }
			const toolCallId = "tc-bash-err-trace"

			handleToolExecutionStart(ctx, { toolCallId, toolName: "bash", args: { command: "false" } })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId,
				isError: true,
				result: { content: [{ type: "text", text: "command failed with exit code 1" }] },
			})

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			const error = events.find((e) => e.eventName === "error")
			expect(error).toBeDefined()
			expect(error?.attrs.error_type).toBe("tool_failure")
			expect(error?.attrs["request.trace_id"]).toBe("aaaabbbbccccddddeeeeffff00001111")
			expect(error?.attrs["request.span_id"]).toBe("1122334455667788")
		})

		it("suppresses the error record for a clamp-killed bash timeout (lifecycle, not a failure)", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const toolCallId = "tc-bash-clamped"
			// The clamp channel handler records the id before the tool executes.
			ctx.clampedBashCalls.add(toolCallId)

			// The clamp appends its budget note AFTER the terminal status (an extra
			// text block), so this is the text telemetry actually receives.
			handleToolExecutionStart(ctx, { toolCallId, toolName: "bash", args: { command: "sleep 5" } })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId,
				isError: true,
				result: {
					content: [
						{ type: "text", text: "Command timed out after 1 seconds" },
						{
							type: "text",
							text: "You have reached your wall-clock time budget. The command above was killed by the harness time limit — not because the command was slow. Run only commands that finish within a second (commit your work, write out results) or reply with your final summary now. Do not retry commands.",
						},
					],
				},
			})

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			// The run is still recorded as a measurement (a timeout outcome with
			// no fabricated exit code)…
			const toolResult = events.find((e) => e.eventName === "tool_result")
			expect(toolResult).toBeDefined()
			expect(toolResult?.attrs.success).toBe("false")
			const cmdExec = events.find((e) => e.eventName === "command_executed")
			expect(cmdExec).toBeDefined()
			expect(cmdExec?.attrs.command_outcome).toBe("timeout")
			expect(cmdExec?.attrs.timeout_seconds).toBe("1")
			expect(cmdExec?.attrs.exit_code).toBeUndefined()
			// …but not as an error — subagent.bash_clamped already reports the clamp.
			expect(events.find((e) => e.eventName === "error")).toBeUndefined()
			// The clamp marker is released with the call.
			expect(ctx.clampedBashCalls.size).toBe(0)
		})

		it("suppresses the error record for a clamp-killed timeout with verbose output (status line beyond the 300-char truncation)", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const toolCallId = "tc-bash-clamped-verbose"
			ctx.clampedBashCalls.add(toolCallId)

			// Upstream appends the timeout status AFTER the command output; a
			// verbose command pushes it past the 300-char telemetry truncation,
			// and the clamp appends its budget note after the status. The match
			// must run against the full text, not the truncated message, or this
			// emits a spurious tool_failure.
			const verboseOutput = "x".repeat(400)
			handleToolExecutionStart(ctx, { toolCallId, toolName: "bash", args: { command: "verbose" } })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId,
				isError: true,
				result: {
					content: [
						{ type: "text", text: `${verboseOutput}\n\nCommand timed out after 1 seconds` },
						{
							type: "text",
							text: "You are close to your wall-clock time budget — roughly 30s remain. Commands that take longer will be killed. Finish the change in progress or summarize your progress for the orchestrator now.",
						},
					],
				},
			})

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			expect(events.find((e) => e.eventName === "error")).toBeUndefined()
			const cmdExec = events.find((e) => e.eventName === "command_executed")
			expect(cmdExec?.attrs.command_outcome).toBe("timeout")
		})

		it("still emits the error record for a non-timeout failure on a clamped call", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const toolCallId = "tc-bash-clamped-exit"
			ctx.clampedBashCalls.add(toolCallId)

			handleToolExecutionStart(ctx, { toolCallId, toolName: "bash", args: { command: "false" } })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId,
				isError: true,
				result: { content: [{ type: "text", text: "command failed with exit code 1" }] },
			})

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			const error = events.find((e) => e.eventName === "error")
			expect(error).toBeDefined()
			expect(error?.attrs.error_type).toBe("tool_failure")
		})

		it("records a model-requested (unclamped) timeout as an outcome without an error record", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const toolCallId = "tc-bash-model-timeout"

			handleToolExecutionStart(ctx, { toolCallId, toolName: "bash", args: { command: "sleep 5", timeout: 1 } })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId,
				isError: true,
				result: { content: [{ type: "text", text: "Command timed out after 1 seconds" }] },
			})

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			// Timeouts are execution outcomes, not harness anomalies — with or
			// without a clamp marker.
			const cmdExec = events.find((e) => e.eventName === "command_executed")
			expect(cmdExec?.attrs.command_outcome).toBe("timeout")
			expect(events.find((e) => e.eventName === "error")).toBeUndefined()
		})
	})

	// -----------------------------------------------------------------------
	// error taxonomy (tool_outcome vs error vs command_executed)
	// -----------------------------------------------------------------------

	describe("error taxonomy", () => {
		it("emits tool_outcome (not error, not command_executed) for a pre-execution gate", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const toolCallId = "tc-bash-plan-gate"

			handleToolExecutionStart(ctx, { toolCallId, toolName: "bash", args: { command: "rm -rf /" } })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId,
				isError: true,
				result: {
					content: [
						{
							type: "text",
							text: "Blocked: the session is in plan mode (read-only). Do not retry writes — present the plan to the user.",
						},
					],
				},
			})

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			const outcome = events.find((e) => e.eventName === "tool_outcome")
			expect(outcome).toBeDefined()
			expect(outcome?.attrs.outcome_kind).toBe("blocked")
			expect(outcome?.attrs.message).toBe("Plan mode gate")
			expect(outcome?.attrs.tool_name).toBe("bash")
			expect(outcome?.attrs.tool_use_id).toBe(toolCallId)
			expect(outcome?.attrs.canonicalization).toBe("v1")
			expect(events.find((e) => e.eventName === "error")).toBeUndefined()
			// Never ran — no misleading execution record.
			expect(events.find((e) => e.eventName === "command_executed")).toBeUndefined()
		})

		it("emits tool_outcome for a todo check-in gate with the revision attribute", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const toolCallId = "tc-todo-gate"

			handleToolExecutionStart(ctx, { toolCallId, toolName: "edit", args: { path: "/a.ts" } })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId,
				isError: true,
				result: {
					content: [
						{
							type: "text",
							text: "⏸ Todo check-in pending (input revision 3). Reconcile the todo list with the user's latest direction.",
						},
					],
				},
			})

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			const outcome = events.find((e) => e.eventName === "tool_outcome")
			expect(outcome?.attrs.outcome_kind).toBe("blocked")
			expect(outcome?.attrs.message).toBe("Todo check-in gate")
			expect(outcome?.attrs.revision).toBe("3")
			expect(events.find((e) => e.eventName === "error")).toBeUndefined()
		})

		it("emits tool_outcome for a user decline, dropping the free-text reason", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const toolCallId = "tc-decline"

			handleToolExecutionStart(ctx, { toolCallId, toolName: "bash", args: { command: "deploy" } })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId,
				isError: true,
				result: {
					content: [
						{ type: "text", text: "The user declined this action before execution and said: use staging instead" },
					],
				},
			})

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			const outcome = events.find((e) => e.eventName === "tool_outcome")
			expect(outcome?.attrs.outcome_kind).toBe("declined")
			expect(outcome?.attrs.message).toBe("User declined with reason")
			expect(events.find((e) => e.eventName === "error")).toBeUndefined()
			expect(events.find((e) => e.eventName === "command_executed")).toBeUndefined()
			// The free-text reason must not survive anywhere on the record.
			expect(JSON.stringify(events)).not.toContain("use staging instead")
		})

		it("emits tool_outcome for a recognized model mistake (edit oldText mismatch) with hashed path", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const toolCallId = "tc-edit-miss"

			handleToolExecutionStart(ctx, { toolCallId, toolName: "edit", args: { path: "/Users/me/secret.ts" } })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId,
				isError: true,
				result: {
					content: [
						{
							type: "text",
							text: "Could not find the exact text in /Users/me/secret.ts. The old text must match exactly including all whitespace and newlines.",
						},
					],
				},
			})

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			const outcome = events.find((e) => e.eventName === "tool_outcome")
			expect(outcome?.attrs.outcome_kind).toBe("model_mistake")
			expect(outcome?.attrs.message).toBe("Edit oldText not found")
			expect(outcome?.attrs.file_hash).toMatch(/^[0-9a-f]{12}$/)
			expect(events.find((e) => e.eventName === "error")).toBeUndefined()
			expect(JSON.stringify(events)).not.toContain("/Users/me/secret.ts")
		})

		it("emits tool_outcome for a classifier fail-closed block with a bounded failure code", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const toolCallId = "tc-classifier"

			handleToolExecutionStart(ctx, { toolCallId, toolName: "write", args: { path: "/a.ts" } })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId,
				isError: true,
				result: {
					content: [
						{
							type: "text",
							text: "Classifier: classifier error: minimax-m3 model is rate limited until 2026-10-29T23:55:00Z (model=minimax-m3 tool=write) (no UI to confirm)",
						},
					],
				},
			})

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			const outcome = events.find((e) => e.eventName === "tool_outcome")
			expect(outcome?.attrs.outcome_kind).toBe("blocked")
			expect(outcome?.attrs.message).toBe("Classifier unavailable — fail closed")
			expect(outcome?.attrs.failure_code).toBe("rate_limited")
			expect(outcome?.attrs.classifier_model).toBe("minimax-m3")
			expect(events.find((e) => e.eventName === "error")).toBeUndefined()
			// The rate-limit window timestamp must not survive.
			expect(JSON.stringify(events)).not.toContain("2026-10-29")
		})

		it("emits neither error nor tool_outcome for an aborted tool result", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const toolCallId = "tc-abort"

			handleToolExecutionStart(ctx, { toolCallId, toolName: "bash", args: { command: "sleep 60" } })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId,
				isError: true,
				result: { content: [{ type: "text", text: "Command aborted" }] },
			})

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			expect(events.find((e) => e.eventName === "error")).toBeUndefined()
			expect(events.find((e) => e.eventName === "tool_outcome")).toBeUndefined()
			// The bash command metrics still carry the abort outcome.
			const cmdExec = events.find((e) => e.eventName === "command_executed")
			expect(cmdExec?.attrs.command_outcome).toBe("aborted")
			expect(cmdExec?.attrs.exit_code).toBeUndefined()
		})

		it("emits a canonical error for a mode-flap failure (operational, stays in the funnel)", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const toolCallId = "tc-mode-flap"

			handleToolExecutionStart(ctx, { toolCallId, toolName: "write", args: { path: "/a.ts" } })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId,
				isError: true,
				result: { content: [{ type: "text", text: "Permission mode changed too many times during prompt" }] },
			})

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			const error = events.find((e) => e.eventName === "error")
			expect(error).toBeDefined()
			expect(error?.attrs.error_message).toBe("Permission mode flap")
			expect(error?.attrs.tool_use_id).toBe(toolCallId)
			expect(events.find((e) => e.eventName === "tool_outcome")).toBeUndefined()
		})

		it("carries the routed model on command and outcome records under backend routing", async () => {
			const piCtx = createContext({ model: { id: "auto" } })
			const ctx = new TelemetryContext(makeConfig())
			ctx.lastRoutedModel = "kimchi/glm-4.7"
			const toolCallId = "tc-routed-outcome"

			handleToolExecutionStart(ctx, { toolCallId, toolName: "bash", args: { command: "true" } })
			handleToolExecutionEnd(ctx, piCtx, { toolCallId, isError: false })

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			const cmdExec = events.find((e) => e.eventName === "command_executed")
			expect(cmdExec?.attrs.routed_model).toBe("kimchi/glm-4.7")

			// After the session leaves backend routing (message_end clears the
			// slot), later records must not attribute to the stale backend.
			ctx.lastRoutedModel = undefined
			const laterId = "tc-unrouted-outcome"
			handleToolExecutionStart(ctx, { toolCallId: laterId, toolName: "bash", args: { command: "true" } })
			handleToolExecutionEnd(ctx, piCtx, { toolCallId: laterId, isError: false })

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const later = parseLogEvents(fetchMock).find(
				(e) => e.eventName === "command_executed" && e.attrs.tool_use_id === laterId,
			)
			expect(later?.attrs.routed_model).toBeUndefined()
		})

		it("emits the empty-message fallback for an error with no text blocks", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const toolCallId = "tc-empty-error"

			handleToolExecutionStart(ctx, { toolCallId, toolName: "bash", args: { command: "false" } })
			handleToolExecutionEnd(ctx, piCtx, { toolCallId, isError: true, result: { content: [] } })

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			const error = events.find((e) => e.eventName === "error")
			expect(error).toBeDefined()
			expect(error?.attrs.error_message).toBe("unknown tool error")
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
	// nested-call attribution (codemode-driven calls)
	// -----------------------------------------------------------------------

	describe("nested-call attribution", () => {
		it("marks a nested read with nested=true and parent_tool_use_id", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const toolCallId = "cm-1/1"

			handleToolExecutionStart(ctx, { toolCallId, toolName: "read", args: { path: "/src/app.ts" } })
			handleToolExecutionEnd(ctx, piCtx, { toolCallId, isError: false, parentToolCallId: "cm-1" })

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			const toolResult = events.find((e) => e.eventName === "tool_result")
			expect(toolResult?.attrs.tool_name).toBe("read")
			expect(toolResult?.attrs.nested).toBe("true")
			expect(toolResult?.attrs.parent_tool_use_id).toBe("cm-1")

			const fileRead = events.find((e) => e.eventName === "file_read")
			expect(fileRead?.attrs.nested).toBe("true")
			expect(fileRead?.attrs.parent_tool_use_id).toBe("cm-1")
		})

		it("marks a nested bash call on tool_result and command_executed", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const toolCallId = "cm-1/2"

			handleToolExecutionStart(ctx, { toolCallId, toolName: "bash", args: { command: "ls" } })
			handleToolExecutionEnd(ctx, piCtx, { toolCallId, isError: false, parentToolCallId: "cm-1" })

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			const toolResult = events.find((e) => e.eventName === "tool_result")
			expect(toolResult?.attrs.nested).toBe("true")
			expect(toolResult?.attrs.parent_tool_use_id).toBe("cm-1")

			const cmdExec = events.find((e) => e.eventName === "command_executed")
			expect(cmdExec?.attrs.command_outcome).toBe("success")
			expect(cmdExec?.attrs.nested).toBe("true")
			expect(cmdExec?.attrs.parent_tool_use_id).toBe("cm-1")
		})

		it("marks a nested call's tool_outcome and error failure record", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const gateId = "cm-1/3"

			// A nested call gated before execution → tool_outcome carries the marker.
			handleToolExecutionStart(ctx, { toolCallId: gateId, toolName: "bash", args: { command: "rm -rf /" } })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId: gateId,
				isError: true,
				parentToolCallId: "cm-1",
				result: {
					content: [{ type: "text", text: "Blocked: the session is in plan mode (read-only)." }],
				},
			})

			// A nested call failing with an unknown error → the error record too.
			const failId = "cm-1/4"
			handleToolExecutionStart(ctx, { toolCallId: failId, toolName: "read", args: { path: "/gone" } })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId: failId,
				isError: true,
				parentToolCallId: "cm-1",
				result: { content: [{ type: "text", text: "something unexpected blew up" }] },
			})

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			const outcome = events.find((e) => e.eventName === "tool_outcome")
			expect(outcome?.attrs.outcome_kind).toBe("blocked")
			expect(outcome?.attrs.nested).toBe("true")
			expect(outcome?.attrs.parent_tool_use_id).toBe("cm-1")

			const error = events.find((e) => e.eventName === "error")
			expect(error?.attrs.error_type).toBe("tool_failure")
			expect(error?.attrs.nested).toBe("true")
			expect(error?.attrs.parent_tool_use_id).toBe("cm-1")
		})

		it("does not mark direct calls", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const toolCallId = "tc-direct-read"

			handleToolExecutionStart(ctx, { toolCallId, toolName: "read", args: { path: "/src/app.ts" } })
			handleToolExecutionEnd(ctx, piCtx, { toolCallId, isError: false })

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			for (const e of events) {
				expect(e.attrs.nested).toBeUndefined()
				expect(e.attrs.parent_tool_use_id).toBeUndefined()
			}
		})
	})

	// -----------------------------------------------------------------------
	// codemode.completed
	// -----------------------------------------------------------------------

	/** A codemode-shaped result: header text block + output text block, with
	 *  optional untrusted `details`. */
	function codemodeResult(details: unknown, outputText = "step one done\n", isError = false) {
		return {
			content: [
				{ type: "text", text: `${isError ? "Script failed" : "Script completed"}\nWall time 0.1 seconds\nOutput:\n` },
				{ type: "text", text: outputText },
			],
			...(details === undefined ? {} : { details }),
		}
	}

	describe("codemode.completed", () => {
		it("emits one summary with tallies, normalized nested_tools, and models cost", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const toolCallId = "cm-1"

			handleToolExecutionStart(ctx, { toolCallId, toolName: "codemode", args: { code: "await tools.read()" } })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId,
				isError: false,
				result: codemodeResult({
					calls: [
						{ id: "cm-1/1", name: "read", args: '{"path":"/secrets.env"}', status: "ok", durationMs: 5 },
						{ id: "cm-1/2", name: "bash", args: '{"command":"cat /secrets.env"}', status: "error", error: "boom" },
						{ id: "cm-1/3", name: "models.classify", args: '{"model":"x"}', status: "ok", cost: 0.001234567 },
						{ id: "cm-1/4", name: "mcp__secret__lookup", args: '{"q":"token"}', status: "cancelled" },
					],
				}),
			})

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			const completed = events.find((e) => e.eventName === "codemode.completed")
			expect(completed).toBeDefined()
			expect(completed?.attrs.success).toBe("true")
			expect(completed?.attrs.tool_use_id).toBe(toolCallId)
			expect(Number(completed?.attrs.nested_call_count)).toBe(4)
			expect(Number(completed?.attrs.nested_error_count)).toBe(1)
			expect(Number(completed?.attrs.nested_cancelled_count)).toBe(1)
			// Allowlisted names keep their id; the MCP tool maps to `other`.
			expect(completed?.attrs.nested_tools).toBe("bash,models.classify,other,read")
			expect(Number(completed?.attrs.nested_models_cost_usd)).toBeCloseTo(0.001235, 6)
			expect(completed?.attrs.output_truncated).toBe("false")

			// Privacy: no script text, no nested args, no error text, and no
			// un-allowlisted tool name anywhere on the emitted records.
			const everything = JSON.stringify(events)
			expect(everything).not.toContain("await tools.read()")
			expect(everything).not.toContain("/secrets.env")
			expect(everything).not.toContain("cat /secrets.env")
			expect(everything).not.toContain("token")
			expect(everything).not.toContain("boom")
			expect(everything).not.toContain("mcp__secret__lookup")
		})

		it("emits no summary for a codemode call blocked before the script ran", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const toolCallId = "cm-blocked"

			handleToolExecutionStart(ctx, { toolCallId, toolName: "codemode", args: { code: "await tools.read()" } })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId,
				isError: true,
				result: {
					content: [
						{ type: "text", text: "codemode is disabled in Kimchi resources. Enable codemode from /resources." },
					],
				},
			})

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			expect(events.find((e) => e.eventName === "codemode.completed")).toBeUndefined()
			// The rejection is still visible, as a tool_outcome.
			const outcome = events.find((e) => e.eventName === "tool_outcome")
			expect(outcome?.attrs.outcome_kind).toBe("blocked")
			expect(outcome?.attrs.tool_name).toBe("codemode")
		})

		it("emits success=false on a failed script; the canonical error record still fires", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const toolCallId = "cm-2"

			handleToolExecutionStart(ctx, { toolCallId, toolName: "codemode", args: { code: "throw new Error('x')" } })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId,
				isError: true,
				result: codemodeResult(
					{ calls: [{ id: "cm-2/1", name: "grep", args: "{}", status: "ok" }] },
					"partial output\n\nScript error:\nReferenceError: x is not defined",
					true,
				),
			})

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			const completed = events.find((e) => e.eventName === "codemode.completed")
			expect(completed?.attrs.success).toBe("false")
			expect(Number(completed?.attrs.nested_call_count)).toBe(1)
			expect(Number(completed?.attrs.nested_error_count)).toBe(0)

			// Chunk 1's canonical classification still funnels the failure.
			const error = events.find((e) => e.eventName === "error")
			expect(error?.attrs.error_type).toBe("tool_failure")
			expect(error?.attrs.error_message).toBe("Codemode script error")
			// The raw script error text must not leak into the error record.
			expect(JSON.stringify(events)).not.toContain("ReferenceError")
		})

		it("emits zero counts when details are absent or malformed", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())

			// Older/absent details.
			handleToolExecutionStart(ctx, { toolCallId: "cm-3", toolName: "codemode", args: {} })
			handleToolExecutionEnd(ctx, piCtx, { toolCallId: "cm-3", isError: false, result: codemodeResult(undefined) })

			// Malformed entries: null, non-object, empty name, unknown status, and
			// a cost-bearing entry with a non-finite cost — all skipped or excluded.
			handleToolExecutionStart(ctx, { toolCallId: "cm-4", toolName: "codemode", args: {} })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId: "cm-4",
				isError: false,
				result: codemodeResult({
					calls: [
						null,
						42,
						{ id: "cm-4/1", status: "ok" },
						{ id: "cm-4/2", name: "", status: "ok" },
						{ id: "cm-4/3", name: "read", status: "exploded" },
						{ id: "cm-4/4", name: "read", status: "ok" },
						{ id: "cm-4/5", name: "models.generateImages", status: "ok", cost: Number.NaN },
						{ id: "cm-4/6", name: "models.generateImages", status: "ok", cost: 0.5 },
					],
				}),
			})

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			const empty = events.find((e) => e.attrs.tool_use_id === "cm-3" && e.eventName === "codemode.completed")
			expect(empty).toBeDefined()
			expect(Number(empty?.attrs.nested_call_count)).toBe(0)
			expect(empty?.attrs.nested_tools).toBe("")
			expect(Number(empty?.attrs.nested_models_cost_usd)).toBe(0)

			const malformed = events.find((e) => e.attrs.tool_use_id === "cm-4" && e.eventName === "codemode.completed")
			expect(malformed).toBeDefined()
			// 5 malformed entries skipped (null, non-object, missing name, empty
			// name, unknown status); 3 valid entries kept. The NaN cost contributes
			// nothing; the 0.5 cost does.
			expect(Number(malformed?.attrs.nested_call_count)).toBe(3)
			expect(Number(malformed?.attrs.nested_error_count)).toBe(0)
			expect(Number(malformed?.attrs.nested_models_cost_usd)).toBeCloseTo(0.5, 6)
		})

		it("maps an unexpected tool name to other and detects truncation with or without a spill path", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			const truncatedBody =
				"Warning: truncated output (original token count: 1234)\nTotal output lines: 900\n\nhead…900 tokens truncated…tail"
			const truncatedOutput = `${truncatedBody}\n\n[Full output: /tmp/spill.txt (read with offset/limit)]`
			const truncatedNoSpill = `${truncatedBody}\n\n[Could not save the full output: EACCES: permission denied]`

			// Truncated, with the spill file saved.
			handleToolExecutionStart(ctx, { toolCallId: "cm-5", toolName: "codemode", args: {} })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId: "cm-5",
				isError: false,
				result: codemodeResult(
					{
						calls: [{ id: "cm-5/1", name: "my_custom_tool", args: "{}", status: "ok" }],
						fullOutputPath: "/tmp/spill.txt",
					},
					truncatedOutput,
				),
			})

			// Truncated, spill write failed (no fullOutputPath) — still detected.
			handleToolExecutionStart(ctx, { toolCallId: "cm-6", toolName: "codemode", args: {} })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId: "cm-6",
				isError: false,
				result: codemodeResult({ calls: [] }, truncatedNoSpill),
			})

			// Truncated, with an image: upstream joins the saved image's label onto
			// the truncated block, after the spill note, and the image follows.
			handleToolExecutionStart(ctx, { toolCallId: "cm-9", toolName: "codemode", args: {} })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId: "cm-9",
				isError: false,
				result: {
					content: [
						{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
						{ type: "text", text: `${truncatedOutput}\n[Image saved to /tmp/img-1.png (image/png, 45.2 kB)]` },
						{ type: "image", data: "aGk=", mimeType: "image/png" },
					],
					details: { calls: [] },
				},
			})

			// Not truncated, though the script's own output starts with the warning
			// text (e.g. it echoed an earlier truncated result).
			handleToolExecutionStart(ctx, { toolCallId: "cm-8", toolName: "codemode", args: {} })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId: "cm-8",
				isError: false,
				result: codemodeResult({ calls: [] }, `${truncatedBody}\nmore of my own output`),
			})

			// Not truncated.
			handleToolExecutionStart(ctx, { toolCallId: "cm-7", toolName: "codemode", args: {} })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId: "cm-7",
				isError: false,
				result: codemodeResult({ calls: [] }, "all fit"),
			})

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			const withSpill = events.find((e) => e.attrs.tool_use_id === "cm-5" && e.eventName === "codemode.completed")
			expect(withSpill?.attrs.output_truncated).toBe("true")
			expect(withSpill?.attrs.nested_tools).toBe("other")
			// The spill path must not leak either.
			expect(JSON.stringify(events)).not.toContain("/tmp/spill.txt")

			const withoutSpill = events.find((e) => e.attrs.tool_use_id === "cm-6" && e.eventName === "codemode.completed")
			expect(withoutSpill?.attrs.output_truncated).toBe("true")

			const notTruncated = events.find((e) => e.attrs.tool_use_id === "cm-7" && e.eventName === "codemode.completed")
			expect(notTruncated?.attrs.output_truncated).toBe("false")

			const echoed = events.find((e) => e.attrs.tool_use_id === "cm-8" && e.eventName === "codemode.completed")
			expect(echoed?.attrs.output_truncated).toBe("false")

			const withImage = events.find((e) => e.attrs.tool_use_id === "cm-9" && e.eventName === "codemode.completed")
			expect(withImage?.attrs.output_truncated).toBe("true")
		})

		it("records an aborted script in codemode.completed but emits no error", async () => {
			const piCtx = createContext({ model: { id: "claude-3-5-sonnet" } })
			const ctx = new TelemetryContext(makeConfig())
			handleToolExecutionStart(ctx, { toolCallId: "cm-abort", toolName: "codemode", args: {} })
			handleToolExecutionEnd(ctx, piCtx, {
				toolCallId: "cm-abort",
				isError: true,
				result: codemodeResult(
					{ calls: [] },
					"partial\nScript error:\nScript aborted: The operation was aborted\n\nNo tool calls were made.",
					true,
				),
			})

			ctx.flushLogBuffer()
			await Promise.allSettled([...ctx.inFlight])
			const events = parseLogEvents(fetchMock)

			expect(events.find((e) => e.eventName === "codemode.completed")?.attrs.success).toBe("false")
			// agent.interrupted owns the abort signal; no tool_failure double-count.
			expect(events.find((e) => e.eventName === "error")).toBeUndefined()
		})

		it("pins the upstream strings the codemode classification and truncation checks rely on", async () => {
			const entry = import.meta.resolve("@earendil-works/pi-coding-agent")
			const source = await readFile(new URL("./extensions/codemode/execute.js", entry), "utf8")
			expect(source).toContain(': "Script failed"}\\nWall time')
			expect(source).toContain("Script error:\\n${formatError(")
			expect(source).toContain("`Script aborted: ${")
			expect(source).toContain("`Script timed out: ${")
			expect(source).toContain(`\`${CODEMODE_TRUNCATION_WARNING}\${`)
			expect(source).toContain("(read with offset/limit)]`")
			expect(source).toContain("`\\n\\n[Could not save the full output: ${")
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
