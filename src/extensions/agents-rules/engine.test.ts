import { describe, expect, it } from "vitest"
import { AgentRulesEngine } from "./engine.js"
import type { AgentRule } from "./types.js"

const CWD = "/repo/project"

function makeRule(overrides: Partial<AgentRule> & { name: string }): AgentRule {
	return {
		path: `/repo/project/.agents/rules/${overrides.name}.mdc`,
		globs: [],
		alwaysApply: false,
		body: `body of ${overrides.name}`,
		baseDir: "/repo/project",
		mode: "available",
		...overrides,
	}
}

function makeRules(): AgentRule[] {
	return [
		makeRule({ name: "always-first", alwaysApply: true, mode: "always", description: "baseline" }),
		makeRule({ name: "api-glob", globs: ["src/api/**"], mode: "glob" }),
		makeRule({ name: "docs-glob", globs: ["docs/**"], mode: "glob", description: "docs conventions" }),
		makeRule({ name: "standalone", mode: "available", description: "on demand" }),
	]
}

describe("AgentRulesEngine", () => {
	it("exposes always-apply rules in discovery order", () => {
		const engine = new AgentRulesEngine(makeRules(), CWD)
		expect(engine.getAlwaysApplyRules().map((r) => r.name)).toEqual(["always-first"])
	})

	it("exposes glob rules in discovery order", () => {
		const engine = new AgentRulesEngine(makeRules(), CWD)
		expect(engine.getGlobRules().map((r) => r.name)).toEqual(["api-glob", "docs-glob"])
	})

	it("exposes the available index with name, description and cwd-relative path", () => {
		const engine = new AgentRulesEngine(makeRules(), CWD)
		expect(engine.getAvailableIndex()).toEqual([
			{ name: "standalone", description: "on demand", relativePath: ".agents/rules/standalone.mdc" },
		])
	})

	it("activates a glob rule exactly once per session regardless of match count", () => {
		const engine = new AgentRulesEngine(makeRules(), CWD)
		const first = engine.handleToolCall("edit", { path: "src/api/v1/users.ts" })
		expect(first.map((r) => r.name)).toEqual(["api-glob"])

		const second = engine.handleToolCall("read", { path: "src/api/v2/orders.ts" })
		expect(second).toEqual([])

		const third = engine.handleToolCall("write", { path: "/repo/project/src/api/v3/a.ts" })
		expect(third).toEqual([])
		expect(engine.getActivatedRules().map((r) => r.name)).toEqual(["api-glob"])
	})

	it("activates multiple matching rules in one tool call", () => {
		const rules = [
			makeRule({ name: "ts", globs: ["src/**/*.ts"], mode: "glob" }),
			makeRule({ name: "api", globs: ["src/api/**"], mode: "glob" }),
		]
		const engine = new AgentRulesEngine(rules, CWD)
		const activated = engine.handleToolCall("read", { path: "src/api/x.ts" })
		expect(activated.map((r) => r.name)).toEqual(["ts", "api"])
	})

	it("ignores tools other than read/edit/write", () => {
		const engine = new AgentRulesEngine(makeRules(), CWD)
		expect(engine.handleToolCall("bash", { command: "touch src/api/new.ts" })).toEqual([])
		expect(engine.handleToolCall("grep", { path: "src/api" })).toEqual([])
	})

	it("ignores non-matching files", () => {
		const engine = new AgentRulesEngine(makeRules(), CWD)
		expect(engine.handleToolCall("edit", { path: "src/core/kernel.ts" })).toEqual([])
		expect(engine.getActivatedRules()).toEqual([])
	})

	it("reset() clears activation state so rules can activate again", () => {
		const engine = new AgentRulesEngine(makeRules(), CWD)
		expect(engine.handleToolCall("read", { path: "src/api/a.ts" })).toHaveLength(1)
		engine.reset()
		expect(engine.getActivatedRules()).toEqual([])
		expect(engine.handleToolCall("read", { path: "src/api/a.ts" })).toHaveLength(1)
	})

	it("alwaysApply rules never activate via tool calls (they are prompt-injected instead)", () => {
		const rules = [makeRule({ name: "always", globs: ["src/**"], alwaysApply: true, mode: "always" })]
		const engine = new AgentRulesEngine(rules, CWD)
		expect(engine.handleToolCall("edit", { path: "src/a.ts" })).toEqual([])
	})

	it("handleToolCall tolerates malformed tool inputs", () => {
		const engine = new AgentRulesEngine(makeRules(), CWD)
		expect(engine.handleToolCall("read", {})).toEqual([])
		expect(engine.handleToolCall("read", null)).toEqual([])
		expect(engine.handleToolCall("read", undefined)).toEqual([])
	})
})
