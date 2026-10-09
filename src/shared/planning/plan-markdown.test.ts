import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as diagnostics from "../../extensions/work-attribution/diagnostics.js"
import { derivePlanTitle, fermentPlanFileName, savePlanMarkdown, slugifyPlanName } from "./plan-markdown.js"

describe("slugifyPlanName", () => {
	it("converts a title to kebab-case", () => {
		expect(slugifyPlanName("Fix: Plan persistence (adhoc + ferment)")).toBe("fix-plan-persistence-adhoc-ferment")
	})

	it("collapses whitespace and repeated separators", () => {
		expect(slugifyPlanName("  Add   Auth -- Layer  ")).toBe("add-auth-layer")
	})

	it("falls back to untitled-plan for unusable input", () => {
		expect(slugifyPlanName("")).toBe("untitled-plan")
		expect(slugifyPlanName("—•—")).toBe("untitled-plan")
	})

	it("caps the slug at 48 chars without a trailing dash", () => {
		const slug = slugifyPlanName(`a very long plan title that keeps going ${"x".repeat(60)} and beyond`)
		expect(slug.length).toBeLessThanOrEqual(48)
		expect(slug.endsWith("-")).toBe(false)
	})
})

describe("derivePlanTitle", () => {
	it("uses the first H1 heading", () => {
		expect(derivePlanTitle("# Canonical plan persistence\n\n## Goal\nFix it.\n")).toBe("Canonical plan persistence")
	})

	it("falls back to the first content line of ## Goal", () => {
		expect(derivePlanTitle("## Goal\nFix the bug in permissions.\n\n## Chunks\n- c1\n")).toBe(
			"Fix the bug in permissions.",
		)
	})

	it("returns untitled-plan when neither is present", () => {
		expect(derivePlanTitle("Some prose without structure.")).toBe("untitled-plan")
	})
})

describe("fermentPlanFileName", () => {
	it("combines slug and first 8 chars of the ferment id", () => {
		expect(fermentPlanFileName("Auth Refactor", "019e3a34-ac30-751e-931b-9ddb0c229da3")).toBe(
			"ferment-auth-refactor-019e3a34-ac3",
		)
	})
})

