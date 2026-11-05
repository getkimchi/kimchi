import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
	getAgentDir,
	parseCollapseWorkMode,
	readCollapseWorkMode,
	resetCollapseWorkCache,
	writeCollapseWorkMode,
} from "./work-collapse-settings.js"

const ORIGINAL_AGENT_DIR = process.env.KIMCHI_CODING_AGENT_DIR

afterEach(() => {
	if (ORIGINAL_AGENT_DIR === undefined) delete process.env.KIMCHI_CODING_AGENT_DIR
	else process.env.KIMCHI_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR
	resetCollapseWorkCache()
})

function makeDirs(): { globalDir: string; projectDir: string; cwd: string } {
	const root = mkdtempSync(join(tmpdir(), "kimchi-collapse-work-"))
	const globalDir = join(root, "global")
	const projectDir = join(root, "project", ".kimchi")
	const cwd = join(root, "project")
	mkdirSync(globalDir, { recursive: true })
	mkdirSync(projectDir, { recursive: true })
	return { globalDir, projectDir, cwd }
}

function writeGlobal(globalDir: string, content: unknown): void {
	writeFileSync(join(globalDir, "settings.json"), typeof content === "string" ? content : JSON.stringify(content))
}

function writeProject(projectDir: string, content: unknown): void {
	writeFileSync(join(projectDir, "settings.json"), typeof content === "string" ? content : JSON.stringify(content))
}

function setup(): { globalDir: string; projectDir: string; cwd: string } {
	const dirs = makeDirs()
	process.env.KIMCHI_CODING_AGENT_DIR = dirs.globalDir
	return dirs
}

describe("parseCollapseWorkMode", () => {
	it("parses the three modes", () => {
		expect(parseCollapseWorkMode("all")).toBe("all")
		expect(parseCollapseWorkMode("tools")).toBe("tools")
		expect(parseCollapseWorkMode("off")).toBe("off")
	})

	it("accepts aliases and casing", () => {
		expect(parseCollapseWorkMode("Everything")).toBe("all")
		expect(parseCollapseWorkMode("semi")).toBe("tools")
		expect(parseCollapseWorkMode("tools-only")).toBe("tools")
		expect(parseCollapseWorkMode("none")).toBe("off")
	})

	it("accepts booleans for backwards compatibility", () => {
		expect(parseCollapseWorkMode(true)).toBe("all")
		expect(parseCollapseWorkMode(false)).toBe("off")
	})

	it("returns undefined for garbage", () => {
		expect(parseCollapseWorkMode("yes")).toBeUndefined()
		expect(parseCollapseWorkMode(42)).toBeUndefined()
		expect(parseCollapseWorkMode(undefined)).toBeUndefined()
	})
})

describe("readCollapseWorkMode", () => {
	it("defaults to 'all' when no settings files exist", () => {
		const { cwd } = setup()
		expect(readCollapseWorkMode(cwd)).toBe("all")
	})

	it("reads the global harness setting", () => {
		const { globalDir, cwd } = setup()
		writeGlobal(globalDir, { collapseWork: false })
		expect(readCollapseWorkMode(cwd)).toBe("off")
	})

	it("project setting overrides the global one", () => {
		const { globalDir, projectDir, cwd } = setup()
		writeGlobal(globalDir, { collapseWork: false })
		writeProject(projectDir, { collapseWork: "tools" })
		expect(readCollapseWorkMode(cwd)).toBe("tools")
	})

	it("ignores non-boolean, non-mode values and falls back to the default", () => {
		const { globalDir, cwd } = setup()
		writeGlobal(globalDir, { collapseWork: "yes" })
		expect(readCollapseWorkMode(cwd)).toBe("all")
	})

	it("tolerates invalid JSON and falls back to the default", () => {
		const { globalDir, cwd } = setup()
		writeGlobal(globalDir, "{ not json")
		expect(readCollapseWorkMode(cwd)).toBe("all")
	})

	it("tolerates invalid JSON in the project file by falling back to global", () => {
		const { globalDir, projectDir, cwd } = setup()
		writeGlobal(globalDir, { collapseWork: "off" })
		writeProject(projectDir, "{ broken")
		expect(readCollapseWorkMode(cwd)).toBe("off")
	})

	it("caches within the TTL and re-reads afterwards", () => {
		const { globalDir, cwd } = setup()
		writeGlobal(globalDir, { collapseWork: "tools" })
		const t0 = 1_000_000
		expect(readCollapseWorkMode(cwd, t0)).toBe("tools")
		writeGlobal(globalDir, { collapseWork: "off" })
		expect(readCollapseWorkMode(cwd, t0 + 1_000)).toBe("tools")
		expect(readCollapseWorkMode(cwd, t0 + 5_001)).toBe("off")
	})
})

describe("writeCollapseWorkMode", () => {
	it("writes the mode to the global settings and reads it back", () => {
		const { globalDir, cwd } = setup()
		writeCollapseWorkMode("tools")
		resetCollapseWorkCache()
		expect(readCollapseWorkMode(cwd)).toBe("tools")
		const raw = JSON.parse(readFileSync(join(globalDir, "settings.json"), "utf8")) as Record<string, unknown>
		expect(raw.collapseWork).toBe("tools")
	})

	it("merges into existing global settings instead of replacing them", () => {
		const { globalDir } = setup()
		writeGlobal(globalDir, { theme: "kimchi-minimal", quietStartup: true })
		writeCollapseWorkMode("off")
		const raw = JSON.parse(readFileSync(join(globalDir, "settings.json"), "utf8")) as Record<string, unknown>
		expect(raw.theme).toBe("kimchi-minimal")
		expect(raw.quietStartup).toBe(true)
		expect(raw.collapseWork).toBe("off")
	})

	it("creates the settings file when missing", () => {
		const { globalDir } = setup()
		expect(existsSync(join(globalDir, "settings.json"))).toBe(false)
		writeCollapseWorkMode("all")
		expect(existsSync(join(globalDir, "settings.json"))).toBe(true)
	})

	it("write resets the cache so reads observe the new mode", () => {
		const { globalDir, cwd } = setup()
		writeGlobal(globalDir, { collapseWork: "all" })
		const t0 = 1_000_000
		expect(readCollapseWorkMode(cwd, t0)).toBe("all")
		writeCollapseWorkMode("tools")
		expect(readCollapseWorkMode(cwd, t0)).toBe("tools")
	})

	it("getAgentDir respects KIMCHI_CODING_AGENT_DIR", () => {
		const { globalDir } = setup()
		expect(getAgentDir()).toBe(globalDir)
	})
})
