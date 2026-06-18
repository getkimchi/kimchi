import { type Theme, ToolExecutionComponent, UserMessageComponent, initTheme } from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"
import { beforeAll, describe, expect, it } from "vitest"
import {
	formatToolTimer,
	getToolElapsedMs,
	isMcpToolName,
	mcpCallLabelAndSummary,
	patchToolRenderCacheInvalidation,
	patchUserMessageRender,
	splitLeadingOsc133Markers,
	summarizeMcpToolInvocationArgs,
	summarizeOpenAiToolCall,
	toolHeader,
} from "./tool-rendering.js"

const OSC133_A = "\x1b]133;A\x07"
const OSC133_B = "\x1b]133;B\x07"
const OSC133_C = "\x1b]133;C\x07"
const SGR_RE = new RegExp(`${"\x1b"}\\[[0-9;]*m`, "g")

const stripSgr = (line: string): string => line.replace(SGR_RE, "")
const plainTheme = {
	fg: (_name: string, value: string) => value,
	bold: (value: string) => value,
} as unknown as Theme

describe("user message render patch", () => {
	beforeAll(() => {
		initTheme("default")
		patchUserMessageRender()
	})

	it("splits all leading OSC 133 markers from one-line user messages", () => {
		const line = `${OSC133_B}${OSC133_C}${OSC133_A}hello`

		expect(splitLeadingOsc133Markers(line)).toEqual({
			markers: `${OSC133_B}${OSC133_C}${OSC133_A}`,
			rest: "hello",
		})
	})

	it("keeps OSC 133 markers before the visible prompt prefix", () => {
		const lines = new UserMessageComponent("do we have unpushed commits?").render(80)

		expect(lines).toHaveLength(1)
		const { markers, rest } = splitLeadingOsc133Markers(lines[0])
		expect(markers).toBe(`${OSC133_B}${OSC133_C}${OSC133_A}`)
		expect(stripSgr(rest).startsWith(" ❯ do we have unpushed commits?")).toBe(true)
		expect(visibleWidth(lines[0])).toBe(80)
	})

	it("summarizes questionnaire calls from prompt fields", () => {
		const summary = summarizeOpenAiToolCall(
			"questionnaire",
			{ questions: [{ prompt: "Which improvement areas should this ferment include?" }] },
			plainTheme,
			(path) => path,
		)

		expect(summary).toBe("Which improvement areas should this ferment include?")
	})

	it("renders Skill tool with skill name when skill arg is provided", () => {
		const summary = summarizeOpenAiToolCall("Skill", { skill: "writing-plans" }, plainTheme, (path) => path)
		expect(summary).toBe("writing-plans")
	})

	it("renders Skill tool with name arg as primary", () => {
		const summary = summarizeOpenAiToolCall("Skill", { name: "test-skill" }, plainTheme, (path) => path)
		expect(summary).toBe("test-skill")
	})

	it("renders Skill tool with fallback when no name or skill arg", () => {
		const summary = summarizeOpenAiToolCall("Skill", {}, plainTheme, (path) => path)
		expect(summary).toBe("run skill")
	})
})

describe("execution timestamp tracking", () => {
	beforeAll(() => {
		patchToolRenderCacheInvalidation()
	})

	function createMockComponent(): ToolExecutionComponent {
		return new ToolExecutionComponent(
			"bash",
			"tc-1",
			{ command: "sleep 1" },
			{},
			undefined,
			// biome-ignore lint/suspicious/noExplicitAny: mock property access
			{ requestRender: () => {} } as any,
			"/tmp",
		)
	}

	it("records _executionStartedAt when markExecutionStarted is called", () => {
		const component = createMockComponent()
		// biome-ignore lint/suspicious/noExplicitAny: mock property access
		expect((component as any).rendererState._executionStartedAt).toBeUndefined()
		component.markExecutionStarted()
		// biome-ignore lint/suspicious/noExplicitAny: mock property access
		expect(typeof (component as any).rendererState._executionStartedAt).toBe("number")
	})

	it("records _executionEndedAt when updateResult is called with isPartial=false", () => {
		const component = createMockComponent()
		component.markExecutionStarted()
		// biome-ignore lint/suspicious/noExplicitAny: mock property access
		expect((component as any).rendererState._executionEndedAt).toBeUndefined()
		component.updateResult({ content: [], isError: false }, false)
		// biome-ignore lint/suspicious/noExplicitAny: mock property access
		expect(typeof (component as any).rendererState._executionEndedAt).toBe("number")
	})

	it("does not overwrite _executionStartedAt on duplicate calls", () => {
		const component = createMockComponent()
		component.markExecutionStarted()
		// biome-ignore lint/suspicious/noExplicitAny: mock property access
		const first = (component as any).rendererState._executionStartedAt
		component.markExecutionStarted()
		// biome-ignore lint/suspicious/noExplicitAny: mock property access
		expect((component as any).rendererState._executionStartedAt).toBe(first)
	})

	it("records _executionEndedAt when updateResult is called with one argument (default isPartial=false)", () => {
		const component = createMockComponent()
		component.markExecutionStarted()
		// biome-ignore lint/suspicious/noExplicitAny: mock property access
		expect((component as any).rendererState._executionEndedAt).toBeUndefined()
		component.updateResult({ content: [], isError: false })
		// biome-ignore lint/suspicious/noExplicitAny: mock property access
		expect(typeof (component as any).rendererState._executionEndedAt).toBe("number")
	})

	it("does not record _executionEndedAt when isPartial is true", () => {
		const component = createMockComponent()
		component.markExecutionStarted()
		component.updateResult({ content: [], isError: false }, true)
		// biome-ignore lint/suspicious/noExplicitAny: mock property access
		expect((component as any).rendererState._executionEndedAt).toBeUndefined()
	})
})

