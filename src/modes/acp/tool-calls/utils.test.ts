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
			name: "web_fetch maps to fetch kind with url title",
			toolName: "web_fetch",
			args: { url: "https://example.com" },
			expect: { title: "https://example.com", kind: "fetch", locations: [] },
		},
		{
			name: "web_search maps to search kind with query title",
			toolName: "web_search",
			args: { query: "kimchi" },
			expect: { title: "kimchi", kind: "search", locations: [] },
		},
		{
			name: "Agent maps to think kind with description title",
			toolName: "Agent",
			args: { description: "scan codebase", prompt: "go", visibility: "user" },
			expect: { title: "scan codebase", kind: "think", locations: [] },
		},
		{
			name: "Agent without description falls back to tool name",
			toolName: "Agent",
			args: { prompt: "go", visibility: "user" },
			expect: { title: "Agent", kind: "think", locations: [] },
		},
		{
			name: "non-file tool with a path argument keeps the tool name as title but reports locations",
			toolName: "lsp_definition",
			args: { file_path: "/src/main.ts", line: 10, character: 5 },
			expect: { title: "lsp_definition", kind: "other", locations: [{ path: "/src/main.ts" }] },
		},
		{
			name: "non-file tool with a command argument keeps the tool name as title",
			toolName: "daemon",
			args: { command: "pnpm dev" },
			expect: { title: "daemon", kind: "other", locations: [] },
		},
		{
			name: "kind-other tool with a query argument (memory_search) keeps the tool name as title",
			toolName: "memory_search",
			args: { query: "auth" },
			expect: { title: "memory_search", kind: "other", locations: [] },
		},
		{
			name: "unmapped tool with a pattern argument keeps the tool name as title",
			toolName: "mcp__github__search",
			args: { pattern: "*.md" },
			expect: { title: "mcp__github__search", kind: "other", locations: [] },
		},
		{
			name: "bash_control (handle/action args) falls back to tool name",
			toolName: "bash_control",
			args: { handle: "abc123", action: "stop" },
			expect: { title: "bash_control", kind: "other", locations: [] },
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
			expect(describeToolCall(c.toolName, c.args)).toEqual(c.expect)
		})
	}
})

