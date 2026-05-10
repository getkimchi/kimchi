import { existsSync, readFileSync, rmSync } from "node:fs"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	SkillManager,
	formatPreview,
	parseSkill,
	validateCategory,
	validateFilePath,
	validateFrontmatter,
	validateName,
} from "./skill-manager.js"

describe("validateName", () => {
	const valid = (name: string) => expect(validateName(name)).toBeNull()
	const invalid = (name: string, contains: string) => {
		const result = validateName(name)
		expect(result).not.toBeNull()
		expect(result?.toLowerCase()).toContain(contains)
	}

	it("accepts valid names", () => {
		valid("systematic-debugging")
		valid("debug_v2")
		valid("foo.bar")
		valid("abc123")
	})

	it("rejects names starting with non-alphanumeric", () => {
		invalid("-foo", "start")
		invalid("_bar", "start")
	})

	it("rejects uppercase letters", () => {
		invalid("Foo", "lowercase")
		invalid("SYSTEM", "lowercase")
	})

	it("rejects names longer than 64 chars", () => {
		invalid("a".repeat(65), "64")
	})

	it("rejects names with spaces", () => {
		const result = validateName("foo bar")
		expect(result).not.toBeNull()
	})
})

describe("validateCategory", () => {
	it("accepts undefined/null/empty", () => {
		expect(validateCategory(undefined)).toBeNull()
		expect(validateCategory(null as unknown as undefined)).toBeNull()
		expect(validateCategory("")).toBeNull()
	})

	it("rejects spaces", () => {
		const result = validateCategory("bad dir")
		expect(result).not.toBeNull()
	})
})

describe("validateFrontmatter", () => {
	it("accepts valid frontmatter with body", async () => {
		const result = await validateFrontmatter("---\ndescription: test\n---\nBody here.")
		expect(result).toBeNull()
	})

	it("rejects missing opening delimiter", async () => {
		const result = await validateFrontmatter("no delimiter")
		expect(result).not.toBeNull()
		expect(result?.toLowerCase()).toContain("start")
	})

	it("rejects missing closing delimiter", async () => {
		const result = await validateFrontmatter("---\nno close")
		expect(result).not.toBeNull()
		expect(result?.toLowerCase()).toContain("closing")
	})

	it("rejects invalid YAML", async () => {
		const result = await validateFrontmatter("---\nbad: [unclosed\n---\nBody")
		expect(result).not.toBeNull()
		expect(result?.toLowerCase()).toContain("parse")
	})

	it("rejects missing body", async () => {
		const result = await validateFrontmatter("---\ndescription: test\n---\n")
		expect(result).not.toBeNull()
		expect(result?.toLowerCase()).toContain("content")
	})

	it("rejects missing description field", async () => {
		const result = await validateFrontmatter("---\nfoo: bar\n---\nBody here.")
		expect(result).not.toBeNull()
		expect(result).toContain("description")
	})

	it("rejects empty description", async () => {
		const result = await validateFrontmatter('---\ndescription: ""\n---\nBody here.')
		expect(result).not.toBeNull()
		expect(result).toContain("description")
	})

	it("rejects whitespace-only description", async () => {
		const result = await validateFrontmatter('---\ndescription: "   "\n---\nBody here.')
		expect(result).not.toBeNull()
		expect(result).toContain("description")
	})

	it("does not treat body --- as a delimiter", async () => {
		const result = await validateFrontmatter("---\ndescription: test\n---\nBody with\n---\ninside it.")
		expect(result).toBeNull()
	})
})

describe("parseSkill", () => {
	it("splits frontmatter and body correctly", () => {
		const { frontmatter, body } = parseSkill("---\ndescription: test\n---\nBody here.")
		expect(frontmatter).toBe("---\ndescription: test\n---\n")
		expect(body).toBe("Body here.")
	})

	it("returns empty frontmatter for input without delimiters", () => {
		const { frontmatter, body } = parseSkill("Just body text.")
		expect(frontmatter).toBe("")
		expect(body).toBe("Just body text.")
	})

	it("handles body with --- inside", () => {
		const { frontmatter, body } = parseSkill("---\ndescription: test\n---\nLine one\n---\nLine two")
		expect(frontmatter).toBe("---\ndescription: test\n---\n")
		expect(body).toBe("Line one\n---\nLine two")
	})
})

