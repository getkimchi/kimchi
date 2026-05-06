import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseFrontmatter } from "@mariozechner/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	type DiscoveredCommand,
	deriveDescription,
	discoverCommandFiles,
	discoverSubdirectoryCommandFiles,
	extractExistingFrontmatter,
	migrateCommandToPrompt,
	toSkillName,
} from "./setup-wizard.js"

describe("toSkillName", () => {
	const cases: Record<string, string> = {
		simple: "simple",
		"My Command": "my-command",
		"reference-react": "reference-react",
		UPPER_CASE: "upper-case",
		"--double--hyphens--": "double-hyphens",
		"special!@#chars": "special-chars",
	}

	for (const [input, expected] of Object.entries(cases)) {
		it(`converts "${input}" to "${expected}"`, () => {
			expect(toSkillName(input)).toBe(expected)
		})
	}

	it("truncates names longer than 64 characters", () => {
		const long = "a".repeat(100)
		expect(toSkillName(long).length).toBe(64)
	})
})

describe("discoverCommandFiles", () => {
	let tempDir: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-cmd-test-"))
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	it("finds .md files in root directory with relative paths", () => {
		writeFileSync(join(tempDir, "review.md"), "# review")
		writeFileSync(join(tempDir, "deploy.md"), "# deploy")
		writeFileSync(join(tempDir, "ignore.txt"), "not a command")

		const result = discoverCommandFiles(tempDir, "Claude Code")

		const sorted = result.sort((a, b) => a.name.localeCompare(b.name))
		expect(sorted.map((r) => r.name)).toEqual(["deploy", "review"])
		expect(sorted.map((r) => r.relativePath)).toEqual(["deploy.md", "review.md"])
		expect(sorted[0].origin).toBe("Claude Code")
	})

	it("ignores subdirectory files", () => {
		writeFileSync(join(tempDir, "mr.md"), "# mr")
		const sub = join(tempDir, "reference")
		mkdirSync(sub)
		writeFileSync(join(sub, "react.md"), "# react guide")
		writeFileSync(join(sub, "vue.md"), "# vue guide")

		const result = discoverCommandFiles(tempDir, "Claude Code")

		expect(result.map((r) => r.name)).toEqual(["mr"])
		expect(result[0].relativePath).toBe("mr.md")
	})

	it("returns empty array for empty directory", () => {
		expect(discoverCommandFiles(tempDir, "Test")).toEqual([])
	})
})

describe("discoverSubdirectoryCommandFiles", () => {
	let tempDir: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-subcmd-test-"))
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	it("finds files only in subdirectories with relative paths", () => {
		writeFileSync(join(tempDir, "root.md"), "# root")
		const sub = join(tempDir, "reference")
		mkdirSync(sub)
		writeFileSync(join(sub, "react.md"), "# react guide")
		writeFileSync(join(sub, "vue.md"), "# vue guide")

		const result = discoverSubdirectoryCommandFiles(tempDir, "Claude Code")

		const sorted = result.sort((a, b) => a.name.localeCompare(b.name))
		expect(sorted.map((r) => r.name)).toEqual(["reference-react", "reference-vue"])
		expect(sorted.map((r) => r.relativePath)).toEqual([join("reference", "react.md"), join("reference", "vue.md")])
		expect(sorted[0].origin).toBe("Claude Code")
	})

	it("handles nested subdirectories with relative paths", () => {
		const sub = join(tempDir, "reference")
		const nested = join(sub, "deep")
		mkdirSync(nested, { recursive: true })
		writeFileSync(join(sub, "react.md"), "# react")
		writeFileSync(join(nested, "inner.md"), "# inner")

		const result = discoverSubdirectoryCommandFiles(tempDir, "Test")

		const sorted = result.sort((a, b) => a.name.localeCompare(b.name))
		expect(sorted.map((r) => r.name)).toEqual(["reference-deep-inner", "reference-react"])
		expect(sorted.map((r) => r.relativePath)).toEqual([
			join("reference", "deep", "inner.md"),
			join("reference", "react.md"),
		])
	})

	it("returns empty array when no subdirectories exist", () => {
		writeFileSync(join(tempDir, "root.md"), "# root")
		expect(discoverSubdirectoryCommandFiles(tempDir, "Test")).toEqual([])
	})
})

