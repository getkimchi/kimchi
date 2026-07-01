import { Container, Spacer } from "@earendil-works/pi-tui"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	buildCurrentToolLine,
	buildGroupSummaryText,
	buildGroupView,
	classifyTool,
	describeTool,
	findToolGroup,
	formatSummary,
	getParent,
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
	it("classifies write as operation", () => {
		expect(classifyTool("write", { file_path: "foo.ts" })).toBe("operation")
	})
	it("classifies edit as operation", () => {
		expect(classifyTool("edit", { file_path: "foo.ts" })).toBe("operation")
	})
	it("classifies multiedit as operation", () => {
		expect(classifyTool("multiedit", {})).toBe("operation")
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
	it("classifies unrecognized bash as command", () => {
		expect(classifyTool("bash", { command: "git status" })).toBe("command")
	})
	it("classifies git commit bash as command", () => {
		expect(classifyTool("bash", { command: "git commit -m foo" })).toBe("command")
	})
	it("classifies rtk grep as pattern", () => {
		expect(classifyTool("bash", { command: 'rtk grep -n "foo" src/' })).toBe("pattern")
	})
	it("classifies rtk read as file", () => {
		expect(classifyTool("bash", { command: "rtk read src/foo.ts" })).toBe("file")
	})
	it("classifies rtk with unrecognized subcommand as command", () => {
		expect(classifyTool("bash", { command: "rtk git status" })).toBe("command")
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

	it("failed tool (isError) breaks the run — excluded from group", () => {
		const a = mockTool("a")
		const b = mockTool("b", { isError: true })
		const c = mockTool("c")
		const children = [a, b, c]
		expect(findToolGroup(a, children)).toEqual([a])
		expect(findToolGroup(c, children)).toEqual([c])
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

	it("returns [] when self is a failed tool not present in children", () => {
		const failed = mockTool("z", { isError: true })
		const children: object[] = []
		expect(findToolGroup(failed, children)).toEqual([])
	})

	it("operation tool breaks the run and renders on its own", () => {
		const a = mockTool("a")
		const op = { toolName: "some_mcp_tool", toolCallId: "op1", args: {}, isPartial: false }
		const b = mockTool("b")
		const children = [a, op, b]
		expect(findToolGroup(a, children)).toEqual([a])
		expect(findToolGroup(b, children)).toEqual([b])
	})

	it("operation tool not in children returns []", () => {
		const op = { toolName: "some_mcp_tool", toolCallId: "op1", args: {}, isPartial: false }
		expect(findToolGroup(op, [])).toEqual([])
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

function mockBashResult(command: string, stdout: string, opts: { isPartial?: boolean } = {}): object {
	return {
		toolName: "bash",
		toolCallId: Math.random().toString(36),
		args: { command },
		isPartial: opts.isPartial ?? false,
		result: { isError: false, content: [{ type: "text", text: stdout }] },
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

	it("emits describable segment after flushing preceding counts", () => {
		const run = [
			mockToolFull("read", { path: "a.ts" }),
			mockToolFull("read", { path: "b.ts" }),
			mockBashResult("git commit -m foo", "[main abc1234] foo\n 1 file changed"),
		]
		expect(buildGroupSummaryText(run, false)).toBe("read 2 files, committed abc1234")
	})

	it("emits describable segment before following counts", () => {
		const run = [mockBashResult("git commit -m foo", "[main abc1234] foo"), mockToolFull("read", { path: "a.ts" })]
		expect(buildGroupSummaryText(run, false)).toBe("committed abc1234, read 1 file")
	})

	it("flushes between two describable segments", () => {
		const run = [
			mockToolFull("read", { path: "a.ts" }),
			mockBashResult("git commit -m foo", "[main abc1234] foo"),
			mockToolFull("read", { path: "b.ts" }),
		]
		expect(buildGroupSummaryText(run, false)).toBe("read 1 file, committed abc1234, read 1 file")
	})

	it("emits multiple describable segments consecutively", () => {
		const run = [
			mockBashResult("git commit -m foo", "[main abc1234] foo"),
			mockBashResult("git push", "   0001111..def5678  main -> origin/main"),
		]
		expect(buildGroupSummaryText(run, false)).toBe("committed abc1234, pushed def5678")
	})

	it("aggregates count-based tools between describable segments", () => {
		const run = [
			mockToolFull("ls", { path: "x" }),
			mockBashResult("git commit -m foo", "[main abc1234] foo"),
			mockBashResult("git push", "   0001111..def5678  main -> origin/main"),
			mockToolFull("ls", { path: "y" }),
		]
		expect(buildGroupSummaryText(run, false)).toBe(
			"listed 1 directory, committed abc1234, pushed def5678, listed 1 directory",
		)
	})

	it("aggregates in-progress describable tools as commands", () => {
		const run = [mockBashResult("git commit -m foo", "[main abc1234] foo", { isPartial: true })]
		expect(buildGroupSummaryText(run, true)).toBe("running 1 command")
	})

	it("renders a single describable tool as a lone segment", () => {
		const run = [mockBashResult("git commit -m foo", "[main abc1234] foo")]
		expect(buildGroupSummaryText(run, false)).toBe("committed abc1234")
	})

	it("renders a single non-describable tool as a count segment", () => {
		const run = [mockToolFull("read", { path: "a.ts" })]
		expect(buildGroupSummaryText(run, false)).toBe("read 1 file")
	})

	it("renders a single generic bash command as 'ran 1 command'", () => {
		const run = [mockToolFull("bash", { command: "echo hello" })]
		expect(buildGroupSummaryText(run, false)).toBe("ran 1 command")
	})

	it("renders a single in-progress generic bash command as 'running 1 command'", () => {
		const run = [mockToolFull("bash", { command: "echo hello" }, { isPartial: true })]
		expect(buildGroupSummaryText(run, true)).toBe("running 1 command")
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

function makeBashTool(command: string, opts: { isPartial?: boolean; stdout?: string; isError?: boolean } = {}): object {
	const result =
		opts.stdout !== undefined || opts.isError
			? { isError: opts.isError ?? false, content: [{ type: "text", text: opts.stdout ?? "" }] }
			: undefined
	return {
		toolName: "bash",
		toolCallId: "call_1",
		isPartial: opts.isPartial ?? false,
		args: { command },
		...(result ? { result } : {}),
	}
}

describe("describeTool", () => {
	it("returns undefined for in-progress tools", () => {
		expect(describeTool(makeBashTool("git commit -m foo", { isPartial: true }))).toBeUndefined()
	})

	it("returns undefined for tools with no result", () => {
		expect(describeTool(makeBashTool("git commit -m foo"))).toBeUndefined()
	})

	it("returns 'committed <sha>' for git commit", () => {
		const stdout = "[main abc1234] foo\n 1 file changed, 2 insertions(+)"
		expect(describeTool(makeBashTool("git commit -m foo", { stdout }))).toBe("committed abc1234")
	})

	it("returns 'pushed <sha>' for git push", () => {
		const stdout = "To github.com:user/repo.git\n   abc1234..def5678  main -> origin/main"
		expect(describeTool(makeBashTool("git push", { stdout }))).toBe("pushed def5678")
	})

	it("handles rtk prefix for git commit", () => {
		expect(describeTool(makeBashTool("rtk git commit -m foo", { stdout: "[main abc1234] foo" }))).toBe(
			"committed abc1234",
		)
	})

	it("handles rtk prefix for git push", () => {
		expect(describeTool(makeBashTool("rtk git push", { stdout: "   abc1234..def5678  main -> origin/main" }))).toBe(
			"pushed def5678",
		)
	})

	it("parses rtk commit output format: 'ok <sha>'", () => {
		expect(describeTool(makeBashTool("rtk git commit -m foo", { stdout: "ok 9cbcbc1" }))).toBe("committed 9cbcbc1")
	})

	it("parses rtk push output format: 'ok <branch>'", () => {
		expect(describeTool(makeBashTool("rtk git push", { stdout: "ok master" }))).toBe("pushed master")
	})

	it("parses plain (non-rtk) git commit when output uses rtk format", () => {
		// If someone aliases git to rtk, the command is 'git commit' but output is rtk format
		expect(describeTool(makeBashTool("git commit -m foo", { stdout: "ok abc1234" }))).toBe("committed abc1234")
	})

	it("returns undefined for unrecognized bash commands", () => {
		expect(describeTool(makeBashTool("ls -la", { stdout: "file1\nfile2" }))).toBeUndefined()
	})

	it("returns undefined for non-bash tools", () => {
		expect(
			describeTool({ toolName: "read", toolCallId: "c1", isPartial: false, args: { path: "foo.ts" } }),
		).toBeUndefined()
	})

	it("returns undefined for git commit with unparseable stdout", () => {
		expect(describeTool(makeBashTool("git commit -m foo", { stdout: "nothing matched here" }))).toBeUndefined()
	})

	it("returns undefined for git push with unparseable stdout", () => {
		expect(describeTool(makeBashTool("git push", { stdout: "Everything up-to-date" }))).toBeUndefined()
	})

	it("a lone completed git commit is describable (enables single-tool collapse)", () => {
		const tool = mockBashResult("git commit -m foo", "[main abc1234] foo")
		expect(describeTool(tool)).toBe("committed abc1234")
	})

	it("returns undefined for failed git commit (isError: true)", () => {
		const tool = mockBashResult("git commit -m foo", "[main abc1234] foo")
		// biome-ignore lint/suspicious/noExplicitAny: override result on mock to simulate failure
		;(tool as any).result = { isError: true, content: [{ type: "text", text: "[main abc1234] foo" }] }
		expect(describeTool(tool)).toBeUndefined()
	})

	it("returns undefined for failed git push (isError: true)", () => {
		const tool = mockBashResult("git push", "   abc1234..def5678  main -> origin/main")
		// biome-ignore lint/suspicious/noExplicitAny: override result on mock to simulate failure
		;(tool as any).result = {
			isError: true,
			content: [{ type: "text", text: "   abc1234..def5678  main -> origin/main" }],
		}
		expect(describeTool(tool)).toBeUndefined()
	})
})

describe("buildGroupView", () => {
	const plainTheme = {
		fg: (key: string, value: string) => value,
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
})
