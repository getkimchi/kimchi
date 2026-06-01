import { describe, expect, it } from "vitest"
import {
	accumulateLoc,
	accumulateToolUsage,
	collectMetrics,
	createCumulativeState,
	handleBashCumulativeMetrics,
	handleEditCumulativeMetrics,
	recordEditDecision,
} from "./accumulator.js"

describe("createCumulativeState", () => {
	it("returns empty state", () => {
		const state = createCumulativeState()
		expect(state.tokensByModel).toEqual({})
		expect(state.costByModel).toEqual({})
		expect(state.commitCount).toBe(0)
		expect(state.prCount).toBe(0)
		expect(state.locByLanguage).toEqual({})
		expect(state.editDecisions).toEqual({})
		expect(state.toolUsage).toEqual({})
		expect(state.toolDurationMs).toEqual({})
	})
})

describe("accumulateLoc", () => {
	it("accumulates for same language", () => {
		const state = createCumulativeState()
		accumulateLoc(state, "TypeScript", 10, 3)
		accumulateLoc(state, "TypeScript", 5, 1)
		expect(state.locByLanguage.TypeScript).toEqual({ added: 15, removed: 4 })
	})

	it("tracks different languages separately", () => {
		const state = createCumulativeState()
		accumulateLoc(state, "TypeScript", 10, 0)
		accumulateLoc(state, "Python", 5, 2)
		expect(state.locByLanguage.TypeScript).toEqual({ added: 10, removed: 0 })
		expect(state.locByLanguage.Python).toEqual({ added: 5, removed: 2 })
	})
})

describe("recordEditDecision", () => {
	it("increments count", () => {
		const state = createCumulativeState()
		recordEditDecision(state, "edit", "TypeScript")
		expect(state.editDecisions["edit|accept|TypeScript|auto"]).toBe(1)
	})

	it("increments count on repeated calls", () => {
		const state = createCumulativeState()
		recordEditDecision(state, "edit", "TypeScript")
		recordEditDecision(state, "edit", "TypeScript")
		expect(state.editDecisions["edit|accept|TypeScript|auto"]).toBe(2)
	})
})

describe("handleBashCumulativeMetrics", () => {
	it("detects git commit", () => {
		const state = createCumulativeState()
		handleBashCumulativeMetrics(state, { command: "git commit -m 'feat: thing'" })
		expect(state.commitCount).toBe(1)
	})

	it("ignores git commit --dry-run", () => {
		const state = createCumulativeState()
		handleBashCumulativeMetrics(state, { command: "git commit --dry-run -m 'test'" })
		expect(state.commitCount).toBe(0)
	})

	it("detects gh pr create", () => {
		const state = createCumulativeState()
		handleBashCumulativeMetrics(state, { command: "gh pr create --title 'my pr'" })
		expect(state.prCount).toBe(1)
	})

	it("does not increment for unrelated commands", () => {
		const state = createCumulativeState()
		handleBashCumulativeMetrics(state, { command: "ls -la" })
		expect(state.commitCount).toBe(0)
		expect(state.prCount).toBe(0)
	})

	it("does not detect git commit in strings that only contain commit keyword elsewhere", () => {
		const state = createCumulativeState()
		handleBashCumulativeMetrics(state, { command: "git log --oneline" })
		expect(state.commitCount).toBe(0)
	})
})

describe("handleEditCumulativeMetrics", () => {
	it("accumulates LOC for write tool (counting lines in content)", () => {
		const state = createCumulativeState()
		handleEditCumulativeMetrics(state, "write", {
			path: "src/foo.ts",
			content: "line1\nline2\nline3",
		})
		expect(state.locByLanguage.TypeScript).toEqual({ added: 3, removed: 0 })
		expect(state.editDecisions["write|accept|TypeScript|auto"]).toBe(1)
	})

	it("accumulates LOC for edit tool (counting diff)", () => {
		const state = createCumulativeState()
		handleEditCumulativeMetrics(state, "edit", {
			path: "src/bar.py",
			edits: [{ oldText: "line1\nline2", newText: "line1\nline2\nline3\nline4" }],
		})
		expect(state.locByLanguage.Python).toEqual({ added: 2, removed: 0 })
		expect(state.editDecisions["edit|accept|Python|auto"]).toBe(1)
	})

	it("handles unknown file extension as 'unknown' language", () => {
		const state = createCumulativeState()
		handleEditCumulativeMetrics(state, "write", {
			path: "Makefile",
			content: "all:\n\tmake build",
		})
		expect(state.locByLanguage.unknown).toEqual({ added: 2, removed: 0 })
	})
})

describe("accumulateToolUsage", () => {
	it("increments usage count and accumulates duration", () => {
		const state = createCumulativeState()
		accumulateToolUsage(state, "bash", 50)
		accumulateToolUsage(state, "bash", 30)
		expect(state.toolUsage.bash).toBe(2)
		expect(state.toolDurationMs.bash).toBe(80)
	})

	it("tracks different tools separately", () => {
		const state = createCumulativeState()
		accumulateToolUsage(state, "bash", 50)
		accumulateToolUsage(state, "edit", 200)
		expect(state.toolUsage.bash).toBe(1)
		expect(state.toolUsage.edit).toBe(1)
		expect(state.toolDurationMs.bash).toBe(50)
		expect(state.toolDurationMs.edit).toBe(200)
	})
})