describe("extractExistingFrontmatter", () => {
	it("returns body only when no frontmatter", () => {
		const content = "# My Command\n\nDo something."
		const result = extractExistingFrontmatter(content)

		expect(result.description).toBeUndefined()
		expect(result.body).toBe(content)
	})

	it("extracts inline description from frontmatter", () => {
		const content = '---\nname: review\ndescription: "Code review skill"\n---\n\n# Review\n\nBody here.'
		const result = extractExistingFrontmatter(content)

		expect(result.description).toBe("Code review skill")
		expect(result.body).toBe("\n# Review\n\nBody here.")
	})

	it("extracts multiline description with pipe syntax (literal)", () => {
		const content = "---\nname: review\ndescription: |\n  Line one\n  Line two\n---\n\nBody."
		const result = extractExistingFrontmatter(content)

		// Pipe syntax preserves newlines
		expect(result.description).toBe("Line one\nLine two")
		expect(result.body).toBe("\nBody.")
	})

	it("extracts multiline description with folded syntax", () => {
		const content = "---\nname: review\ndescription: >\n  Line one\n  Line two\n---\n\nBody."
		const result = extractExistingFrontmatter(content)

		// Folded syntax collapses newlines to single spaces
		expect(result.description).toBe("Line one Line two")
		expect(result.body).toBe("\nBody.")
	})

	it("handles description without quotes", () => {
		const content = "---\ndescription: Simple description\n---\n\nContent."
		const result = extractExistingFrontmatter(content)

		expect(result.description).toBe("Simple description")
	})
})

describe("deriveDescription", () => {
	it("uses first heading as description", () => {
		expect(deriveDescription("# My Command\n\nSome details.")).toBe("My Command")
	})

	it("uses first meaningful line when no heading", () => {
		expect(deriveDescription("This command does something useful.")).toBe("This command does something useful.")
	})

	it("skips short lines", () => {
		expect(deriveDescription("Hi\nThis is the actual description of the command.")).toBe(
			"This is the actual description of the command.",
		)
	})

	it("returns fallback for empty content", () => {
		expect(deriveDescription("")).toBe("Migrated command")
	})
})

vi.mock("./config.js", async (importOriginal) => {
	const original = (await importOriginal()) as Record<string, unknown>
	return {
		...original,
		getAgentConfigDir: () => testAgentConfigDir,
	}
})

let testAgentConfigDir: string

describe("migrateCommandToPrompt", () => {
	let tempDir: string
	let srcDir: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-migrate-test-"))
		srcDir = join(tempDir, "commands")
		testAgentConfigDir = join(tempDir, "harness")
		mkdirSync(srcDir, { recursive: true })
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	it("creates prompt file with generated frontmatter", () => {
		const cmdPath = join(srcDir, "mr.md")
		writeFileSync(cmdPath, "Create a GitLab MR following this process:\n\n1. Title\n2. Description")

		const promptPath = join(testAgentConfigDir, "prompts", "mr.md")

		const cmd: DiscoveredCommand = { name: "mr", relativePath: "mr.md", absolutePath: cmdPath, origin: "Claude Code" }
		const result = migrateCommandToPrompt(cmd)

		expect(result).toBe(true)
		const content = readFileSync(promptPath, "utf-8")
		const { frontmatter, body } = parseFrontmatter<{ name: string; description: string }>(content)
		expect(frontmatter.name).toBe("mr")
		expect(frontmatter.description).toBe("Create a GitLab MR following this process:")
		expect(body).toContain("1. Title")
	})

	it("preserves existing description from frontmatter", () => {
		const cmdPath = join(srcDir, "review.md")
		writeFileSync(
			cmdPath,
			'---\nname: code-review-excellence\ndescription: "Comprehensive code review"\nallowed-tools:\n  - Read\n---\n\n# Review\n\nBody.',
		)

		const promptPath = join(testAgentConfigDir, "prompts", "review.md")

		const cmd: DiscoveredCommand = {
			name: "review",
			relativePath: "review.md",
			absolutePath: cmdPath,
			origin: "Claude Code",
		}
		migrateCommandToPrompt(cmd)

		const content = readFileSync(promptPath, "utf-8")
		expect(content).toContain('description: "Comprehensive code review"')
		expect(content).toContain("# Review")
	})

	it("preserves subdirectory structure", () => {
		const subDir = join(srcDir, "reference")
		mkdirSync(subDir, { recursive: true })
		const cmdPath = join(subDir, "react.md")
		writeFileSync(cmdPath, "# React guide\n\nReact review checklist.")

		const promptPath = join(testAgentConfigDir, "prompts", "reference", "react.md")

		const cmd: DiscoveredCommand = {
			name: "reference-react",
			relativePath: join("reference", "react.md"),
			absolutePath: cmdPath,
			origin: "Claude Code",
		}
		const result = migrateCommandToPrompt(cmd)

		expect(result).toBe(true)
		const content = readFileSync(promptPath, "utf-8")
		expect(content).toContain("---\nname: reference-react\n")
		expect(content).toContain("React guide")
	})

	it("skips if prompt file already exists", () => {
		const cmdPath = join(srcDir, "existing.md")
		writeFileSync(cmdPath, "# Existing command")

		const promptDir = join(testAgentConfigDir, "prompts")
		mkdirSync(promptDir, { recursive: true })
		writeFileSync(join(promptDir, "existing.md"), "already here")

		const cmd: DiscoveredCommand = {
			name: "existing",
			relativePath: "existing.md",
			absolutePath: cmdPath,
			origin: "Claude Code",
		}
		const result = migrateCommandToPrompt(cmd)

		expect(result).toBe(false)
	})
})
