import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { TODO_CUSTOM_ENTRY_TYPE } from "./constants.js"
import { getWriteTodosDetails, isTodoWriteToolName, isWriteTodosDetails } from "./session.js"
import { TODO_TOOL_NAMES } from "./tool.js"
import { TODO_TOOL_RESULT_SCHEMA_VERSION, type WriteTodosDetails } from "./types.js"

function validDetails(overrides: Partial<WriteTodosDetails> = {}): WriteTodosDetails {
	return {
		schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
		scope: { kind: "global" },
		todos: [{ id: 1, content: "do it", status: "pending" }],
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	}
}

function messageEntry(toolName: string, details: unknown, role = "toolResult"): SessionEntry {
	return {
		type: "message",
		id: "m1",
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role,
			toolCallId: "call-m1",
			toolName,
			content: [],
			details,
		},
	} as unknown as SessionEntry
}

describe("todo session replay helpers", () => {
	it("recognizes current and legacy todo write tools", () => {
		for (const toolName of TODO_TOOL_NAMES) {
			expect(isTodoWriteToolName(toolName)).toBe(true)
		}
		expect(isTodoWriteToolName("write_todos")).toBe(true)
		expect(isTodoWriteToolName("bash")).toBe(false)
	})

	it("accepts only valid todo result details", () => {
		expect(isWriteTodosDetails(validDetails())).toBe(true)
		expect(isWriteTodosDetails(validDetails({ schemaVersion: 999 as never }))).toBe(false)
		expect(isWriteTodosDetails(validDetails({ todos: "not-an-array" as never }))).toBe(false)
		expect(isWriteTodosDetails(null)).toBe(false)
	})

	it("extracts details from custom and tool result entries", () => {
		const details = validDetails()
		const customEntry = {
			type: "custom",
			id: "c1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			customType: TODO_CUSTOM_ENTRY_TYPE,
			data: details,
		} as unknown as SessionEntry

		expect(getWriteTodosDetails(customEntry)).toEqual(details)
		expect(getWriteTodosDetails(messageEntry(TODO_TOOL_NAMES[0], details))).toEqual(details)
		expect(getWriteTodosDetails(messageEntry("write_todos", details))).toEqual(details)
	})

	it("ignores unrelated entries", () => {
		expect(getWriteTodosDetails(messageEntry("bash", validDetails()))).toBeUndefined()
		expect(getWriteTodosDetails(messageEntry(TODO_TOOL_NAMES[0], validDetails(), "assistant"))).toBeUndefined()
		expect(
			getWriteTodosDetails(messageEntry(TODO_TOOL_NAMES[0], { schemaVersion: 999, scope: {}, todos: [] })),
		).toBeUndefined()
	})
})
