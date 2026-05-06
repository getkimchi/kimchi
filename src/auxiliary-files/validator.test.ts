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

	function writePluginFiles() {
		for (const sub of ["orchestrator-workflows", "docs-curator"]) {
			const subDir = join(testDir, "plugins", "kimchi-awesome-orchestrator", sub)
			mkdirSync(subDir, { recursive: true })
			writeFileSync(join(subDir, "plugin.json"), "{}")
		}
	}

	it("passes when all required files are present", () => {
		writePackageJson()
		writeThemeFiles()
		writePluginFiles()
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

	it("throws when orchestrator-workflows plugin.json is missing", () => {
		writePackageJson()
		writeThemeFiles()
		// only write docs-curator, omit orchestrator-workflows
		const subDir = join(testDir, "plugins", "kimchi-awesome-orchestrator", "docs-curator")
		mkdirSync(subDir, { recursive: true })
		writeFileSync(join(subDir, "plugin.json"), "{}")
		expect(() => validateAuxiliaryFiles(testDir)).toThrow(/orchestrator-workflows/)
	})

	it("throws when docs-curator plugin.json is missing", () => {
		writePackageJson()
		writeThemeFiles()
		// only write orchestrator-workflows, omit docs-curator
		const subDir = join(testDir, "plugins", "kimchi-awesome-orchestrator", "orchestrator-workflows")
		mkdirSync(subDir, { recursive: true })
		writeFileSync(join(subDir, "plugin.json"), "{}")
		expect(() => validateAuxiliaryFiles(testDir)).toThrow(/docs-curator/)
	})

	it("resolves plugin root from src/plugins/ layout (dev mode)", () => {
		writePackageJson()
		writeThemeFiles()
		// write under src/plugins/ instead of plugins/
		for (const sub of ["orchestrator-workflows", "docs-curator"]) {
			const subDir = join(testDir, "src", "plugins", "kimchi-awesome-orchestrator", sub)
			mkdirSync(subDir, { recursive: true })
			writeFileSync(join(subDir, "plugin.json"), "{}")
		}
		expect(() => validateAuxiliaryFiles(testDir)).not.toThrow()
	})
})
