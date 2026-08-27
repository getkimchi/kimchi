import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
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
	})

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
	})

	it("creates .kimchi/plans and writes the file, returning the absolute path", () => {
		const filePath = savePlanMarkdown({ cwd: tmpDir, name: "Canonical Plan Persistence", planText: "# Plan\n" })
		expect(filePath).toBe(join(tmpDir, ".kimchi", "plans", "canonical-plan-persistence.md"))
		expect(readFileSync(filePath, "utf-8")).toBe("# Plan\n")
	})

	it("overwrites the same file on rework instead of creating a new one", () => {
		const first = savePlanMarkdown({ cwd: tmpDir, name: "My Plan", planText: "v1\n" })
		const second = savePlanMarkdown({ cwd: tmpDir, name: "My Plan", planText: "v2\n" })
		expect(second).toBe(first)
		const files = readdirSync(join(tmpDir, ".kimchi", "plans"))
		expect(files).toEqual(["my-plan.md"])
		expect(readFileSync(second, "utf-8")).toBe("v2\n")
	})

	it("does not use timestamped filenames", () => {
		const filePath = savePlanMarkdown({ cwd: tmpDir, name: "Timing Check", planText: "x\n" })
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