describe("elapsed time helpers", () => {
	it("returns 0 when no timestamps exist", () => {
		expect(getToolElapsedMs({ state: {} })).toBe(0)
		expect(getToolElapsedMs({})).toBe(0)
		expect(getToolElapsedMs(null)).toBe(0)
	})

	it("returns elapsed time for a running tool (no end timestamp)", () => {
		const startedAt = Date.now() - 5000
		const elapsed = getToolElapsedMs({ state: { _executionStartedAt: startedAt } })
		expect(elapsed).toBeGreaterThanOrEqual(5000)
		expect(elapsed).toBeLessThan(6000)
	})

	it("returns exact elapsed time for a completed tool", () => {
		const startedAt = 1000
		const endedAt = 3500
		const elapsed = getToolElapsedMs({ state: { _executionStartedAt: startedAt, _executionEndedAt: endedAt } })
		expect(elapsed).toBe(2500)
	})

	it("formatToolTimer returns undefined at zero or negative elapsed", () => {
		expect(formatToolTimer(0)).toBeUndefined()
		expect(formatToolTimer(-1)).toBeUndefined()
	})

	it("formatToolTimer returns formatted duration for any positive elapsed", () => {
		expect(formatToolTimer(500)).toBe("500ms")
		expect(formatToolTimer(1000)).toBe("1.0s")
		expect(formatToolTimer(12345)).toBe("12.3s")
		expect(formatToolTimer(120000)).toBe("120.0s")
	})
})

describe("toolHeader", () => {
	it("renders header with tool name and summary", () => {
		const header = toolHeader("Read", "src/foo.ts", plainTheme, "○ ")
		expect(header).toContain("Read")
		expect(header).toContain("src/foo.ts")
	})

	it("appends timer when timer is provided", () => {
		const header = toolHeader("Read", "src/foo.ts", plainTheme, "○ ", "1.5s")
		expect(header).toContain("Read")
		expect(header).toContain("src/foo.ts")
		expect(header).toContain("1.5s")
	})

	it("omits timer when timer is undefined", () => {
		const headerWith = toolHeader("Read", "src/foo.ts", plainTheme, "○ ", "1.5s")
		const headerWithout = toolHeader("Read", "src/foo.ts", plainTheme, "○ ")
		expect(headerWithout).not.toContain("1.5s")
		expect(headerWith).toContain("1.5s")
	})
})

describe("isMcpToolName", () => {
	it('returns true for bare "mcp"', () => {
		expect(isMcpToolName("mcp")).toBe(true)
	})

	it("returns true for mcp_ prefixed names", () => {
		expect(isMcpToolName("mcp_pal_chat")).toBe(true)
	})

	it("returns true for mcp- prefixed names", () => {
		expect(isMcpToolName("mcp-search")).toBe(true)
	})

	it("returns true for mcp: prefixed names", () => {
		expect(isMcpToolName("mcp:tool")).toBe(true)
	})

	it("returns true for names containing _mcp_", () => {
		expect(isMcpToolName("foo_mcp_bar")).toBe(true)
	})

	it("returns false for non-mcp tool names", () => {
		expect(isMcpToolName("read")).toBe(false)
		expect(isMcpToolName("bash")).toBe(false)
		expect(isMcpToolName("write")).toBe(false)
	})

	it("returns false for empty string", () => {
		expect(isMcpToolName("")).toBe(false)
	})

	it("returns false for mcp as substring without separator (mcptool)", () => {
		expect(isMcpToolName("mcptool")).toBe(false)
	})

	it("returns true for MCP_ prefix (case-insensitive)", () => {
		expect(isMcpToolName("MCP_tool")).toBe(true)
	})
})