describe("validateFilePath", () => {
	const skillDir = "/skills/my-skill"

	it("accepts references/ paths", () => {
		expect(validateFilePath("references/foo.md", skillDir)).toBeNull()
	})

	it("accepts templates/ paths", () => {
		expect(validateFilePath("templates/script.ts", skillDir)).toBeNull()
	})

	it("rejects path traversal", () => {
		const result = validateFilePath("../escape.md", skillDir)
		expect(result).not.toBeNull()
		expect(result?.toLowerCase()).toMatch(/outside|escape|resolve/i)
	})

	it("rejects invalid subdirectories", () => {
		const result = validateFilePath("bad/file.md", skillDir)
		expect(result).not.toBeNull()
		expect(result?.toLowerCase()).toContain("allowed")
	})
})

describe("formatPreview", () => {
	it("adds line numbers with padding", () => {
		// Test with more than 9 lines to ensure padding kicks in
		const lines = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n")
		const preview = formatPreview(lines)
		const previewLines = preview.split("\n")
		expect(previewLines[0]).toMatch(/^\s+1 \| line 1/)
		// With 12 lines, pad=2, so "10" needs no leading space
		expect(previewLines[9]).toMatch(/^\s*10 \| line 10/)
	})

	it("truncates after maxLines with more lines indicator", () => {
		const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`)
		const content = lines.join("\n")
		const preview = formatPreview(content, 5)
		const lastLine = preview.split("\n").at(-1)
		expect(lastLine).toContain("5 more lines")
	})

	it("default maxLines is 50", () => {
		const lines = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`)
		const preview = formatPreview(lines.join("\n"))
		const lastLine = preview.split("\n").at(-1)
		expect(lastLine).toContain("10 more lines")
	})
})

