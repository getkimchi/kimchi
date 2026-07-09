import { describe, expect, it } from "vitest"
import { parseCursorRule, parseLegacyCursorRules } from "./parser.js"

describe("parseCursorRule", () => {
	it("parses a full mdc rule with frontmatter", () => {
		const content = `---
description: TypeScript conventions
globs:
  - "src/**/*.ts"
  - "src/**/*.tsx"
alwaysApply: true
---

# TypeScript

Use strict mode. Prefer unknown over any.`
		const rule = parseCursorRule("/project/.cursor/rules/ts.mdc", content)
		expect(rule.path).toBe("/project/.cursor/rules/ts.mdc")
		expect(rule.description).toBe("TypeScript conventions")
		expect(rule.globs).toEqual(["src/**/*.ts", "src/**/*.tsx"])
		expect(rule.alwaysApply).toBe(true)
		expect(rule.body).toBe("# TypeScript\n\nUse strict mode. Prefer unknown over any.")
	})

	it("treats a rule without frontmatter as manual", () => {
		const content = "# Manual rule\n\nOnly use when asked."
		const rule = parseCursorRule("/project/.cursor/rules/manual.mdc", content)
		expect(rule.description).toBeUndefined()
		expect(rule.globs).toEqual([])
		expect(rule.alwaysApply).toBe(false)
		expect(rule.body).toBe(content)
	})

	it("parses comma-separated globs", () => {
		const content = `---
globs: "*.ts, *.tsx"
---

Body`
		const rule = parseCursorRule("/project/.cursor/rules/globs.mdc", content)
		expect(rule.globs).toEqual(["*.ts", "*.tsx"])
	})

	it("defaults alwaysApply to false when omitted", () => {
		const content = `---
description: A described rule
---

Body`
		const rule = parseCursorRule("/project/.cursor/rules/described.mdc", content)
		expect(rule.alwaysApply).toBe(false)
		expect(rule.description).toBe("A described rule")
	})

	it("falls back to full content when frontmatter YAML is invalid", () => {
		const content = `---
description: : : :
alwaysApply: not-a-boolean
---

Body`
		const rule = parseCursorRule("/project/.cursor/rules/bad.mdc", content)
		expect(rule.body).toBe(content)
		expect(rule.alwaysApply).toBe(false)
		expect(rule.globs).toEqual([])
	})

	it("ignores empty or whitespace-only description", () => {
		const content = `---
description: "   "
---

Body`
		const rule = parseCursorRule("/project/.cursor/rules/empty-desc.mdc", content)
		expect(rule.description).toBeUndefined()
	})

	it("ignores non-string globs", () => {
		const content = `---
globs:
  - "*.ts"
  - 42
  - true
---

Body`
		const rule = parseCursorRule("/project/.cursor/rules/mixed-globs.mdc", content)
		expect(rule.globs).toEqual(["*.ts"])
	})
})

describe("parseLegacyCursorRules", () => {
	it("returns an always-apply rule wrapping the content", () => {
		const rule = parseLegacyCursorRules("/project/.cursorrules", "Legacy content")
		expect(rule.path).toBe("/project/.cursorrules")
		expect(rule.alwaysApply).toBe(true)
		expect(rule.globs).toEqual([])
		expect(rule.body).toBe("Legacy content")
		expect(rule.description).toBe("Legacy .cursorrules file")
	})
})
