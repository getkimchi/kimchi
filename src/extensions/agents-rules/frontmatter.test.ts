import { describe, expect, it } from "vitest"
import { parseRuleFile, RuleParseError } from "./frontmatter.js"

describe("parseRuleFile", () => {
	it("parses full frontmatter with globs list and alwaysApply", () => {
		const raw = `---
description: TypeScript conventions
globs:
  - "src/**/*.ts"
  - "src/**/*.tsx"
alwaysApply: true
---

# TypeScript

Use strict mode.
`
		const result = parseRuleFile(raw)
		expect(result.frontmatter.description).toBe("TypeScript conventions")
		expect(result.frontmatter.globs).toEqual(["src/**/*.ts", "src/**/*.tsx"])
		expect(result.frontmatter.alwaysApply).toBe(true)
		expect(result.body).toBe("# TypeScript\n\nUse strict mode.")
		expect(result.hasFrontmatter).toBe(true)
	})

	it("returns empty defaults for a file without frontmatter", () => {
		const result = parseRuleFile("# Just markdown\n\nNo frontmatter here.")
		expect(result.frontmatter.globs).toEqual([])
		expect(result.frontmatter.alwaysApply).toBe(false)
		expect(result.frontmatter.description).toBeUndefined()
		expect(result.body).toBe("# Just markdown\n\nNo frontmatter here.")
		expect(result.hasFrontmatter).toBe(false)
	})

	it("splits a comma-separated globs string", () => {
		const raw = `---
globs: "*.ts, *.tsx , src/api/**"
---`
		const result = parseRuleFile(raw)
		expect(result.frontmatter.globs).toEqual(["*.ts", "*.tsx", "src/api/**"])
	})

	it("coerces alwaysApply string 'true'", () => {
		const raw = `---
alwaysApply: "true"
---`
		expect(parseRuleFile(raw).frontmatter.alwaysApply).toBe(true)
	})

	it("coerces alwaysApply string 'false' and empty", () => {
		expect(parseRuleFile('---\nalwaysApply: "false"\n---').frontmatter.alwaysApply).toBe(false)
		expect(parseRuleFile('---\nalwaysApply: ""\n---').frontmatter.alwaysApply).toBe(false)
	})

	it("flattens string entries inside a globs list", () => {
		const raw = `---
globs:
  - "*.ts, *.tsx"
  - "docs/**"
---`
		expect(parseRuleFile(raw).frontmatter.globs).toEqual(["*.ts", "*.tsx", "docs/**"])
	})

	it("treats empty globs list and empty string as no globs", () => {
		expect(parseRuleFile("---\nglobs: []\n---").frontmatter.globs).toEqual([])
		expect(parseRuleFile('---\nglobs: ""\n---').frontmatter.globs).toEqual([])
		expect(parseRuleFile('---\nglobs: " , ,"\n---').frontmatter.globs).toEqual([])
	})

	it("throws RuleParseError on malformed YAML", () => {
		const raw = `---
description: [unclosed
---`
		expect(() => parseRuleFile(raw)).toThrow(RuleParseError)
		expect(() => parseRuleFile(raw)).toThrow(/invalid YAML frontmatter/)
	})

	it("throws RuleParseError with rule path context", () => {
		expect(() => parseRuleFile("---\ndescription: [unclosed\n---", "/repo/.agents/rules/bad.mdc")).toThrow(
			"/repo/.agents/rules/bad.mdc",
		)
	})

	it("throws RuleParseError when globs contains a non-string entry", () => {
		const raw = `---
globs:
  - 42
---`
		expect(() => parseRuleFile(raw)).toThrow(RuleParseError)
		expect(() => parseRuleFile(raw)).toThrow(/must contain only strings/)
	})

	it("throws RuleParseError when globs is a non-string, non-list value", () => {
		const raw = `---
globs: 42
---`
		expect(() => parseRuleFile(raw)).toThrow(/must be a string or a list of strings/)
	})

	it("throws RuleParseError when alwaysApply is an uncoercible type", () => {
		const raw = `---
alwaysApply:
  - true
---`
		expect(() => parseRuleFile(raw)).toThrow(RuleParseError)
		expect(() => parseRuleFile(raw)).toThrow(/alwaysApply/)
	})

	it("throws RuleParseError when description is not a string", () => {
		const raw = `---
description: 42
---`
		expect(() => parseRuleFile(raw)).toThrow(/description.*must be a string/)
	})

	it("treats blank description as undefined", () => {
		const result = parseRuleFile('---\ndescription: "   "\n---')
		expect(result.frontmatter.description).toBeUndefined()
	})
})
