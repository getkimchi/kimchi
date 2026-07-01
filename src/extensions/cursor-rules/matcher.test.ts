import { describe, expect, it } from "vitest"
import { getActiveRules } from "./matcher.js"
import type { ParsedCursorRule } from "./types.js"

function makeRule(overrides: Partial<ParsedCursorRule> & { path: string }): ParsedCursorRule {
	return {
		description: undefined,
		globs: [],
		alwaysApply: false,
		body: "Body",
		...overrides,
	}
}

describe("getActiveRules", () => {
	it("includes alwaysApply rules regardless of touched files", () => {
		const rule = makeRule({ path: "/project/.cursor/rules/always.mdc", alwaysApply: true })
		const result = getActiveRules([rule], new Set())
		expect(result.alwaysApply).toEqual([rule])
		expect(result.matched).toEqual([])
		expect(result.available).toEqual([])
	})

	it("matches glob rules when a touched file matches", () => {
		const rule = makeRule({ path: "/project/.cursor/rules/ts.mdc", globs: ["src/**/*.ts"] })
		const result = getActiveRules([rule], new Set(["/project/src/foo.ts"]))
		expect(result.alwaysApply).toEqual([])
		expect(result.matched).toEqual([rule])
		expect(result.available).toEqual([])
	})

	it("does not include glob rules when no touched file matches", () => {
		const rule = makeRule({ path: "/project/.cursor/rules/ts.mdc", globs: ["src/**/*.ts"] })
		const result = getActiveRules([rule], new Set(["/project/lib/foo.js"]))
		expect(result.alwaysApply).toEqual([])
		expect(result.matched).toEqual([])
		expect(result.available).toEqual([])
	})

	it("matches globs relative to the rule's base directory", () => {
		const rule = makeRule({ path: "/project/packages/api/.cursor/rules/api.mdc", globs: ["src/**/*.ts"] })
		const result = getActiveRules([rule], new Set(["/project/packages/api/src/foo.ts"]))
		expect(result.matched).toEqual([rule])
	})

	it("does not match files outside the rule's base directory", () => {
		const rule = makeRule({ path: "/project/packages/api/.cursor/rules/api.mdc", globs: ["src/**/*.ts"] })
		const result = getActiveRules([rule], new Set(["/project/src/foo.ts"]))
		expect(result.matched).toEqual([])
	})

	it("lists description-only rules as available", () => {
		const rule = makeRule({ path: "/project/.cursor/rules/described.mdc", description: "API conventions" })
		const result = getActiveRules([rule], new Set())
		expect(result.alwaysApply).toEqual([])
		expect(result.matched).toEqual([])
		expect(result.available).toEqual([rule])
	})

	it("lists manual rules (no frontmatter) as available", () => {
		const rule = makeRule({ path: "/project/.cursor/rules/manual.mdc" })
		const result = getActiveRules([rule], new Set())
		expect(result.available).toEqual([rule])
	})

	it("prefers alwaysApply over globs and available", () => {
		const rule = makeRule({
			path: "/project/.cursor/rules/both.mdc",
			alwaysApply: true,
			globs: ["src/**/*.ts"],
			description: "Desc",
		})
		const result = getActiveRules([rule], new Set())
		expect(result.alwaysApply).toEqual([rule])
		expect(result.matched).toEqual([])
		expect(result.available).toEqual([])
	})

	it("matches multiple globs in a single rule", () => {
		const rule = makeRule({ path: "/project/.cursor/rules/multi.mdc", globs: ["*.ts", "*.tsx"] })
		const result = getActiveRules([rule], new Set(["/project/foo.tsx"]))
		expect(result.matched).toEqual([rule])
	})
})
