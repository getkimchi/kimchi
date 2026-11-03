import { describe, expect, it } from "vitest"
import { btwCompletions, parseBtwArgs } from "./command.js"

describe("parseBtwArgs", () => {
	it.each([
		["", { action: "open", question: undefined }],
		["  Which cache?  ", { action: "open", question: "Which cache?" }],
		["history", { action: "history" }],
		[" close ", { action: "close" }],
		["new", { action: "new", question: undefined }],
		["new Why LRU?", { action: "new", question: "Why LRU?" }],
		["new\nmulti\nline", { action: "new", question: "multi\nline" }],
	])("parses %j", (args, expected) => {
		expect(parseBtwArgs(args)).toEqual(expected)
	})

	it.each([
		"close the loop on caching?",
		"history of this module?",
		"newer cache libs?",
		"New approach: what about Redis?",
		"History",
	])("keeps %j a question", (args) => {
		expect(parseBtwArgs(args)).toEqual({ action: "open", question: args })
	})
})

describe("btwCompletions", () => {
	it("suggests every action for an empty argument", () => {
		expect(btwCompletions("")?.map((item) => item.value)).toEqual(["new", "history", "close"])
	})

	it("narrows by the typed prefix", () => {
		expect(btwCompletions("h")?.map((item) => item.value)).toEqual(["history"])
	})

	it("stops suggesting once a question is under way", () => {
		expect(btwCompletions("why ")).toBeNull()
		expect(btwCompletions("why")).toBeNull()
	})
})