describe("SkillManager", () => {
	let tmpDir: string
	let mgr: SkillManager

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "kimchi-skill-test-"))
		mgr = new SkillManager(tmpDir)
	})

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
	})

	describe("create", () => {
		it("creates a skill successfully", async () => {
			const result = await mgr.create("my-skill", "---\ndescription: x\n---\nBody.")
			expect(result.success).toBe(true)
			expect(existsSync(join(tmpDir, "my-skill", "SKILL.md"))).toBe(true)
		})

		it("rejects duplicate name", async () => {
			await mgr.create("my-skill", "---\ndescription: x\n---\nBody.")
			const result = await mgr.create("my-skill", "---\ndescription: y\n---\nBody2.")
			expect(result.success).toBe(false)
			expect(result.error).toMatch(/already exists/i)
		})

		it("rejects bad name", async () => {
			const result = await mgr.create("-bad", "---\ndescription: x\n---\nBody.")
			expect(result.success).toBe(false)
		})

		it("rejects invalid frontmatter", async () => {
			const result = await mgr.create("bad-front", "no delimiter\nbody")
			expect(result.success).toBe(false)
			expect(result.file_preview).toBeDefined()
		})

		it("creates in category subdirectory when specified", async () => {
			const result = await mgr.create("s", "---\ndescription: x\n---\nBody.", "debug")
			expect(result.success).toBe(true)
			expect(result.path).toMatch(/debug[/\\]s/)
			expect(existsSync(join(tmpDir, "debug", "s", "SKILL.md"))).toBe(true)
		})
	})

	describe("edit", () => {
		it("updates content successfully", async () => {
			await mgr.create("my-skill", "---\ndescription: x\n---\nBody.")
			const result = await mgr.edit("my-skill", "---\ndescription: y\n---\nNew body.")
			expect(result.success).toBe(true)
			const content = readFileSync(join(tmpDir, "my-skill", "SKILL.md"), "utf-8")
			expect(content).toContain("New body.")
		})

		it("preserves original on bad frontmatter", async () => {
			await mgr.create("my-skill", "---\ndescription: x\n---\nBody.")
			const result = await mgr.edit("my-skill", "no delimiter\nbody")
			expect(result.success).toBe(false)
			expect(result.file_preview).toBeDefined()
			const content = readFileSync(join(tmpDir, "my-skill", "SKILL.md"), "utf-8")
			expect(content).toContain("Body.")
		})
	})

	describe("patch", () => {
		it("patches unique match successfully", async () => {
			await mgr.create("my-skill", "---\ndescription: x\n---\nHello world.")
			const result = await mgr.patch("my-skill", "world", "universe")
			expect(result.success).toBe(true)
			const content = readFileSync(join(tmpDir, "my-skill", "SKILL.md"), "utf-8")
			expect(content).toContain("Hello universe.")
		})

		it("returns error and file_preview on zero matches", async () => {
			await mgr.create("my-skill", "---\ndescription: x\n---\nHello world.")
			const result = await mgr.patch("my-skill", "nonexistent", "X")
			expect(result.success).toBe(false)
			expect(result.file_preview).toBeDefined()
		})

		it("returns error with unique context message on multiple matches", async () => {
			await mgr.create("my-skill", "---\ndescription: x\n---\nfoo foo bar")
			const result = await mgr.patch("my-skill", "foo", "X")
			expect(result.success).toBe(false)
			expect(result.error).toMatch(/unique context/i)
			expect(result.file_preview).toBeDefined()
		})

		it("preserves original on breaking frontmatter patch", async () => {
			await mgr.create("my-skill", "---\ndescription: x\n---\nBody.")
			// Replace body with empty content - this breaks frontmatter (no body)
			const result = await mgr.patch("my-skill", "Body.", "")
			expect(result.success).toBe(false)
			const content = readFileSync(join(tmpDir, "my-skill", "SKILL.md"), "utf-8")
			expect(content).toContain("Body.")
		})

		it("patches file at specific filePath", async () => {
			await mgr.create("my-skill", "---\ndescription: x\n---\nBody.")
			await mgr.writeFile("my-skill", "references/test.md", "Hello world.")
			const result = await mgr.patch("my-skill", "world", "universe", "references/test.md")
			expect(result.success).toBe(true)
			const content = readFileSync(join(tmpDir, "my-skill", "references", "test.md"), "utf-8")
			expect(content).toContain("Hello universe.")
		})
	})

	describe("delete", () => {
		it("removes skill and archives it", async () => {
			await mgr.create("my-skill", "---\ndescription: x\n---\nBody.")
			const result = await mgr.delete("my-skill")
			expect(result.success).toBe(true)
			expect(existsSync(join(tmpDir, "my-skill"))).toBe(false)
			// archive exists
			const archiveDir = join(tmpDir, ".archive")
			const { readdirSync } = await import("node:fs")
			const entries = existsSync(archiveDir) ? readdirSync(archiveDir) : []
			const archived = entries.filter((e) => e.startsWith("my-skill-"))
			expect(archived.length).toBeGreaterThan(0)
		})

		it("handles absorbedInto parameter", async () => {
			await mgr.create("obsolete", "---\ndescription: x\n---\nBody.")
			const result = await mgr.delete("obsolete", "replacement")
			expect(result.success).toBe(true)
		})
	})

	describe("writeFile", () => {
		it("creates file in references/ subdirectory", async () => {
			await mgr.create("my-skill", "---\ndescription: x\n---\nBody.")
			const result = await mgr.writeFile("my-skill", "references/foo.md", "# My Doc\n\nContent.")
			expect(result.success).toBe(true)
			expect(existsSync(join(tmpDir, "my-skill", "references", "foo.md"))).toBe(true)
		})
	})

	describe("removeFile", () => {
		it("removes existing file", async () => {
			await mgr.create("my-skill", "---\ndescription: x\n---\nBody.")
			await mgr.writeFile("my-skill", "references/foo.md", "# Doc")
			const result = await mgr.removeFile("my-skill", "references/foo.md")
			expect(result.success).toBe(true)
			expect(existsSync(join(tmpDir, "my-skill", "references", "foo.md"))).toBe(false)
		})

		it("returns error with available_files for missing path", async () => {
			await mgr.create("my-skill", "---\ndescription: x\n---\nBody.")
			const result = await mgr.removeFile("my-skill", "references/missing.md")
			expect(result.success).toBe(false)
			expect(result.available_files).toBeDefined()
		})

		it("removes empty parent directories", async () => {
			await mgr.create("my-skill", "---\ndescription: x\n---\nBody.")
			await mgr.writeFile("my-skill", "references/foo.md", "# Doc")
			await mgr.removeFile("my-skill", "references/foo.md")
			expect(existsSync(join(tmpDir, "my-skill", "references"))).toBe(false)
		})
	})
})
