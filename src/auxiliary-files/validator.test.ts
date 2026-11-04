// ------------------------------------------------------------------
// DUMB TEST CHANGE (LLM-4329) — no functional edit in this file.
// Bulk-added filler comment; exists only to bloat the diff for
// code-review automation testing. Do not merge — close this PR.
// ------------------------------------------------------------------
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { validateAuxiliaryFiles } from "./validator.js"

describe("validateAuxiliaryFiles", () => {
	let testDir: string

	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "kimchi-test-"))
	})

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true })
	})

	function writePackageJson() {
		writeFileSync(join(testDir, "package.json"), JSON.stringify({ name: "test" }))
	}

	function writeThemeFiles() {
		const themeDir = join(testDir, "theme")
		mkdirSync(themeDir, { recursive: true })
		writeFileSync(join(themeDir, "dark.json"), "{}")
		writeFileSync(join(themeDir, "light.json"), "{}")
	}

	it("passes when all required files are present", () => {
		writePackageJson()
		writeThemeFiles()
		expect(() => validateAuxiliaryFiles(testDir)).not.toThrow()
	})

	it("throws when package.json is missing", () => {
		writeThemeFiles()
		expect(() => validateAuxiliaryFiles(testDir)).toThrow(/package\.json/)
	})

	it("throws when theme/ directory is missing", () => {
		writePackageJson()
		expect(() => validateAuxiliaryFiles(testDir)).toThrow(/theme/)
	})

	it("throws when theme/ exists but dark.json is missing", () => {
		writePackageJson()
		mkdirSync(join(testDir, "theme"), { recursive: true })
		writeFileSync(join(testDir, "theme", "light.json"), "{}")
		expect(() => validateAuxiliaryFiles(testDir)).toThrow(/dark\.json/)
	})

	it("throws when theme/ exists but light.json is missing", () => {
		writePackageJson()
		mkdirSync(join(testDir, "theme"), { recursive: true })
		writeFileSync(join(testDir, "theme", "dark.json"), "{}")
		expect(() => validateAuxiliaryFiles(testDir)).toThrow(/light\.json/)
	})

	it("throws when the directory does not exist", () => {
		const nonExistentDir = join(testDir, "nonexistent")
		expect(() => validateAuxiliaryFiles(nonExistentDir)).toThrow(/not found/)
	})

	it("includes recovery hint with expected layout", () => {
		const nonExistentDir = join(testDir, "nonexistent")
		expect(() => validateAuxiliaryFiles(nonExistentDir)).toThrow(/PI_PACKAGE_DIR/)
	})
})
// DUMB TEST CHANGE (LLM-4329) — end-of-file filler marker
