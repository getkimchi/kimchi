import { describe, expect, it, vi } from "vitest"
import type { TelemetryConfig } from "../../../config.js"
import { createContext } from "../../__mocks__/context.js"
import { TelemetryContext } from "../session-context.js"
import { emitDocumentCliCompleted } from "./document-cli.js"
import { handleToolExecutionEnd, handleToolExecutionStart } from "./tools.js"

function telemetryMock() {
	const config: TelemetryConfig = {
		enabled: true,
		endpoint: "",
		metricsEndpoint: "",
		headers: {},
		apiKey: "",
	}
	const tm = new TelemetryContext(config)
	tm.emit = vi.fn()
	tm.turnIndex = 1
	return tm
}

describe("document abort telemetry", () => {
	it("emits no completion for a queued bare abort", () => {
		const tm = telemetryMock()
		const ctx = createContext()
		emitDocumentCliCompleted(tm, ctx, {
			command: "kimchi doc-cli pdf info input.pdf",
			resultText: "Operation aborted",
			isError: true,
			classification: { kind: "aborted", message: "Operation aborted" },
			durationMs: undefined,
			toolCallId: "abort-queued-command",
		})
		expect(tm.emit).not.toHaveBeenCalled()
	})

	it("preserves the command-aborted outcome for in-flight document commands", () => {
		const tm = telemetryMock()
		const ctx = createContext()
		emitDocumentCliCompleted(tm, ctx, {
			command: "kimchi doc-cli pdf read input.pdf",
			resultText: "Command aborted",
			isError: true,
			classification: { kind: "aborted", message: "Command aborted" },
			durationMs: 4,
			toolCallId: "abort-in-flight-command",
		})
		expect(tm.emit).toHaveBeenCalledOnce()
		expect(tm.emit).toHaveBeenCalledWith(
			"document_cli.completed",
			expect.objectContaining({ outcome: "aborted", duration_ms: 4, tool_use_id: "abort-in-flight-command" }),
			ctx,
			undefined,
		)
	})
})

describe("upstream tool execution end integration", () => {
	it("preserves an in-flight Command aborted outcome for document commands", () => {
		const tm = telemetryMock()
		const ctx = createContext()
		handleToolExecutionStart(tm, {
			toolCallId: "upstream-in-flight",
			toolName: "bash",
			args: { command: "kimchi doc-cli pdf info input.pdf" },
		})
		handleToolExecutionEnd(tm, ctx, {
			toolCallId: "upstream-in-flight",
			isError: true,
			result: { content: [{ type: "text", text: "Command aborted" }], details: {} },
		})
		expect(tm.emit).toHaveBeenCalledWith(
			"document_cli.completed",
			expect.objectContaining({ outcome: "aborted" }),
			ctx,
			undefined,
		)
	})
})
