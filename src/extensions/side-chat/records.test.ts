import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import {
	contentText,
	historyLabel,
	readSideChatHistory,
	SIDE_CHAT_ENTRY_TYPE,
	type SideChatRecord,
	titleFrom,
	UNTITLED_SIDE_CHAT,
	wrapUpRequest,
} from "./records.js"

function record(overrides: Partial<SideChatRecord>): SideChatRecord {
	return {
		id: "chat-1",
		branchLeafId: null,
		startedAt: 0,
		updatedAt: 0,
		title: "Title",
		messages: [],
		...overrides,
	}
}

function customEntry(data: unknown, customType = SIDE_CHAT_ENTRY_TYPE): SessionEntry {
	return { type: "custom", id: "e", parentId: null, timestamp: "", customType, data } as SessionEntry
}

describe("titleFrom", () => {
	it.each([
		{ name: "first non-empty line", text: "\n  first line \nsecond", expected: "first line" },
		{ name: "quote markers stripped", text: "> quoted\n> more", expected: "quoted" },
		{ name: "blank text", text: " \n> ", expected: UNTITLED_SIDE_CHAT },
		{ name: "long line truncated", text: "x".repeat(80), expected: `${"x".repeat(59)}…` },
	])("$name", ({ text, expected }) => {
		expect(titleFrom(text)).toBe(expected)
	})
})

describe("wrapUpRequest", () => {
	it("renders the side thread with the tools the assistant called", () => {
		const request = wrapUpRequest(
			[
				{ role: "user", content: "Which cache?", timestamp: 0 },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Let me look." },
						{ type: "toolCall", id: "t1", name: "read", arguments: { path: "cache.ts" } },
					],
					timestamp: 0,
				} as SideChatRecord["messages"][number],
				{
					role: "assistant",
					content: [{ type: "text", text: "Use the LRU cache." }],
					timestamp: 0,
				} as SideChatRecord["messages"][number],
			],
			"",
		)

		expect(request).toContain(
			[
				"<side_conversation>",
				"[User]: Which cache?",
				"",
				"[Assistant]: Let me look.",
				"",
				'[Assistant called read]: {"path":"cache.ts"}',
				"",
				"[Assistant]: Use the LRU cache.",
				"</side_conversation>",
			].join("\n"),
		)
		expect(request).not.toContain("Additional instructions")
	})

	it("appends the user's extra /wrap instructions", () => {
		expect(wrapUpRequest([], "keep it short")).toContain("Additional instructions from the user: keep it short")
	})
})

describe("contentText", () => {
	it("joins text blocks and ignores other blocks", () => {
		expect(contentText("plain")).toBe("plain")
		expect(
			contentText([
				{ type: "text", text: "a" },
				{ type: "image", data: "", mimeType: "image/png" },
				{ type: "text", text: "b" },
			]),
		).toBe("a\nb")
	})
})

describe("readSideChatHistory", () => {
	it("keeps the latest record per id, most recently updated first", () => {
		const entries = [
			customEntry(record({ id: "a", title: "old a", updatedAt: 1 })),
			customEntry(record({ id: "b", title: "b", updatedAt: 2 })),
			customEntry(record({ id: "a", title: "new a", updatedAt: 3 })),
			customEntry(record({ id: "c" }), "other-extension"),
			customEntry({}),
			{ type: "message" } as SessionEntry,
		]

		expect(readSideChatHistory(entries).map((chat) => chat.title)).toEqual(["new a", "b"])
	})
})

describe("historyLabel", () => {
	it("counts questions and marks fresh, sent chats", () => {
		const label = historyLabel(
			record({
				title: "Caching",
				fresh: true,
				outcome: "sent",
				messages: [{ role: "user", content: "why?", timestamp: 0 }],
			}),
		)

		expect(label).toContain("Caching  (1 question · fresh · sent to main)")
	})

	it("pluralises the question count", () => {
		expect(historyLabel(record({ title: "T" }))).toContain("T  (0 questions)")
	})
})
