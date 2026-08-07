import { describe, expect, it } from "vitest"
import { buildToolCall, buildToolCallShape, buildToolCallUpdate, describeToolCall, isHiddenToolCall } from "./utils.js"

describe("isHiddenToolCall", () => {
	it("returns false for non-Agent tool names", () => {
		expect(isHiddenToolCall("bash", {})).toBe(false)
		expect(isHiddenToolCall("read", { visibility: "system" })).toBe(false)
	})

	it("returns false when visibility is missing", () => {
		expect(isHiddenToolCall("Agent", {})).toBe(false)
		expect(isHiddenToolCall("Agent", { prompt: "hello" })).toBe(false)
	})

	it("returns false when visibility is not 'system' (any casing)", () => {
		expect(isHiddenToolCall("Agent", { visibility: "public" })).toBe(false)
		expect(isHiddenToolCall("Agent", { visibility: "private" })).toBe(false)
	})

	it("returns true when visibility is 'system' (case-insensitive)", () => {
		expect(isHiddenToolCall("Agent", { visibility: "system" })).toBe(true)
		expect(isHiddenToolCall("Agent", { visibility: "System" })).toBe(true)
		expect(isHiddenToolCall("Agent", { visibility: "SYSTEM" })).toBe(true)
	})

	it("detects hidden system Agent calls", () => {
		expect(isHiddenToolCall("Agent", { visibility: "system" })).toBe(true)
		expect(isHiddenToolCall("Agent", { visibility: "user" })).toBe(false)
		expect(isHiddenToolCall("bash", { visibility: "system" })).toBe(false)
	})

	it("returns true for Agent with mixed-case 'System' visibility", () => {
		expect(isHiddenToolCall("Agent", { visibility: "SyStEm" })).toBe(true)
	})
})

describe("buildToolCall", () => {
	it("builds a tool_call from derived display fields", () => {
		const result = buildToolCall({
			toolName: "read",
			toolCallId: "acp-1",
			piToolCallId: "pi-1",
			status: "pending",
			rawInput: { file_path: "/etc/hosts" },
		})
		expect(result).toEqual({
			sessionUpdate: "tool_call",
			toolCallId: "acp-1",
			status: "pending",
			title: "/etc/hosts",
			kind: "read",
			locations: [{ path: "/etc/hosts" }],
			rawInput: { file_path: "/etc/hosts" },
			_meta: { piToolCallId: "pi-1" },
		})
	})

	it("merges additional _meta fields", () => {
		const result = buildToolCall({
			toolName: "bash",
			toolCallId: "acp-2",
			piToolCallId: "pi-2",
			status: "in_progress",
			rawInput: { command: "echo hi" },
			_meta: { source: "test" },
		})
		expect(result._meta).toEqual({ piToolCallId: "pi-2", source: "test" })
	})

	it("builds a bare ToolCall shape without sessionUpdate discriminant", () => {
		const result = buildToolCallShape({
			toolName: "Agent",
			toolCallId: "acp-3",
			piToolCallId: "pi-3",
			status: "in_progress",
			rawInput: { prompt: "go" },
		})
		expect(result).toEqual({
			toolCallId: "acp-3",
			status: "in_progress",
			title: "Agent",
			kind: "think",
			locations: [],
			rawInput: { prompt: "go" },
			_meta: { piToolCallId: "pi-3" },
		})
		expect(result).not.toHaveProperty("sessionUpdate")
	})
})

describe("buildToolCallUpdate", () => {
	it("builds a tool_call_update with required fields", () => {
		const result = buildToolCallUpdate({
			toolCallId: "acp-1",
			piToolCallId: "pi-1",
			status: "in_progress",
		})
		expect(result).toEqual({
			sessionUpdate: "tool_call_update",
			toolCallId: "acp-1",
			status: "in_progress",
			_meta: { piToolCallId: "pi-1" },
		})
	})

	it("carries through optional display and content fields", () => {
		const result = buildToolCallUpdate({
			toolCallId: "acp-2",
			piToolCallId: "pi-2",
			status: "in_progress",
			title: "custom title",
			kind: "search",
			locations: [{ path: "/tmp" }],
			content: [{ type: "content", content: { type: "text", text: "done" } }],
			rawInput: { pattern: "foo" },
			rawOutput: { result: "bar" },
		})
		expect(result).toEqual({
			sessionUpdate: "tool_call_update",
			toolCallId: "acp-2",
			status: "in_progress",
			title: "custom title",
			kind: "search",
			locations: [{ path: "/tmp" }],
			content: [{ type: "content", content: { type: "text", text: "done" } }],
			rawInput: { pattern: "foo" },
			rawOutput: { result: "bar" },
			_meta: { piToolCallId: "pi-2" },
		})
	})

	it("merges additional _meta fields", () => {
		const result = buildToolCallUpdate({
			toolCallId: "acp-3",
			piToolCallId: "pi-3",
			status: "pending",
			_meta: { source: "test" },
		})
		expect(result._meta).toEqual({ piToolCallId: "pi-3", source: "test" })
	})

	it("carries through the input status", () => {
		const result = buildToolCallUpdate({
			toolCallId: "acp-4",
			piToolCallId: "pi-4",
			status: "completed",
		})
		expect((result as { status?: string }).status).toBe("completed")
	})
})

