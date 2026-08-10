import type { AssistantMessage, Context, ToolCall, Usage } from "@earendil-works/pi-ai"
import { describe, expect, it } from "vitest"
import type { ChangeSet } from "../../agent-patch/index.js"
import {
	describeChangeSet,
	hasInvalidToolCalls,
	hasSerializedToolCallMarkup,
	LEAD_OUTPUT_SYSTEM_PROMPT,
	LEAD_RETRY_SYSTEM_PROMPT,
	LEAD_VERIFY_STAGED_SYSTEM_PROMPT,
	publicContent,
	resolvePublicMessage,
} from "./coordinator.js"

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

const finalizerContext: Context = {
	messages: [],
	tools: [{ name: "read", description: "Read", parameters: { type: "object" } }],
}

function finalizerMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"],
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "physical",
		model: "model",
		usage: ZERO_USAGE,
		stopReason,
		timestamp: 1,
	}
}

const toolCall = (overrides: Partial<ToolCall> = {}): ToolCall => ({
	type: "toolCall",
	id: "call_1",
	name: "read",
	arguments: { path: "a.txt" },
	...overrides,
})

describe("final response boundary", () => {
	it("exports the lead safeguards", () => {
		expect(LEAD_OUTPUT_SYSTEM_PROMPT).toContain("user-facing answer or a valid tool call")
		expect(LEAD_RETRY_SYSTEM_PROMPT).toContain("without a user-facing answer or tool call")
		expect(LEAD_VERIFY_STAGED_SYSTEM_PROMPT).toContain("council_check_candidate")
		expect(LEAD_VERIFY_STAGED_SYSTEM_PROMPT).toContain("fix the staged files and check again")
	})

	it("strips thinking and preserves public blocks exactly", () => {
		const text = { type: "text" as const, text: "done" }
		const call = toolCall()
		expect(publicContent(finalizerMessage([{ type: "thinking", thinking: "private" }, text, call], "toolUse"))).toEqual(
			[text, call],
		)
	})

	it("accepts advertised tool calls with plain, null-prototype, or custom-prototype object arguments", () => {
		const nullPrototypeArguments = Object.assign(Object.create(null), { path: "a.txt" })
		expect(hasInvalidToolCalls([toolCall()], finalizerContext)).toBe(false)
		expect(hasInvalidToolCalls([toolCall({ arguments: nullPrototypeArguments })], finalizerContext)).toBe(false)
		expect(
			hasInvalidToolCalls([toolCall({ arguments: new Date() as unknown as ToolCall["arguments"] })], finalizerContext),
		).toBe(false)
	})

	it.each([
		["blank id", toolCall({ id: " " })],
		["blank name", toolCall({ name: " " })],
		["unadvertised name", toolCall({ name: "write" })],
		["null arguments", toolCall({ arguments: null as unknown as ToolCall["arguments"] })],
		["array arguments", toolCall({ arguments: [] as unknown as ToolCall["arguments"] })],
	])("rejects %s", (_label, call) => {
		expect(hasInvalidToolCalls([call], finalizerContext)).toBe(true)
	})

	it("rejects duplicate tool-call ids", () => {
		expect(hasInvalidToolCalls([toolCall(), toolCall({ name: "read" })], finalizerContext)).toBe(true)
	})

	it.each([
		"<|tool_calls_section_begin|>",
		"<|tool_call_begin|>",
		"<|tool_call_argument_begin|>",
	])("detects serialized marker %s", (marker) => {
		expect(hasSerializedToolCallMarkup(`prefix ${marker} suffix`)).toBe(true)
	})
})

function changeSet(operations: ChangeSet["operations"], files = operations.length): ChangeSet {
	return {
		transactionId: "txn",
		operations,
		base: [],
		patch: "",
		patchSha256: "sha",
		stats: { files, addedLines: 0, removedLines: 0, patchBytes: 0 },
	}
}

describe("describeChangeSet", () => {
	it("describes a single updated file", () => {
		const set = changeSet([{ kind: "update", path: "slugify.js", baseSha256: "a", content: "x" }])
		expect(describeChangeSet(set)).toBe("Updated slugify.js.")
	})

	it("lists a few updated files", () => {
		const set = changeSet([
			{ kind: "update", path: "slugify.js", baseSha256: "a", content: "x" },
			{ kind: "update", path: "index.js", baseSha256: "b", content: "y" },
		])
		expect(describeChangeSet(set)).toBe("Updated slugify.js, index.js.")
	})

	it("falls back to a count for many files", () => {
		const set = changeSet(
			Array.from({ length: 7 }, (_, index) => ({
				kind: "update" as const,
				path: `file-${index}.js`,
				baseSha256: "a",
				content: "x",
			})),
		)
		expect(describeChangeSet(set)).toBe("Updated 7 files.")
	})

	it("reflects mixed operation kinds", () => {
		const set = changeSet([
			{ kind: "create", path: "config.js", content: "x" },
			{ kind: "update", path: "index.js", baseSha256: "a", content: "y" },
		])
		expect(describeChangeSet(set)).toBe("Created config.js and updated index.js.")
	})

	it("reflects deletions and renames alongside creates and updates", () => {
		const set = changeSet([
			{ kind: "create", path: "config.js", content: "x" },
			{ kind: "update", path: "index.js", baseSha256: "a", content: "y" },
			{ kind: "delete", path: "old.js", baseSha256: "b" },
			{ kind: "rename", path: "new-name.js", fromPath: "name.js", baseSha256: "c", content: "z" },
		])
		expect(describeChangeSet(set)).toBe("Created config.js, updated index.js, deleted old.js and renamed new-name.js.")
	})

	it("never throws and always returns a non-empty sentence, even for an empty change set", () => {
		const set = changeSet([], 0)
		expect(describeChangeSet(set)).toBe("Applied the staged change.")
	})
})

describe("resolvePublicMessage", () => {
	const fallbackSet = changeSet([{ kind: "update", path: "file.txt", baseSha256: "a", content: "x" }])

	it("prefers the lead's own prose when present", () => {
		expect(resolvePublicMessage("Lead prose.", "Synthesis summary.", fallbackSet)).toBe("Lead prose.")
	})

	it("falls back to the synthesis summary when the lead has no usable prose", () => {
		expect(resolvePublicMessage(undefined, "Synthesis summary.", fallbackSet)).toBe("Synthesis summary.")
	})

	it("ignores a blank synthesis summary and falls further back to the derived change-set line", () => {
		expect(resolvePublicMessage("", "   ", fallbackSet)).toBe("Updated file.txt.")
	})

	it("derives from the change set when neither lead prose nor a summary is present", () => {
		expect(resolvePublicMessage(undefined, undefined, fallbackSet)).toBe("Updated file.txt.")
	})
})
