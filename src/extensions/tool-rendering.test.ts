import { type Theme, ToolExecutionComponent, UserMessageComponent, initTheme } from "@earendil-works/pi-coding-agent"
import { visibleWidth } from "@earendil-works/pi-tui"
import { beforeAll, describe, expect, it } from "vitest"
import {
	formatToolTimer,
	getToolElapsedMs,
	patchToolRenderCacheInvalidation,
	patchUserMessageRender,
	splitLeadingOsc133Markers,
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