describe("savePlanMarkdown", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "plan-markdown-test-"))
		vi.stubEnv("PI_CODING_AGENT_DIR", join(tmpDir, "agent"))
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
		rmSync(tmpDir, { recursive: true, force: true })
	})

	it("retains distinct plan versions after their worktree is deleted", () => {
		const workId = "11111111-1111-4111-8111-111111111111"
		const cwd = join(tmpDir, "worktree")
		const options = { cwd, name: "My plan", workId }
		const first = savePlanMarkdown({ ...options, planText: "# Plan v1\n" })
		expect(first.snapshotPath).toEqual(expect.any(String))
		if (!first.snapshotPath) throw new Error("Expected retained plan")
		const original = readFileSync(first.snapshotPath, "utf8")
		const second = savePlanMarkdown({ ...options, planText: "# Plan v2\n" })
		expect(second.path).toBe(first.path)
		expect(second.snapshotPath).not.toBe(first.snapshotPath)
		expect(savePlanMarkdown({ ...options, planText: "# Plan v2\n" })).toEqual(second)
		expect(readFileSync(second.path, "utf8")).toContain("# Plan v2")
		rmSync(cwd, { recursive: true })
		expect(readFileSync(first.snapshotPath, "utf8")).toBe(original)
		expect(readdirSync(join(tmpDir, "agent", "work", workId, "plans"))).toHaveLength(2)
	})

	it("keeps the local plan usable when retaining a version fails", () => {
		const terminal = vi.spyOn(console, "warn").mockImplementation(() => {})
		const debug = vi.spyOn(diagnostics, "debugWorkAttribution").mockImplementation(() => {})
		writeFileSync(join(tmpDir, "agent"), "blocked")
		const saved = savePlanMarkdown({
			cwd: join(tmpDir, "worktree"),
			name: "Plan",
			planText: "# Plan",
			workId: "11111111-1111-4111-8111-111111111111",
		})
		expect(saved.snapshotPath).toBeUndefined()
		expect(readFileSync(saved.path, "utf8")).toContain("# Plan")
		expect(debug).toHaveBeenCalledWith("Could not retain plan version:", expect.any(Error))
		// Terminal output would corrupt the TUI.
		expect(terminal).not.toHaveBeenCalled()
	})

	it("creates .kimchi/plans and writes the file, returning the absolute path", () => {
		const { path: filePath } = savePlanMarkdown({
			cwd: tmpDir,
			name: "Canonical Plan Persistence",
			planText: "# Plan\n",
		})
		expect(filePath).toBe(join(tmpDir, ".kimchi", "plans", "canonical-plan-persistence.md"))
		expect(readFileSync(filePath, "utf-8")).toBe("# Plan\n")
	})

	it("overwrites the same file on rework instead of creating a new one", () => {
		const { path: first } = savePlanMarkdown({ cwd: tmpDir, name: "My Plan", planText: "v1\n" })
		const { path: second } = savePlanMarkdown({ cwd: tmpDir, name: "My Plan", planText: "v2\n" })
		expect(second).toBe(first)
		const files = readdirSync(join(tmpDir, ".kimchi", "plans"))
		expect(files).toEqual(["my-plan.md"])
		expect(readFileSync(second, "utf-8")).toBe("v2\n")
	})

	it.each(["\n", "\r\n"])("preserves marker examples and replaces only a leading header (%j)", (newline) => {
		const workId = "11111111-1111-4111-8111-111111111111"
		const previous = "22222222-2222-4222-8222-222222222222"
		const body = [
			"# Metadata plan",
			"",
			"```markdown",
			`<!-- kimchi-work-id: ${previous} -->`,
			"# Example",
			"```",
			"",
		].join(newline)
		const planText = `<!-- kimchi-work-id: ${previous} -->${newline}${body}`
		const { path } = savePlanMarkdown({ cwd: tmpDir, name: "Metadata", planText, workId })
		const saved = readFileSync(path, "utf8")
		expect(saved).toBe(`<!-- kimchi-work-id: ${workId} -->${newline}${body}`)
		savePlanMarkdown({ cwd: tmpDir, name: "Metadata", planText: saved, workId })
		expect(readFileSync(path, "utf8")).toBe(saved)
	})

	it("rewrites metadata-only plans without adding a newline", () => {
		const workId = "11111111-1111-4111-8111-111111111111"
		const { path } = savePlanMarkdown({
			cwd: tmpDir,
			name: "Metadata",
			planText: "<!-- kimchi-work-id: 22222222-2222-4222-8222-222222222222 -->",
			workId,
		})
		expect(readFileSync(path, "utf8")).toBe(`<!-- kimchi-work-id: ${workId} -->`)
	})

	it("does not use timestamped filenames", () => {
		const { path: filePath } = savePlanMarkdown({ cwd: tmpDir, name: "Timing Check", planText: "x\n" })
		expect(filePath).not.toMatch(/plan-\d+\.md$/)
	})

	it("writes distinct files for distinct ferment plan names", () => {
		savePlanMarkdown({ cwd: tmpDir, name: fermentPlanFileName("A", "11111111-aaaa-2222"), planText: "a\n" })
		savePlanMarkdown({ cwd: tmpDir, name: fermentPlanFileName("A", "22222222-bbbb-3333"), planText: "b\n" })
		const files = readdirSync(join(tmpDir, ".kimchi", "plans")).sort()
		expect(files).toEqual(["ferment-a-11111111-aaa.md", "ferment-a-22222222-bbb.md"])
	})

	it("propagates filesystem errors instead of swallowing them", () => {
		// Make .kimchi/plans an existing FILE so mkdirSync cannot turn it into a dir.
		writeFileSync(join(tmpDir, "blocker"), "")
		rmSync(join(tmpDir, "blocker"))
		writeFileSync(join(tmpDir, ".kimchi"), "")
		expect(existsSync(join(tmpDir, ".kimchi"))).toBe(true)
		expect(() => savePlanMarkdown({ cwd: tmpDir, name: "X", planText: "x\n" })).toThrow()
	})
})
