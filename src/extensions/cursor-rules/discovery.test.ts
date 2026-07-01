import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { discoverCursorRules, getRuleBaseDir } from "./discovery.js"

describe("discoverCursorRules", () => {
	const tmpBase = join(tmpdir(), `kimchi-cursor-rules-${Date.now()}`)
	const nested = join(tmpBase, "packages", "api")

	beforeEach(() => {
		rmSync(tmpBase, { recursive: true, force: true })
		mkdirSync(nested, { recursive: true })
	})

	afterEach(() => {
		rmSync(tmpBase, { recursive: true, force: true })
	})

	it("returns no rules when nothing exists", () => {
		const result = discoverCursorRules(nested)
		expect(result.rules).toEqual([])
	})

	it("discovers a legacy .cursorrules file", () => {
		writeFileSync(join(tmpBase, ".cursorrules"), "Legacy rule")
		const result = discoverCursorRules(tmpBase)
		expect(result.rules).toHaveLength(1)
		expect(result.rules[0].path).toBe(join(tmpBase, ".cursorrules"))
		expect(result.rules[0].alwaysApply).toBe(true)
		expect(result.rules[0].body).toBe("Legacy rule")
	})

	it("discovers .cursor/rules/*.mdc files", () => {
		const rulesDir = join(tmpBase, ".cursor", "rules")
		mkdirSync(rulesDir, { recursive: true })
		writeFileSync(join(rulesDir, "ts.mdc"), "---\nalwaysApply: true\n---\n\nTS rule")
		const result = discoverCursorRules(tmpBase)
		expect(result.rules).toHaveLength(1)
		expect(result.rules[0].path).toBe(join(rulesDir, "ts.mdc"))
		expect(result.rules[0].alwaysApply).toBe(true)
	})

	it("recursively discovers .mdc files in subdirectories", () => {
		const rulesDir = join(tmpBase, ".cursor", "rules")
		const subDir = join(rulesDir, "frontend")
		mkdirSync(subDir, { recursive: true })
		writeFileSync(join(rulesDir, "root.mdc"), "Root rule")
		writeFileSync(join(subDir, "nested.mdc"), "Nested rule")
		const result = discoverCursorRules(tmpBase)
		const paths = result.rules.map((r) => r.path)
		expect(paths).toContain(join(rulesDir, "root.mdc"))
		expect(paths).toContain(join(subDir, "nested.mdc"))
	})

	it("walks up to ancestors and orders them ancestor-first", () => {
		const rootRulesDir = join(tmpBase, ".cursor", "rules")
		const nestedRulesDir = join(nested, ".cursor", "rules")
		mkdirSync(rootRulesDir, { recursive: true })
		mkdirSync(nestedRulesDir, { recursive: true })
		writeFileSync(join(rootRulesDir, "root.mdc"), "Root")
		writeFileSync(join(nestedRulesDir, "nested.mdc"), "Nested")
		const result = discoverCursorRules(nested)
		expect(result.rules).toHaveLength(2)
		expect(result.rules[0].path).toBe(join(rootRulesDir, "root.mdc"))
		expect(result.rules[1].path).toBe(join(nestedRulesDir, "nested.mdc"))
	})

	it("ignores plain .md files in .cursor/rules", () => {
		const rulesDir = join(tmpBase, ".cursor", "rules")
		mkdirSync(rulesDir, { recursive: true })
		writeFileSync(join(rulesDir, "ignored.md"), "Ignored")
		const result = discoverCursorRules(tmpBase)
		expect(result.rules).toEqual([])
	})

	it("deduplicates by absolute path", () => {
		const rulesDir = join(tmpBase, ".cursor", "rules")
		mkdirSync(rulesDir, { recursive: true })
		writeFileSync(join(rulesDir, "once.mdc"), "One")
		const result = discoverCursorRules(tmpBase)
		// Calling resolve inside should normalize the path; the same file is only
		// reachable once from a single cwd, but the dedup guard protects against
		// future collection changes.
		expect(result.rules).toHaveLength(1)
	})

	it("discovers .agents/rules/*.mdc files", () => {
		const rulesDir = join(tmpBase, ".agents", "rules")
		mkdirSync(rulesDir, { recursive: true })
		writeFileSync(join(rulesDir, "api.mdc"), "---\nalwaysApply: true\n---\n\nAPI rule")
		const result = discoverCursorRules(tmpBase)
		expect(result.rules).toHaveLength(1)
		expect(result.rules[0].path).toBe(join(rulesDir, "api.mdc"))
		expect(result.rules[0].alwaysApply).toBe(true)
	})

	it("discovers both .cursor/rules and .agents/rules at the same level", () => {
		const cursorRulesDir = join(tmpBase, ".cursor", "rules")
		const agentsRulesDir = join(tmpBase, ".agents", "rules")
		mkdirSync(cursorRulesDir, { recursive: true })
		mkdirSync(agentsRulesDir, { recursive: true })
		writeFileSync(join(cursorRulesDir, "cursor.mdc"), "Cursor rule")
		writeFileSync(join(agentsRulesDir, "agents.mdc"), "Agents rule")
		const result = discoverCursorRules(tmpBase)
		const paths = result.rules.map((r) => r.path)
		expect(paths).toContain(join(cursorRulesDir, "cursor.mdc"))
		expect(paths).toContain(join(agentsRulesDir, "agents.mdc"))
	})

	it("computes base dir correctly for .agents/rules", () => {
		const rulePath = join(tmpBase, ".agents", "rules", "api.mdc")
		expect(getRuleBaseDir(rulePath)).toBe(tmpBase)
	})

	it("computes base dir correctly for nested rules", () => {
		const rulePath = join(tmpBase, ".cursor", "rules", "frontend", "react.mdc")
		expect(getRuleBaseDir(rulePath)).toBe(tmpBase)
	})
})
