import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TODO_CUSTOM_ENTRY_TYPE } from "./constants.js"
import {
	getWriteTodosDetails,
	isTodoWriteToolName,
	isWriteTodosDetails,
	restoreTodoStoreFromSessionEntries,
} from "./session.js"
import { TODO_TOOL_NAMES } from "./tool.js"
import { TODO_TOOL_RESULT_SCHEMA_VERSION, type WriteTodosDetails } from "./types.js"

vi.mock("./store.js", () => ({
	restoreTodoStoreFromDetails: vi.fn(),
}))

import { restoreTodoStoreFromDetails } from "./store.js"

function validDetails(overrides: Partial<WriteTodosDetails> = {}): WriteTodosDetails {
	return {
		schemaVersion: TODO_TOOL_RESULT_SCHEMA_VERSION,
		scope: { kind: "global" },
		todos: [{ id: 1, content: "do it", status: "pending" }],
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	}
}

function messageEntry(id: string, toolName: string, details: unknown, role: string = "toolResult"): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		message: {
			role,
			toolCallId: `call-${id}`,
			toolName,
			content: [],
			details,
		},
	} as unknown as SessionEntry
}

function customEntry(id: string, customType: string, data: unknown): SessionEntry {
	return {
		type: "custom",
		id,
		parentId: null,
		timestamp: "2026-01-01T00:00:00.000Z",
		customType,
		data,
	} as unknown as SessionEntry
}

describe("isWriteTodosDetails", () => {
	it("accepts a well-formed payload", () => {
		expect(isWriteTodosDetails(validDetails())).toBe(true)
	})

	it("rejects a wrong schemaVersion", () => {
		expect(isWriteTodosDetails(validDetails({ schemaVersion: (TODO_TOOL_RESULT_SCHEMA_VERSION + 1) as never }))).toBe(
			false,
		)
	})

	it("rejects a payload missing scope", () => {
		const { scope, ...rest } = validDetails()
		expect(isWriteTodosDetails(rest)).toBe(false)
	})

	it("rejects a payload with non-array todos", () => {
		expect(isWriteTodosDetails(validDetails({ todos: "not-an-array" as never }))).toBe(false)
	})

	it("rejects null", () => {
		expect(isWriteTodosDetails(null)).toBe(false)
	})

	it("rejects a primitive", () => {
		expect(isWriteTodosDetails("invalid")).toBe(false)
	})
})

describe("isTodoWriteToolName", () => {
	it("returns true for every current todo tool name", () => {
		for (const toolName of TODO_TOOL_NAMES) {
			expect(isTodoWriteToolName(toolName)).toBe(true)
		}
	})

	it("returns false for an unrelated tool name", () => {
		expect(isTodoWriteToolName("bash")).toBe(false)
	})
})

describe("getWriteTodosDetails", () => {
	it("reads details from a custom todos entry", () => {
		const details = validDetails()
		const entry = customEntry("c1", TODO_CUSTOM_ENTRY_TYPE, details)
		expect(getWriteTodosDetails(entry)).toEqual(details)
	})

	it("reads details from a todo toolResult message entry", () => {
		const details = validDetails()
		const entry = messageEntry("m1", TODO_TOOL_NAMES[0], details)
		expect(getWriteTodosDetails(entry)).toEqual(details)
	})

	it("returns undefined for a toolResult message from a non-todo tool", () => {
		const entry = messageEntry("m2", "bash", validDetails())
		expect(getWriteTodosDetails(entry)).toBeUndefined()
	})

	it("returns undefined when the message role is not toolResult", () => {
		const entry = messageEntry("m3", TODO_TOOL_NAMES[0], validDetails(), "assistant")
		expect(getWriteTodosDetails(entry)).toBeUndefined()
	})

	it("returns undefined for a custom entry with a different customType", () => {
		const entry = customEntry("c2", "some.other.type", validDetails())
		expect(getWriteTodosDetails(entry)).toBeUndefined()
	})

	it("returns undefined for an entry type that is neither message nor custom", () => {
		const entry = { type: "system", id: "s1", parentId: null } as unknown as SessionEntry
		expect(getWriteTodosDetails(entry)).toBeUndefined()
	})

	it("returns undefined when a matching entry's details fail the schema guard", () => {
		const entry = messageEntry("m4", TODO_TOOL_NAMES[0], { schemaVersion: 999, scope: {}, todos: [] })
		expect(getWriteTodosDetails(entry)).toBeUndefined()
	})
})

describe("restoreTodoStoreFromSessionEntries", () => {
	beforeEach(() => {
		vi.mocked(restoreTodoStoreFromDetails).mockClear()
	})

	it("filters out non-todo entries and forwards only valid details with the session id as scope key", () => {
		const validDetail = validDetails()
		const branch: SessionEntry[] = [
			messageEntry("m1", "bash", { unrelated: true }),
			customEntry("c1", TODO_CUSTOM_ENTRY_TYPE, validDetail),
			messageEntry("m2", TODO_TOOL_NAMES[0], validDetail, "assistant"),
		]
		const sessionManager = {
			getBranch: () => branch,
			getSessionId: () => "session-xyz",
		}

		restoreTodoStoreFromSessionEntries(sessionManager)

		expect(restoreTodoStoreFromDetails).toHaveBeenCalledTimes(1)
		expect(restoreTodoStoreFromDetails).toHaveBeenCalledWith([validDetail], "session-xyz")
	})
})
