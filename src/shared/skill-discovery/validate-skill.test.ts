import { spawnSync } from "node:child_process"
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { validateSkill } from "./validate-skill.js"

describe("creator frontmatter validator", () => {
	let root: string
	let skill: string
	let file: string
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "skill-validator-"))
		skill = join(root, "path with spaces", "meeting-actions")
		mkdirSync(skill, { recursive: true })
		file = join(skill, "SKILL.md")
	})
	afterEach(() => rmSync(root, { recursive: true, force: true }))

	it.each([
		'name: meeting-actions\ndescription: "Extract actions: owners and dates"',
		"name: meeting-actions\ndescription: >-\n  Extract action items\n  from meeting notes.\nmetadata:\n  audience: team",
		`name: meeting-actions\ndescription: ${"x".repeat(1024)}`,
	])("accepts valid YAML without changing the file", (yaml) => {
		const content = `\uFEFF---\r\n${yaml.replace(/\n/g, "\r\n")}\r\n---\r\n# Instructions\r\n`
		writeFileSync(file, content)
		expect(() => validateSkill(file)).not.toThrow()
		expect(readFileSync(file, "utf8")).toBe(content)
	})

	it.each([
		["description: Extract actions", "name must"],
		["name: 123\ndescription: Extract actions", "name must"],
		["name: Meeting-actions\ndescription: Extract actions", "name must"],
		["name: meeting--actions\ndescription: Extract actions", "name must"],
		["name: -meeting-actions\ndescription: Extract actions", "name must"],
		["name: meeting-actions-\ndescription: Extract actions", "name must"],
		[`name: ${"a".repeat(65)}\ndescription: Extract actions`, "name must"],
		["name: other-name\ndescription: Extract actions", "folder name"],
		["name: meeting-actions", "description must"],
		['name: meeting-actions\ndescription: " "', "description must"],
		["name: meeting-actions\ndescription: [actions]", "description must"],
		[`name: meeting-actions\ndescription: ${"x".repeat(1025)}`, "description must"],
		["name: meeting-actions\ndescription: invalid: yaml", "Nested mappings"],
		["name: meeting-actions\nname: duplicate\ndescription: Extract actions", "Map keys must be unique"],
		["- name: meeting-actions", "YAML mapping"],
		["plain text", "YAML mapping"],
	])("rejects invalid frontmatter: %s", (yaml, message) => {
		writeFileSync(file, `---\n${yaml}\n---\nInstructions\n`)
		expect(() => validateSkill(file)).toThrow(message)
	})

	it.each([
		"# No frontmatter",
		"---\nname: meeting-actions",
		"---oops\nname: meeting-actions\n---",
	])("rejects missing or unclosed frontmatter", (content) => {
		writeFileSync(file, content)
		expect(() => validateSkill(file)).toThrow("Expected YAML frontmatter")
	})

	it("runs the shipped script outside the repository with Node and no dependencies", () => {
		const script = join(root, "validate-skill.mjs")
		cpSync(
			fileURLToPath(new URL("../../../resources/skills/create-skill/scripts/validate-skill.mjs", import.meta.url)),
			script,
		)
		writeFileSync(file, "---\nname: meeting-actions\ndescription: Extract actions\n---\n")
		for (const target of [skill, file]) {
			const result = spawnSync(process.execPath, [script, target], { cwd: root, encoding: "utf8" })
			expect(result.status, result.stderr).toBe(0)
			expect(result.stdout).toContain("Valid frontmatter")
		}
		writeFileSync(file, "---\nname: meeting-actions\ndescription: invalid: yaml\n---\n")
		const invalid = spawnSync(process.execPath, [script, skill], { cwd: root, encoding: "utf8" })
		expect(invalid.status).toBe(1)
		expect(invalid.stderr).toContain(file)
		const missing = spawnSync(process.execPath, [script, join(root, "missing")], { encoding: "utf8" })
		expect(missing.status).toBe(1)
		expect(missing.stderr).toContain("ENOENT")
		const usage = spawnSync(process.execPath, [script], { encoding: "utf8" })
		expect(usage.status).toBe(1)
		expect(usage.stderr).toContain("Usage:")
	})
})
