import type { SessionEntry } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import {
	contentText,
	historyLabel,
	isWrapUpPrompt,
	readSideChatHistory,
	SIDE_CHAT_ENTRY_TYPE,
	type SideChatRecord,
	titleFrom,
	UNTITLED_SIDE_CHAT,
	wrapUpPrompt,
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

describe("wrapUpPrompt", () => {
	it("is recognised as a wrap-up prompt", () => {
		expect(isWrapUpPrompt(wrapUpPrompt(""))).toBe(true)
		expect(isWrapUpPrompt("Wrap it up")).toBe(false)
	})

	it("appends the user's extra instructions", () => {
		expect(wrapUpPrompt("keep it short")).toContain("Additional instructions from the user: keep it short")
		expect(wrapUpPrompt("")).not.toContain("Additional instructions")
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
	it("counts questions without the wrap-up prompt and marks fresh, sent chats", () => {
		const label = historyLabel(
			record({
				title: "Caching",
				fresh: true,
				outcome: "sent",
				messages: [
					{ role: "user", content: "why?", timestamp: 0 },
					{ role: "user", content: [{ type: "text", text: wrapUpPrompt("") }], timestamp: 0 },
				],
			}),
		)

		expect(label).toContain("Caching  (1 question · fresh · sent to main)")
	})

	it("pluralises the question count", () => {
		expect(historyLabel(record({ title: "T" }))).toContain("T  (0 questions)")
	})
})