describe("collectMetrics", () => {
	it("returns empty array for empty state", () => {
		const state = createCumulativeState()
		expect(collectMetrics(state)).toEqual([])
	})

	it("produces token metrics per model, excluding zero-value entries", () => {
		const state = createCumulativeState()
		state.tokensByModel["gpt-4"] = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }
		const metrics = collectMetrics(state)
		const names = metrics.map((m) => m.name)
		expect(names).toContain("claude_code.token.usage")
		const inputMetric = metrics.find((m) => m.name === "claude_code.token.usage" && m.attrs.type === "input")
		expect(inputMetric).toBeDefined()
		expect(inputMetric?.value).toBe(100)
		expect(inputMetric?.attrs.model).toBe("gpt-4")
		const outputMetric = metrics.find((m) => m.name === "claude_code.token.usage" && m.attrs.type === "output")
		expect(outputMetric?.value).toBe(50)
		// zero entries should be excluded
		const cacheReadMetric = metrics.find((m) => m.name === "claude_code.token.usage" && m.attrs.type === "cacheRead")
		expect(cacheReadMetric).toBeUndefined()
	})

	it("maps cacheWrite to cacheCreation in otel type", () => {
		const state = createCumulativeState()
		state.tokensByModel["claude-3"] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 200 }
		const metrics = collectMetrics(state)
		const m = metrics.find((m) => m.attrs.type === "cacheCreation")
		expect(m).toBeDefined()
		expect(m?.value).toBe(200)
	})

	it("produces commit count metric", () => {
		const state = createCumulativeState()
		state.commitCount = 3
		const metrics = collectMetrics(state)
		const m = metrics.find((m) => m.name === "claude_code.commit.count")
		expect(m).toBeDefined()
		expect(m?.value).toBe(3)
		expect(m?.attrs.tool_name).toBe("bash")
		expect(m?.attrs.decision).toBe("git_commit")
	})

	it("does not emit commit count metric when count is zero", () => {
		const state = createCumulativeState()
		const metrics = collectMetrics(state)
		expect(metrics.find((m) => m.name === "claude_code.commit.count")).toBeUndefined()
	})

	it("produces pull request count metric", () => {
		const state = createCumulativeState()
		state.prCount = 2
		const metrics = collectMetrics(state)
		const m = metrics.find((m) => m.name === "claude_code.pull_request.count")
		expect(m).toBeDefined()
		expect(m?.value).toBe(2)
		expect(m?.attrs.decision).toBe("gh_pr_create")
	})

	it("produces lines_of_code metrics for added and removed", () => {
		const state = createCumulativeState()
		accumulateLoc(state, "Go", 10, 4)
		const metrics = collectMetrics(state)
		const added = metrics.find((m) => m.name === "claude_code.lines_of_code.count" && m.attrs.type === "added")
		const removed = metrics.find((m) => m.name === "claude_code.lines_of_code.count" && m.attrs.type === "removed")
		expect(added?.value).toBe(10)
		expect(added?.attrs.language).toBe("Go")
		expect(removed?.value).toBe(4)
	})

	it("produces tool.usage metrics per tool name", () => {
		const state = createCumulativeState()
		accumulateToolUsage(state, "bash", 50)
		accumulateToolUsage(state, "bash", 30)
		accumulateToolUsage(state, "edit", 200)
		const metrics = collectMetrics(state)
		const bashUsage = metrics.find((m) => m.name === "claude_code.tool.usage" && m.attrs.tool_name === "bash")
		expect(bashUsage).toBeDefined()
		expect(bashUsage?.value).toBe(2)
		const editUsage = metrics.find((m) => m.name === "claude_code.tool.usage" && m.attrs.tool_name === "edit")
		expect(editUsage).toBeDefined()
		expect(editUsage?.value).toBe(1)
	})

	it("produces tool.duration_ms metrics per tool name", () => {
		const state = createCumulativeState()
		accumulateToolUsage(state, "bash", 50)
		accumulateToolUsage(state, "bash", 30)
		accumulateToolUsage(state, "edit", 200)
		const metrics = collectMetrics(state)
		const bashDuration = metrics.find((m) => m.name === "claude_code.tool.duration_ms" && m.attrs.tool_name === "bash")
		expect(bashDuration).toBeDefined()
		expect(bashDuration?.value).toBe(80)
		const editDuration = metrics.find((m) => m.name === "claude_code.tool.duration_ms" && m.attrs.tool_name === "edit")
		expect(editDuration).toBeDefined()
		expect(editDuration?.value).toBe(200)
	})

	it("does not emit tool metrics when counts are zero", () => {
		const state = createCumulativeState()
		const metrics = collectMetrics(state)
		expect(metrics.find((m) => m.name === "claude_code.tool.usage")).toBeUndefined()
		expect(metrics.find((m) => m.name === "claude_code.tool.duration_ms")).toBeUndefined()
	})

	it("produces code_edit_tool.decision metrics", () => {
		const state = createCumulativeState()
		recordEditDecision(state, "write", "TypeScript")
		recordEditDecision(state, "write", "TypeScript")
		const metrics = collectMetrics(state)
		const m = metrics.find((m) => m.name === "claude_code.code_edit_tool.decision")
		expect(m).toBeDefined()
		expect(m?.value).toBe(2)
		expect(m?.attrs.tool_name).toBe("write")
		expect(m?.attrs.decision).toBe("accept")
		expect(m?.attrs.language).toBe("TypeScript")
		expect(m?.attrs.source).toBe("auto")
	})
})
