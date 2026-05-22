import { describe, expect, it } from "vitest"
import { classifyTool, formatSummary } from "./tool-grouping.js"

describe("classifyTool", () => {
	it("classifies read tool as file", () => {
		expect(classifyTool("read", { path: "foo.ts" })).toBe("file")
	})
	it("classifies grep as pattern", () => {
		expect(classifyTool("grep", { pattern: "foo" })).toBe("pattern")
	})
	it("classifies find as pattern", () => {
		expect(classifyTool("find", { pattern: "*.ts" })).toBe("pattern")
	})
	it("classifies ls as directory", () => {
		expect(classifyTool("ls", {})).toBe("directory")
	})
	it("classifies write as edit", () => {
		expect(classifyTool("write", { file_path: "foo.ts" })).toBe("edit")
	})
	it("classifies edit as edit", () => {
		expect(classifyTool("edit", { file_path: "foo.ts" })).toBe("edit")
	})
	it("classifies multiedit as edit", () => {
		expect(classifyTool("multiedit", {})).toBe("edit")
	})
	it("classifies bash ls as directory", () => {
		expect(classifyTool("bash", { command: "ls src/" })).toBe("directory")
	})
	it("classifies bash fd as directory", () => {
		expect(classifyTool("bash", { command: "fd . src/" })).toBe("directory")
	})
	it("classifies bash find as directory", () => {
		expect(classifyTool("bash", { command: "find . -name '*.ts'" })).toBe("directory")
	})
	it("classifies bash grep as pattern", () => {
		expect(classifyTool("bash", { command: "grep -r foo src/" })).toBe("pattern")
	})
	it("classifies bash rg as pattern", () => {
		expect(classifyTool("bash", { command: "rg 'pattern' src/" })).toBe("pattern")
	})
	it("classifies bash cat as file", () => {
		expect(classifyTool("bash", { command: "cat src/foo.ts" })).toBe("file")
	})
	it("classifies bash head as file", () => {
		expect(classifyTool("bash", { command: "head -20 foo.ts" })).toBe("file")
	})
	it("classifies bash tail as file", () => {
		expect(classifyTool("bash", { command: "tail -f log" })).toBe("file")
	})
	it("classifies bash git as command", () => {
		expect(classifyTool("bash", { command: "git status" })).toBe("command")
	})
	it("classifies unknown tool as operation", () => {
		expect(classifyTool("some_mcp_tool", {})).toBe("operation")
	})
})

describe("formatSummary", () => {
	it("formats past tense singular file", () => {
		expect(formatSummary(new Map([["file", 1]]), false)).toBe("read 1 file")
	})
	it("formats past tense plural files", () => {
		expect(formatSummary(new Map([["file", 3]]), false)).toBe("read 3 files")
	})
	it("formats past tense pattern", () => {
		expect(formatSummary(new Map([["pattern", 2]]), false)).toBe("searched for 2 patterns")
	})
	it("formats past tense directory singular", () => {
		expect(formatSummary(new Map([["directory", 1]]), false)).toBe("listed 1 directory")
	})
	it("formats past tense directory plural", () => {
		expect(formatSummary(new Map([["directory", 2]]), false)).toBe("listed 2 directories")
	})
	it("formats past tense edit", () => {
		expect(formatSummary(new Map([["edit", 1]]), false)).toBe("made 1 edit")
	})
	it("formats past tense command", () => {
		expect(formatSummary(new Map([["command", 3]]), false)).toBe("ran 3 commands")
	})
	it("formats past tense operation", () => {
		expect(formatSummary(new Map([["operation", 2]]), false)).toBe("2 operations")
	})
	it("formats continuous tense file", () => {
		expect(formatSummary(new Map([["file", 2]]), true)).toBe("reading 2 files")
	})
	it("formats continuous tense pattern singular", () => {
		expect(formatSummary(new Map([["pattern", 1]]), true)).toBe("searching for 1 pattern")
	})
	it("formats continuous tense directory", () => {
		expect(formatSummary(new Map([["directory", 2]]), true)).toBe("listing 2 directories")
	})
	it("formats continuous tense command", () => {
		expect(formatSummary(new Map([["command", 1]]), true)).toBe("running 1 command")
	})
	it("formats continuous tense edit", () => {
		expect(formatSummary(new Map([["edit", 1]]), true)).toBe("editing 1 file")
	})
	it("joins multiple categories with comma", () => {
		expect(
			formatSummary(new Map([["file", 2], ["pattern", 1]]), false)
		).toBe("read 2 files, searched for 1 pattern")
	})
})