describe("summarizeMcpToolInvocationArgs", () => {
	it("returns empty string when args field is missing", () => {
		expect(summarizeMcpToolInvocationArgs({})).toBe("")
	})

	it("returns empty string when args field is not valid JSON", () => {
		expect(summarizeMcpToolInvocationArgs({ args: "not json" })).toBe("")
	})

	it("returns empty string when parsed args is an array", () => {
		expect(summarizeMcpToolInvocationArgs({ args: '["a","b"]' })).toBe("")
	})

	it("formats simple key=value pairs", () => {
		expect(summarizeMcpToolInvocationArgs({ args: '{"model":"gpt-4","temperature":0.7}' })).toBe(
			"(model=gpt-4, temperature=0.7)",
		)
	})

	it("truncates long values in collapsed mode", () => {
		const longVal = "a".repeat(100)
		const result = summarizeMcpToolInvocationArgs({ args: JSON.stringify({ prompt: longVal }) })
		expect(result.length).toBeLessThan(longVal.length + 20)
		expect(result.startsWith("(prompt=")).toBe(true)
	})

	it("shows full values in expanded mode", () => {
		const longVal = "a".repeat(100)
		const result = summarizeMcpToolInvocationArgs({ args: JSON.stringify({ prompt: longVal }) }, true)
		expect(result).toBe(`(prompt=${longVal})`)
	})

	it("skips null and undefined values", () => {
		expect(summarizeMcpToolInvocationArgs({ args: '{"a":null,"b":"hello"}' })).toBe("(b=hello)")
	})

	it("skips empty arrays", () => {
		expect(summarizeMcpToolInvocationArgs({ args: '{"tags":[],"name":"foo"}' })).toBe("(name=foo)")
	})

	it("skips nested objects", () => {
		expect(summarizeMcpToolInvocationArgs({ args: '{"a":{"nested":1},"b":"hi"}' })).toBe("(b=hi)")
	})

	it("formats arrays as first-elem +N in collapsed mode", () => {
		expect(summarizeMcpToolInvocationArgs({ args: '{"tags":["foo","bar","baz"]}' })).toBe("(tags=foo +2)")
	})

	it("formats arrays as comma-joined in expanded mode", () => {
		expect(summarizeMcpToolInvocationArgs({ args: '{"tags":["foo","bar","baz"]}' }, true)).toBe("(tags=foo, bar, baz)")
	})

	it("caps total suffix at 120 chars in collapsed mode", () => {
		const manyKeys: Record<string, string> = {}
		for (let i = 0; i < 20; i++) manyKeys[`key${i}`] = "val".repeat(5)
		const result = summarizeMcpToolInvocationArgs({ args: JSON.stringify(manyKeys) })
		const inner = result.slice(1, -1)
		expect(inner.length).toBeLessThanOrEqual(120)
	})
})

describe("mcpCallLabelAndSummary", () => {
	it("returns humanized tool label for tool invocations", () => {
		const result = mcpCallLabelAndSummary({ tool: "pal_chat" }, plainTheme)
		expect(result.label).toBe("pal chat")
	})

	it("prefixes label with server name when server is present", () => {
		const result = mcpCallLabelAndSummary({ tool: "pal_chat", server: "pal" }, plainTheme)
		expect(result.label).toBe("pal - pal chat")
	})

	it("includes args summary in summary for tool invocations", () => {
		const result = mcpCallLabelAndSummary({ tool: "pal_chat", args: '{"model":"gpt-4"}' }, plainTheme)
		expect(result.summary).toBe("(model=gpt-4)")
	})

	it('returns "Tool search" label for search calls', () => {
		const result = mcpCallLabelAndSummary({ search: "pal chat" }, plainTheme)
		expect(result.label).toBe("Tool search")
		expect(result.summary).toBe("(query=pal chat)")
	})

	it('returns "Tool search" label for server calls', () => {
		const result = mcpCallLabelAndSummary({ server: "pal" }, plainTheme)
		expect(result.label).toBe("Tool search")
		expect(result.summary).toBe("(server=pal)")
	})

	it('returns "Tool describe" label for describe calls', () => {
		const result = mcpCallLabelAndSummary({ describe: "pal_chat" }, plainTheme)
		expect(result.label).toBe("Tool describe")
		expect(result.summary).toBe("(tool=pal_chat)")
	})

	it('returns "Tool connect" label for connect calls', () => {
		const result = mcpCallLabelAndSummary({ connect: "my-server" }, plainTheme)
		expect(result.label).toBe("Tool connect")
		expect(result.summary).toBe("(server=my-server)")
	})

	it('returns "Tool action" label for action calls', () => {
		const result = mcpCallLabelAndSummary({ action: "restart" }, plainTheme)
		expect(result.label).toBe("Tool action")
		expect(result.summary).toBe("(action=restart)")
	})

	it('falls back to "MCP" label for empty args', () => {
		const result = mcpCallLabelAndSummary({}, plainTheme)
		expect(result.label).toBe("MCP")
		expect(result.summary).toBe("(status)")
	})

	it("shows full arg values in expanded mode", () => {
		const longVal = "x".repeat(100)
		const result = mcpCallLabelAndSummary(
			{ tool: "pal_chat", args: JSON.stringify({ prompt: longVal }) },
			plainTheme,
			true,
		)
		expect(result.summary).toContain(longVal)
	})
})

describe("set_phase tool summary", () => {
	it("summarizes set_phase calls with the phase value", () => {
		const summary = summarizeOpenAiToolCall("set_phase", { phase: "plan" }, plainTheme, (path) => path)
		expect(summary).toBe("plan")
	})

	it("summarizes set_phase calls with unknown phase fallback", () => {
		const summary = summarizeOpenAiToolCall("set_phase", {}, plainTheme, (path) => path)
		expect(summary).toBe("set phase")
	})
})