// Full ACP SessionUpdate shape per tool — realistic argument payloads as the
// model actually emits them (see the tool schemas in pi-coding-agent's
// core/tools and src/extensions/*), asserted with exact equality so a
// schema change on either side fails loudly.
describe("buildToolCall per-tool ACP shape", () => {
	const cases: Array<{
		toolName: string
		rawInput: Record<string, unknown>
		expect: Record<string, unknown>
	}> = [
		{
			toolName: "bash",
			rawInput: { command: "pnpm run build", timeout: 120 },
			expect: {
				sessionUpdate: "tool_call",
				toolCallId: "kt.bash.0",
				status: "pending",
				title: "pnpm run build",
				kind: "execute",
				locations: [],
				rawInput: { command: "pnpm run build", timeout: 120 },
				_meta: { piToolCallId: "tc-1" },
			},
		},
		{
			toolName: "powershell",
			rawInput: { command: "Get-ChildItem" },
			expect: {
				sessionUpdate: "tool_call",
				toolCallId: "kt.powershell.0",
				status: "pending",
				title: "Get-ChildItem",
				kind: "execute",
				locations: [],
				rawInput: { command: "Get-ChildItem" },
				_meta: { piToolCallId: "tc-1" },
			},
		},
		{
			toolName: "read",
			rawInput: { path: "/src/main.ts", offset: 10, limit: 40 },
			expect: {
				sessionUpdate: "tool_call",
				toolCallId: "kt.read.0",
				status: "pending",
				title: "/src/main.ts",
				kind: "read",
				locations: [{ path: "/src/main.ts" }],
				rawInput: { path: "/src/main.ts", offset: 10, limit: 40 },
				_meta: { piToolCallId: "tc-1" },
			},
		},
		{
			toolName: "edit",
			rawInput: { path: "/src/a.ts", oldText: "a", newText: "b" },
			expect: {
				sessionUpdate: "tool_call",
				toolCallId: "kt.edit.0",
				status: "pending",
				title: "/src/a.ts",
				kind: "edit",
				locations: [{ path: "/src/a.ts" }],
				rawInput: { path: "/src/a.ts", oldText: "a", newText: "b" },
				_meta: { piToolCallId: "tc-1" },
			},
		},
		{
			toolName: "write",
			rawInput: { path: "/tmp/new.ts", content: "export {}" },
			expect: {
				sessionUpdate: "tool_call",
				toolCallId: "kt.write.0",
				status: "pending",
				title: "/tmp/new.ts",
				kind: "edit",
				locations: [{ path: "/tmp/new.ts" }],
				rawInput: { path: "/tmp/new.ts", content: "export {}" },
				_meta: { piToolCallId: "tc-1" },
			},
		},
		{
			toolName: "ls",
			rawInput: { path: "/src", limit: 100 },
			expect: {
				sessionUpdate: "tool_call",
				toolCallId: "kt.ls.0",
				status: "pending",
				title: "/src",
				kind: "read",
				locations: [{ path: "/src" }],
				rawInput: { path: "/src", limit: 100 },
				_meta: { piToolCallId: "tc-1" },
			},
		},
		{
			toolName: "grep",
			rawInput: { pattern: "foo", path: "/src", glob: "*.ts", context: 2 },
			expect: {
				sessionUpdate: "tool_call",
				toolCallId: "kt.grep.0",
				status: "pending",
				title: "foo",
				kind: "search",
				locations: [{ path: "/src" }],
				rawInput: { pattern: "foo", path: "/src", glob: "*.ts", context: 2 },
				_meta: { piToolCallId: "tc-1" },
			},
		},
		{
			toolName: "find",
			rawInput: { pattern: "*.spec.ts", path: "/packages" },
			expect: {
				sessionUpdate: "tool_call",
				toolCallId: "kt.find.0",
				status: "pending",
				title: "*.spec.ts",
				kind: "search",
				locations: [{ path: "/packages" }],
				rawInput: { pattern: "*.spec.ts", path: "/packages" },
				_meta: { piToolCallId: "tc-1" },
			},
		},
		{
			toolName: "web_fetch",
			rawInput: { url: "https://example.com/docs", format: "markdown", timeout: 30 },
			expect: {
				sessionUpdate: "tool_call",
				toolCallId: "kt.web_fetch.0",
				status: "pending",
				title: "https://example.com/docs",
				kind: "fetch",
				locations: [],
				rawInput: { url: "https://example.com/docs", format: "markdown", timeout: 30 },
				_meta: { piToolCallId: "tc-1" },
			},
		},
		{
			toolName: "web_search",
			rawInput: { query: "ACP tool call spec", recency: "month", limit: 5 },
			expect: {
				sessionUpdate: "tool_call",
				toolCallId: "kt.web_search.0",
				status: "pending",
				title: "ACP tool call spec",
				kind: "search",
				locations: [],
				rawInput: { query: "ACP tool call spec", recency: "month", limit: 5 },
				_meta: { piToolCallId: "tc-1" },
			},
		},
		{
			toolName: "memory_search",
			rawInput: { query: "preferred editor" },
			expect: {
				sessionUpdate: "tool_call",
				toolCallId: "kt.memory_search.0",
				status: "pending",
				title: "memory_search",
				kind: "other",
				locations: [],
				rawInput: { query: "preferred editor" },
				_meta: { piToolCallId: "tc-1" },
			},
		},
		{
			toolName: "Agent",
			rawInput: { description: "scan codebase", prompt: "find TODOs", subagent_type: "Explore" },
			expect: {
				sessionUpdate: "tool_call",
				toolCallId: "kt.Agent.0",
				status: "pending",
				title: "scan codebase",
				kind: "think",
				locations: [],
				rawInput: { description: "scan codebase", prompt: "find TODOs", subagent_type: "Explore" },
				_meta: { piToolCallId: "tc-1" },
			},
		},
		{
			toolName: "bash_control",
			rawInput: { handle: "abc123", action: "stop" },
			expect: {
				sessionUpdate: "tool_call",
				toolCallId: "kt.bash_control.0",
				status: "pending",
				title: "bash_control",
				kind: "other",
				locations: [],
				rawInput: { handle: "abc123", action: "stop" },
				_meta: { piToolCallId: "tc-1" },
			},
		},
		{
			toolName: "daemon",
			rawInput: { command: "pnpm dev" },
			expect: {
				sessionUpdate: "tool_call",
				toolCallId: "kt.daemon.0",
				status: "pending",
				title: "daemon",
				kind: "other",
				locations: [],
				rawInput: { command: "pnpm dev" },
				_meta: { piToolCallId: "tc-1" },
			},
		},
		{
			toolName: "lsp_definition",
			rawInput: { file_path: "/src/main.ts", line: 10, character: 5 },
			expect: {
				sessionUpdate: "tool_call",
				toolCallId: "kt.lsp_definition.0",
				status: "pending",
				title: "lsp_definition",
				kind: "other",
				locations: [{ path: "/src/main.ts" }],
				rawInput: { file_path: "/src/main.ts", line: 10, character: 5 },
				_meta: { piToolCallId: "tc-1" },
			},
		},
		{
			toolName: "mcp__github__create_issue",
			rawInput: { path: "README.md", title: "bug" },
			expect: {
				sessionUpdate: "tool_call",
				toolCallId: "kt.mcp__github__create_issue.0",
				status: "pending",
				title: "mcp__github__create_issue",
				kind: "other",
				locations: [{ path: "README.md" }],
				rawInput: { path: "README.md", title: "bug" },
				_meta: { piToolCallId: "tc-1" },
			},
		},
	]

	for (const c of cases) {
		it(`maps ${c.toolName} to the full ACP tool_call shape`, () => {
			const result = buildToolCall({
				toolName: c.toolName,
				toolCallId: `kt.${c.toolName}.0`,
				piToolCallId: "tc-1",
				status: "pending",
				rawInput: c.rawInput,
			})
			expect(result).toEqual(c.expect)
		})
	}
})