describe("describeToolCall", () => {
	const longCommand = "a".repeat(120)
	const longPath = `/tmp/${"x".repeat(120)}`
	const longPattern = "p".repeat(120)
	const cases: Array<{
		name: string
		toolName: string
		args: unknown
		expect: { title: string; kind: string; locations: Array<{ path: string }> }
	}> = [
		{
			name: "bash with command uses command as title and execute kind",
			toolName: "bash",
			args: { command: "ls -la" },
			expect: { title: "ls -la", kind: "execute", locations: [] },
		},
		{
			name: "bash without command falls back to tool name",
			toolName: "bash",
			args: {},
			expect: { title: "bash", kind: "execute", locations: [] },
		},
		{
			name: "bash command is truncated at TITLE_MAX",
			toolName: "bash",
			args: { command: longCommand },
			expect: { title: `${"a".repeat(80)}…`, kind: "execute", locations: [] },
		},
		{
			name: "read with file_path uses path and populates locations",
			toolName: "read",
			args: { file_path: "/etc/hosts" },
			expect: {
				title: "/etc/hosts",
				kind: "read",
				locations: [{ path: "/etc/hosts" }],
			},
		},
		{
			name: "edit with file_path uses path and edit kind",
			toolName: "edit",
			args: { file_path: "/tmp/a.ts" },
			expect: {
				title: "/tmp/a.ts",
				kind: "edit",
				locations: [{ path: "/tmp/a.ts" }],
			},
		},
		{
			name: "write with path (not file_path) still populates locations",
			toolName: "write",
			args: { path: "/tmp/b.ts" },
			expect: {
				title: "/tmp/b.ts",
				kind: "edit",
				locations: [{ path: "/tmp/b.ts" }],
			},
		},
		{
			name: "grep with pattern uses pattern as title and search kind",
			toolName: "grep",
			args: { pattern: "foo.*bar" },
			expect: { title: "foo.*bar", kind: "search", locations: [] },
		},
		{
			name: "ls maps to read kind",
			toolName: "ls",
			args: { path: "/tmp" },
			expect: { title: "/tmp", kind: "read", locations: [{ path: "/tmp" }] },
		},
		{
			name: "find maps to search kind",
			toolName: "find",
			args: { pattern: "*.ts" },
			expect: { title: "*.ts", kind: "search", locations: [] },
		},
		{
			name: "web_fetch maps to fetch kind",
			toolName: "web_fetch",
			args: { url: "https://example.com" },
			expect: { title: "web_fetch", kind: "fetch", locations: [] },
		},
		{
			name: "web_search maps to search kind",
			toolName: "web_search",
			args: { query: "kimchi" },
			expect: { title: "web_search", kind: "search", locations: [] },
		},
		{
			name: "Agent maps to think kind",
			toolName: "Agent",
			args: { prompt: "go", visibility: "user" },
			expect: { title: "Agent", kind: "think", locations: [] },
		},
		{
			name: "unknown tool falls back to other kind",
			toolName: "mcp__foo__bar",
			args: { arg: 1 },
			expect: { title: "mcp__foo__bar", kind: "other", locations: [] },
		},
		{
			name: "null args is tolerated",
			toolName: "bash",
			args: null,
			expect: { title: "bash", kind: "execute", locations: [] },
		},
		{
			name: "long path title is truncated (locations keep full path)",
			toolName: "read",
			args: { file_path: longPath },
			expect: {
				title: `${longPath.slice(0, 80)}…`,
				kind: "read",
				locations: [{ path: longPath }],
			},
		},
		{
			name: "long pattern title is truncated",
			toolName: "grep",
			args: { pattern: longPattern },
			expect: {
				title: `${longPattern.slice(0, 80)}…`,
				kind: "search",
				locations: [],
			},
		},
	]

	for (const c of cases) {
		it(c.name, () => {
			const result = describeToolCall(c.toolName, c.args)
			expect(result.title).toBe(c.expect.title)
			expect(result.kind).toBe(c.expect.kind)
			expect(result.locations).toEqual(c.expect.locations)
		})
	}
})
