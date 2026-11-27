import { describe, expect, it, vi } from "vitest"
import type { ExtensionContext } from "@earendil-works/pi-coding-agent"
import { createContext } from "../../__mocks__/context.js"
import type { TelemetryContext } from "../session-context.js"
import { emitDocumentCliCompleted } from "./document-cli.js"

function telemetryMock() {
	return {
		emit: vi.fn(),
		lastRoutedModel: undefined,
		turnIndex: 1,
	} as unknown as TelemetryContext
}

describe("pre-execution document abort telemetry", () => {
	it("does not emit completion for a queued command aborted before execution", () => {
		const tm = telemetryMock()
		const ctx = createContext() as ExtensionContext
		emitDocumentCliCompleted(tm, ctx, {
			command: "kimchi doc-cli pdf info input.pdf",
			resultText: "Operation aborted",
			isError: true,
			classification: { kind: "aborted", message: "Operation aborted" },
			durationMs: 1,
			toolCallId: "abort-queued-command",
		})
		expect(tm.emit).not.toHaveBeenCalled()
	})
})
