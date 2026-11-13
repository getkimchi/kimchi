import { Container, Spacer } from "@earendil-works/pi-tui"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	buildCurrentToolLine,
	buildGroupSummaryText,
	buildGroupView,
	classifyTool,
	computeExpandPropagation,
	decideAssistantTextFold,
	findToolGroup,
	formatSummary,
	getParent,
	isSupersededByLaterTool,
	muteAssistantLines,
	patchAddChild,
} from "./tool-grouping.js"

afterEach(() => {
	vi.useRealTimers()
})

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
	it("classifies unrecognized bash as operation", () => {
		expect(classifyTool("bash", { command: "git status" })).toBe("operation")
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
	it("formats past tense pattern singular", () => {
		expect(formatSummary(new Map([["pattern", 1]]), false)).toBe("searched for 1 pattern")
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
	it("formats continuous tense operation", () => {
		expect(formatSummary(new Map([["operation", 2]]), true)).toBe("2 operations")
	})
	it("joins multiple categories with comma", () => {
		expect(
			formatSummary(
				new Map([
					["file", 2],
					["pattern", 1],
				]),
				false,
			),
		).toBe("read 2 files, searched for 1 pattern")
	})
})

describe("patchAddChild / getParent", () => {
	it("returns undefined for a component with no parent", () => {
		patchAddChild()
		const child = new Container()
		expect(getParent(child)).toBeUndefined()
	})

	it("records parent when addChild is called", () => {
		patchAddChild()
		const parent = new Container()
		const child = new Container()
		parent.addChild(child)
		expect(getParent(child)).toBe(parent)
	})

	it("is idempotent — calling patchAddChild twice does not double-wrap", () => {
		patchAddChild()
		patchAddChild()
		const parent = new Container()
		const child = new Container()
		parent.addChild(child)
		expect(getParent(child)).toBe(parent)
	})

	it("returns the closest parent when re-added to a different container", () => {
		patchAddChild()
		const parent1 = new Container()
		const parent2 = new Container()
		const child = new Container()
		parent1.addChild(child)
		parent2.addChild(child)
		expect(getParent(child)).toBe(parent2)
	})

	it("tolerates non-object components — delegates without throwing", () => {
		// Regression test: a stale image-source reuse in upstream updateDisplay once
		// handed addChild(undefined) on --continue replay, and the WeakMap tracker
		// turned that into a fatal TypeError. Tracking must never throw.
		patchAddChild()
		const parent = new Container()
		// biome-ignore lint/suspicious/noExplicitAny: deliberately breaking the addChild contract
		expect(() => parent.addChild(undefined as any)).not.toThrow()
		// biome-ignore lint/suspicious/noExplicitAny: deliberately breaking the addChild contract
		expect(() => parent.addChild("not-a-component" as any)).not.toThrow()
	})
})

function mockTool(id: string, opts: { isPartial?: boolean; isError?: boolean } = {}): object {
	return {
		toolName: "read",
		toolCallId: id,
		args: { path: `file-${id}.ts` },
		isPartial: opts.isPartial ?? false,
		result: opts.isError ? { isError: true } : undefined,
		render: (_width: number) => [],
		invalidate: () => {},
	}
}

describe("findToolGroup", () => {
	it("returns [self] when alone in parent", () => {
		const tool = mockTool("a")
		const children = [tool]
		expect(findToolGroup(tool, children)).toEqual([tool])
	})

	it("groups two consecutive completed tools", () => {
		const a = mockTool("a")
		const b = mockTool("b")
		const children = [a, b]
		expect(findToolGroup(a, children)).toEqual([a, b])
		expect(findToolGroup(b, children)).toEqual([a, b])
	})

	it("spacers are transparent — do not break the run", () => {
		const a = mockTool("a")
		const spacer = new Spacer(1)
		const b = mockTool("b")
		const children = [a, spacer, b]
		expect(findToolGroup(a, children)).toEqual([a, b])
		expect(findToolGroup(b, children)).toEqual([a, b])
	})

	it("spacers are not included in the returned run array", () => {
		const a = mockTool("a")
		const spacer = new Spacer(1)
		const b = mockTool("b")
		const children = [a, spacer, b]
		const group = findToolGroup(a, children)
		expect(group).not.toContain(spacer)
	})

	it("non-tool, non-spacer breaks the run", () => {
		const a = mockTool("a")
		const b = mockTool("b")
		const other = { render: () => [], invalidate: () => {} }
		const c = mockTool("c")
		const children = [a, b, other, c]
		expect(findToolGroup(a, children)).toEqual([a, b])
		expect(findToolGroup(c, children)).toEqual([c])
	})

	it("failed tool joins the run — folds like other work once the agent moves on", () => {
		const a = mockTool("a")
		const b = mockTool("b", { isError: true })
		const c = mockTool("c")
		const children = [a, b, c]
		expect(findToolGroup(a, children)).toEqual([a, b, c])
		expect(findToolGroup(c, children)).toEqual([a, b, c])
	})

	it("in-progress tools are included in the run", () => {
		const a = mockTool("a")
		const b = mockTool("b", { isPartial: true })
		const children = [a, b]
		expect(findToolGroup(b, children)).toEqual([a, b])
	})

	it("returns [self] when self is not present in children", () => {
		const a = mockTool("a")
		const b = mockTool("b")
		const other = mockTool("x")
		const children = [a, b]
		expect(findToolGroup(other, children)).toEqual([other])
	})

	it("returns [self] for a failed tool not present in children", () => {
		const failed = mockTool("z", { isError: true })
		const children: object[] = []
		expect(findToolGroup(failed, children)).toEqual([failed])
	})

	it("operation tool joins the run", () => {
		const a = mockTool("a")
		const op = { toolName: "some_mcp_tool", toolCallId: "op1", args: {}, isPartial: false }
		const b = mockTool("b")
		const children = [a, op, b]
		expect(findToolGroup(a, children)).toEqual([a, op, b])
		expect(findToolGroup(b, children)).toEqual([a, op, b])
	})

	it("operation tool not in children returns [self]", () => {
		const op = { toolName: "some_mcp_tool", toolCallId: "op1", args: {}, isPartial: false }
		expect(findToolGroup(op, [])).toEqual([op])
	})

	it("assistant text between tools joins the run without being counted", () => {
		const a = mockTool("a")
		const text = { lastMessage: { role: "assistant" }, render: () => [], invalidate: () => {} }
		const b = mockTool("b")
		const children = [a, text, b]
		expect(findToolGroup(a, children)).toEqual([a, b])
	})

	it("user message breaks the run", () => {
		const a = mockTool("a")
		const userTurn = { lastMessage: { role: "user" }, render: () => [], invalidate: () => {} }
		const b = mockTool("b")
		const children = [a, userTurn, b]
		expect(findToolGroup(a, children)).toEqual([a])
		expect(findToolGroup(b, children)).toEqual([b])
	})
})

describe("isSupersededByLaterTool", () => {
	it("is true when a later tool exists, even across text and spacers", () => {
		const a = mockTool("a")
		const text = { lastMessage: { role: "assistant" } }
		const b = mockTool("b")
		const children = [a, text, new Spacer(1), b]
		expect(isSupersededByLaterTool(children, 0)).toBe(true)
	})

	it("is false for the last tool", () => {
		const a = mockTool("a")
		const b = mockTool("b")
		const children = [a, b]
		expect(isSupersededByLaterTool(children, 1)).toBe(false)
	})

	it("is false when only text follows", () => {
		const a = mockTool("a")
		const text = { lastMessage: { role: "assistant" } }
		const children = [a, text]
		expect(isSupersededByLaterTool(children, 0)).toBe(false)
	})
})

describe("decideAssistantTextFold", () => {
	it("folds text strictly between two tools of the same run", () => {
		const a = mockTool("a")
		const text = { lastMessage: { role: "assistant" } }
		const b = mockTool("b")
		const children = [a, text, b]
		const decision = decideAssistantTextFold(children, 1)
		expect(decision.fold).toBe(true)
		expect(decision.expandController).toBe(b)
	})

	it("does not fold trailing text after the last tool", () => {
		const a = mockTool("a")
		const text = { lastMessage: { role: "assistant" } }
		const children = [a, text]
		expect(decideAssistantTextFold(children, 1).fold).toBe(false)
	})

	it("does not fold leading text before any tool", () => {
		const text = { lastMessage: { role: "assistant" } }
		const b = mockTool("b")
		const children = [text, b]
		expect(decideAssistantTextFold(children, 0).fold).toBe(false)
	})

	it("does not fold across a user message", () => {
		const a = mockTool("a")
		const text = { lastMessage: { role: "assistant" } }
		const userTurn = { lastMessage: { role: "user" } }
		const b = mockTool("b")
		const children = [a, text, userTurn, b]
		expect(decideAssistantTextFold(children, 1).fold).toBe(false)
	})
})

describe("muteAssistantLines", () => {
	const FG = "\x1b[38;2;140;140;140m"

	it("wraps body text in the muted color with a default-fg reset", () => {
		expect(muteAssistantLines(["plain text"], FG)).toEqual([`${FG}plain text\x1b[39m`])
	})

	it("re-asserts the muted color after embedded markdown resets", () => {
		const line = `\x1b[1mbold\x1b[0m and default tail`
		expect(muteAssistantLines([line], FG)).toEqual([`${FG}\x1b[1mbold\x1b[0m${FG} and default tail\x1b[39m`])
	})

	it("preserves leading and trailing OSC 133 markers untouched", () => {
		const line = `\x1b]133;A\x07text\x1b]133;B\x07\x1b]133;C\x07`
		expect(muteAssistantLines([line], FG)).toEqual([`\x1b]133;A\x07${FG}text\x1b[39m\x1b]133;B\x07\x1b]133;C\x07`])
	})

	it("leaves blank lines untouched", () => {
		expect(muteAssistantLines(["", "   "], FG)).toEqual(["", "   "])
	})

	it("returns lines unchanged when no fg is available", () => {
		const lines = ["text"]
		expect(muteAssistantLines(lines, "")).toBe(lines)
	})
})

describe("computeExpandPropagation", () => {
	it("returns run members with a differing expanded flag, excluding self", () => {
		const a = { ...mockTool("a"), expanded: false }
		const b = { ...mockTool("b"), expanded: true }
		const c = { ...mockTool("c"), expanded: false }
		const run = [a, b, c]
		expect(computeExpandPropagation(run, a, true)).toEqual([c])
		expect(computeExpandPropagation(run, a, false)).toEqual([b])
	})

	it("returns nothing for a run of one", () => {
		const a = { ...mockTool("a"), expanded: false }
		expect(computeExpandPropagation([a], a, true)).toEqual([])
	})
})

function mockToolFull(toolName: string, args: Record<string, unknown>, opts: { isPartial?: boolean } = {}): object {
	return {
		toolName,
		toolCallId: Math.random().toString(36),
		args,
		isPartial: opts.isPartial ?? false,
		result: undefined,
		render: (_width: number) => [],
		invalidate: () => {},
	}
}

describe("buildGroupSummaryText", () => {
	it("aggregates by category, first-appearance order", () => {
		const run = [
			mockToolFull("read", { path: "a.ts" }),
			mockToolFull("bash", { command: "ls src/" }),
			mockToolFull("read", { path: "b.ts" }),
			mockToolFull("grep", { pattern: "foo" }),
		]
		expect(buildGroupSummaryText(run, false)).toBe("read 2 files, listed 1 directory, searched for 1 pattern")
	})

	it("uses continuous tense when isInProgress is true", () => {
		const run = [mockToolFull("read", { path: "a.ts" }), mockToolFull("bash", { command: "ls src/" })]
		expect(buildGroupSummaryText(run, true)).toBe("reading 1 file, listing 1 directory")
	})
})

describe("buildCurrentToolLine", () => {
	it("bash tool shows $ prefix with command", () => {
		const tool = mockToolFull("bash", { command: "git diff HEAD~1" })
		expect(buildCurrentToolLine(tool)).toBe("$ git diff HEAD~1")
	})

	it("bash command truncated to 60 chars", () => {
		const long = "x".repeat(80)
		const tool = mockToolFull("bash", { command: long })
		const line = buildCurrentToolLine(tool)
		expect(line.startsWith("$ ")).toBe(true)
		expect(line.length).toBeLessThanOrEqual(62) // "$ " + 60
	})

	it("read tool shows reading prefix with path", () => {
		const tool = mockToolFull("read", { path: "src/foo.ts" })
		expect(buildCurrentToolLine(tool)).toBe("reading src/foo.ts")
	})

	it("grep tool shows searching prefix with pattern", () => {
		const tool = mockToolFull("grep", { pattern: "TODO" })
		expect(buildCurrentToolLine(tool)).toBe('searching "TODO"')
	})

	it("ls tool shows ls prefix with path", () => {
		const tool = mockToolFull("ls", { path: "src/" })
		expect(buildCurrentToolLine(tool)).toBe("ls src/")
	})

	it("ls tool defaults to . when no path", () => {
		const tool = mockToolFull("ls", {})
		expect(buildCurrentToolLine(tool)).toBe("ls .")
	})

	it("unknown tool shows toolName …", () => {
		const tool = mockToolFull("some_mcp_tool", {})
		expect(buildCurrentToolLine(tool)).toBe("some_mcp_tool …")
	})
})

describe("buildGroupView", () => {
	const plainTheme = {
		fg: (_key: string, value: string) => value,
	}

	it("appends timer to right header when a tool is in-progress", () => {
		const now = new Date("2026-01-01T00:00:05.000Z")
		vi.useFakeTimers()
		vi.setSystemTime(now)
		const run = [mockToolFull("read", { path: "a.ts" }), mockToolFull("read", { path: "b.ts" }, { isPartial: true })]
		// biome-ignore lint/suspicious/noExplicitAny: mock property access
		;(run[1] as any).rendererState = { _executionStartedAt: now.getTime() - 5000 }
		const view = buildGroupView(run, plainTheme)
		const lines = view.render(120)
		const headerLine = lines[0]
		expect(headerLine).toContain("ctrl+o to expand")
		expect(headerLine).toContain("5.0s")
	})

	it("appends timer for sub-second elapsed", () => {
		const now = new Date("2026-01-01T00:00:00.500Z")
		vi.useFakeTimers()
		vi.setSystemTime(now)
		const run = [mockToolFull("read", { path: "a.ts" }, { isPartial: true })]
		// biome-ignore lint/suspicious/noExplicitAny: mock property access
		;(run[0] as any).rendererState = { _executionStartedAt: now.getTime() - 500 }
		const view = buildGroupView(run, plainTheme)
		const lines = view.render(120)
		const headerLine = lines[0]
		expect(headerLine).toContain("ctrl+o to expand")
		expect(headerLine).toContain("500ms")
	})

	it("appends timer for completed groups", () => {
		const run = [mockToolFull("read", { path: "a.ts" }), mockToolFull("read", { path: "b.ts" })]
		// biome-ignore lint/suspicious/noExplicitAny: mock property access
		;(run[1] as any).rendererState = { _executionStartedAt: Date.now() - 5000, _executionEndedAt: Date.now() }
		const view = buildGroupView(run, plainTheme)
		const lines = view.render(120)
		const headerLine = lines[0]
		expect(headerLine).toContain("ctrl+o to expand")
		expect(headerLine).toContain("5.0s")
	})

	it("shows 'Worked for' duration, counts, and failed count when completed", () => {
		const run = [mockToolFull("read", { path: "a.ts" }), mockTool("b", { isError: true })]
		// biome-ignore lint/suspicious/noExplicitAny: mock property access
		;(run[0] as any).rendererState = { _executionStartedAt: Date.now() - 5000, _executionEndedAt: Date.now() }
		const view = buildGroupView(run, plainTheme)
		const headerLine = view.render(120)[0]
		expect(headerLine).toContain("Worked for 5.0s")
		expect(headerLine).toContain("read 2 files")
		expect(headerLine).toContain("1 failed")
	})

	it("shows 'Working…' with duration while in progress", () => {
		const now = new Date("2026-01-01T00:00:05.000Z")
		vi.useFakeTimers()
		vi.setSystemTime(now)
		const run = [
			mockToolFull("read", { path: "a.ts" }),
			mockToolFull("bash", { command: "cargo build" }, { isPartial: true }),
		]
		// biome-ignore lint/suspicious/noExplicitAny: mock property access
		;(run[1] as any).rendererState = { _executionStartedAt: now.getTime() - 5000 }
		const view = buildGroupView(run, plainTheme)
		const headerLine = view.render(120)[0]
		expect(headerLine).toContain("Working…")
		expect(headerLine).toContain("5.0s")
		expect(headerLine).toContain("ctrl+o to expand")
	})

	it("falls back to counts-only when no timestamps are available", () => {
		const run = [mockToolFull("read", { path: "a.ts" }), mockToolFull("read", { path: "b.ts" })]
		const view = buildGroupView(run, plainTheme)
		const headerLine = view.render(120)[0]
		expect(headerLine).toContain("Worked")
		expect(headerLine).toContain("read 2 files")
	})
})
