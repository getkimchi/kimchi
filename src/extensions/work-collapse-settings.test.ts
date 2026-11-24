import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { resetProjectScopeTrustForTests, setProjectScopeTrusted } from "../project-scope-trust.js"
import {
	getAgentDir,
	isCollapseWorkOverriddenByProject,
	parseCollapseWorkMode,
	readCollapseWorkMode,
	resetCollapseWorkCache,
	resolveCollapseWorkProjectTrust,
	writeCollapseWorkMode,
} from "./work-collapse-settings.js"

const ORIGINAL_AGENT_DIR = process.env.KIMCHI_CODING_AGENT_DIR

afterEach(() => {
	if (ORIGINAL_AGENT_DIR === undefined) delete process.env.KIMCHI_CODING_AGENT_DIR
	else process.env.KIMCHI_CODING_AGENT_DIR = ORIGINAL_AGENT_DIR
	resetCollapseWorkCache()
	resetProjectScopeTrustForTests()
})

interface Dirs {
	root: string
	globalDir: string
	projectDir: string
	cwd: string
	globalSettings: string
	projectSettings: string
}

function makeDirs(): Dirs {
	const root = mkdtempSync(join(tmpdir(), "kimchi-collapse-work-"))
	const globalDir = join(root, "global")
	const projectDir = join(root, "project", ".kimchi")
	const cwd = join(root, "project")
	mkdirSync(globalDir, { recursive: true })
	mkdirSync(projectDir, { recursive: true })
	return {
		root,
		globalDir,
		projectDir,
		cwd,
		globalSettings: join(globalDir, "settings.json"),
		projectSettings: join(projectDir, "settings.json"),
	}
}

function writeFile(path: string, content: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true })
	writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content))
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>
}

function setup(): Dirs {
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
		const { cwd, globalSettings } = setup()
		writeFile(globalSettings, { collapseWork: false })
		expect(readCollapseWorkMode(cwd)).toBe("off")
	})

	it("project setting overrides the global one when the project is trusted", () => {
		const { cwd, globalSettings, projectSettings } = setup()
		writeFile(globalSettings, { collapseWork: false })
		writeFile(projectSettings, { collapseWork: "tools" })
		expect(readCollapseWorkMode(cwd, { projectTrusted: true })).toBe("tools")
	})

	it("ignores the project file when projectTrusted is not passed", () => {
		const { cwd, globalSettings, projectSettings } = setup()
		writeFile(globalSettings, { collapseWork: "off" })
		writeFile(projectSettings, { collapseWork: "all" })
		expect(readCollapseWorkMode(cwd)).toBe("off")
	})

	it("ignores the project file when projectTrusted is false", () => {
		const { cwd, projectSettings } = setup()
		writeFile(projectSettings, { collapseWork: "off" })
		expect(readCollapseWorkMode(cwd, { projectTrusted: false })).toBe("all")
	})

	it("only reads the cwd it is given, never process.cwd()", () => {
		const { cwd, projectSettings } = setup()
		writeFile(projectSettings, { collapseWork: "off" })
		const other = mkdtempSync(join(tmpdir(), "kimchi-collapse-work-other-"))
		expect(readCollapseWorkMode(other, { projectTrusted: true })).toBe("all")
		expect(readCollapseWorkMode(cwd, { projectTrusted: true })).toBe("off")
		rmSync(other, { recursive: true, force: true })
	})

	it("ignores non-boolean, non-mode values and falls back to the default", () => {
		const { cwd, globalSettings } = setup()
		writeFile(globalSettings, { collapseWork: "yes" })
		expect(readCollapseWorkMode(cwd)).toBe("all")
	})

	it("tolerates invalid JSON and falls back to the default", () => {
		const { cwd, globalSettings } = setup()
		writeFile(globalSettings, "{ not json")
		expect(readCollapseWorkMode(cwd)).toBe("all")
	})

	it("tolerates invalid JSON in the project file by falling back to global", () => {
		const { cwd, globalSettings, projectSettings } = setup()
		writeFile(globalSettings, { collapseWork: "off" })
		writeFile(projectSettings, "{ broken")
		expect(readCollapseWorkMode(cwd, { projectTrusted: true })).toBe("off")
	})

	it("tolerates a UTF-8 BOM in the global settings file", () => {
		const { cwd, globalSettings } = setup()
		writeFile(globalSettings, `\uFEFF${JSON.stringify({ collapseWork: "tools" })}`)
		expect(readCollapseWorkMode(cwd)).toBe("tools")
	})

	it("tolerates a UTF-8 BOM in the project settings file", () => {
		const { cwd, projectSettings } = setup()
		writeFile(projectSettings, `\uFEFF${JSON.stringify({ collapseWork: "off" })}`)
		expect(readCollapseWorkMode(cwd, { projectTrusted: true })).toBe("off")
	})

	it("caches within the TTL and re-reads afterwards", () => {
		const { cwd, globalSettings } = setup()
		writeFile(globalSettings, { collapseWork: "tools" })
		const t0 = 1_000_000
		expect(readCollapseWorkMode(cwd, { now: t0 })).toBe("tools")
		writeFile(globalSettings, { collapseWork: "off" })
		expect(readCollapseWorkMode(cwd, { now: t0 + 1_000 })).toBe("tools")
		expect(readCollapseWorkMode(cwd, { now: t0 + 5_001 })).toBe("off")
	})

	it("does not serve a cached global-only value to a trusted read of the same cwd", () => {
		const { cwd, projectSettings } = setup()
		const t0 = 1_000_000
		expect(readCollapseWorkMode(cwd, { now: t0 })).toBe("all")
		writeFile(projectSettings, { collapseWork: "off" })
		expect(readCollapseWorkMode(cwd, { now: t0, projectTrusted: true })).toBe("off")
	})
})

describe("isCollapseWorkOverriddenByProject", () => {
	it("is false when the project is untrusted even if the file defines the key", () => {
		const { cwd, projectSettings } = setup()
		writeFile(projectSettings, { collapseWork: "off" })
		expect(isCollapseWorkOverriddenByProject(cwd)).toBe(false)
		expect(isCollapseWorkOverriddenByProject(cwd, { projectTrusted: false })).toBe(false)
	})

	it("is true when the project is trusted and the file defines a valid mode", () => {
		const { cwd, projectSettings } = setup()
		writeFile(projectSettings, { collapseWork: "tools" })
		expect(isCollapseWorkOverriddenByProject(cwd, { projectTrusted: true })).toBe(true)
	})

	it("is false when the trusted project file does not define the key", () => {
		const { cwd, projectSettings } = setup()
		writeFile(projectSettings, { theme: "kimchi-minimal" })
		expect(isCollapseWorkOverriddenByProject(cwd, { projectTrusted: true })).toBe(false)
	})

	it("is false when the trusted project file is unparseable", () => {
		const { cwd, projectSettings } = setup()
		writeFile(projectSettings, "{ broken")
		expect(isCollapseWorkOverriddenByProject(cwd, { projectTrusted: true })).toBe(false)
	})
})

describe("writeCollapseWorkMode", () => {
	it("writes the mode to the global settings and reads it back", () => {
		const { cwd, globalSettings } = setup()
		const result = writeCollapseWorkMode("tools")
		expect(result).toEqual({ ok: true, path: globalSettings, scope: "global" })
		expect(readCollapseWorkMode(cwd)).toBe("tools")
		expect(readJson(globalSettings).collapseWork).toBe("tools")
	})

	it("merges into existing global settings instead of replacing them", () => {
		const { globalSettings } = setup()
		writeFile(globalSettings, { theme: "kimchi-minimal", quietStartup: true })
		writeCollapseWorkMode("off")
		const raw = readJson(globalSettings)
		expect(raw.theme).toBe("kimchi-minimal")
		expect(raw.quietStartup).toBe(true)
		expect(raw.collapseWork).toBe("off")
	})

	it("creates the settings file when missing", () => {
		const { globalSettings } = setup()
		expect(existsSync(globalSettings)).toBe(false)
		expect(writeCollapseWorkMode("all").ok).toBe(true)
		expect(existsSync(globalSettings)).toBe(true)
	})

	it("creates a missing agent directory", () => {
		const root = mkdtempSync(join(tmpdir(), "kimchi-collapse-work-mkdir-"))
		const agentDir = join(root, "deep", "nested", "harness")
		process.env.KIMCHI_CODING_AGENT_DIR = agentDir
		expect(existsSync(agentDir)).toBe(false)
		const result = writeCollapseWorkMode("tools")
		expect(result).toEqual({ ok: true, path: join(agentDir, "settings.json"), scope: "global" })
		expect(readJson(join(agentDir, "settings.json")).collapseWork).toBe("tools")
	})

	it("refuses to write over malformed JSON and leaves the file byte-identical", () => {
		const { globalSettings } = setup()
		const original = `{ "theme": "kimchi-minimal", // comment\n}`
		writeFile(globalSettings, original)
		const result = writeCollapseWorkMode("off")
		expect(result.ok).toBe(false)
		expect(result.ok === false && result.error).toContain("refusing to overwrite")
		expect(readFileSync(globalSettings, "utf8")).toBe(original)
	})

	it("refuses to write over a UTF-16/BOM-less partial write without losing bytes", () => {
		const { globalSettings } = setup()
		const original = `{"theme": "kimchi-minimal", "model": "x"`
		writeFile(globalSettings, original)
		expect(writeCollapseWorkMode("tools").ok).toBe(false)
		expect(readFileSync(globalSettings, "utf8")).toBe(original)
	})

	it("refuses to write over a non-object JSON root", () => {
		const { globalSettings } = setup()
		writeFile(globalSettings, "[1, 2, 3]")
		expect(writeCollapseWorkMode("tools").ok).toBe(false)
		expect(readFileSync(globalSettings, "utf8")).toBe("[1, 2, 3]")
	})

	it("merges into a BOM-prefixed settings file (BOM stripped before parsing)", () => {
		const { globalSettings } = setup()
		writeFile(globalSettings, `\uFEFF${JSON.stringify({ theme: "kimchi-minimal" })}`)
		expect(writeCollapseWorkMode("off").ok).toBe(true)
		const raw = readJson(globalSettings)
		expect(raw.theme).toBe("kimchi-minimal")
		expect(raw.collapseWork).toBe("off")
	})

	it("leaves no temp file behind", () => {
		const { globalDir } = setup()
		writeCollapseWorkMode("tools")
		const leftovers = readdirSync(globalDir).filter((name) => name.endsWith(".tmp"))
		expect(leftovers).toEqual([])
	})

	// Windows has no POSIX mode bits.
	it.skipIf(process.platform === "win32")("writes the settings file with mode 0600", () => {
		const { globalSettings } = setup()
		writeCollapseWorkMode("tools")
		expect(statSync(globalSettings).mode & 0o777).toBe(0o600)
	})

	it("write resets the cache so reads observe the new mode", () => {
		const { cwd, globalSettings } = setup()
		writeFile(globalSettings, { collapseWork: "all" })
		const t0 = 1_000_000
		expect(readCollapseWorkMode(cwd, { now: t0 })).toBe("all")
		expect(writeCollapseWorkMode("tools").ok).toBe(true)
		expect(readCollapseWorkMode(cwd, { now: t0 })).toBe("tools")
	})

	it("writes global when the project is trusted but does not override the mode", () => {
		const { cwd, globalSettings, projectSettings } = setup()
		writeFile(projectSettings, { theme: "kimchi-minimal" })
		const result = writeCollapseWorkMode("off", { cwd, projectTrusted: true })
		expect(result).toEqual({ ok: true, path: globalSettings, scope: "global" })
		expect(readJson(globalSettings).collapseWork).toBe("off")
		expect(readJson(projectSettings)).toEqual({ theme: "kimchi-minimal" })
	})

	it("writes global when the project overrides the mode but is untrusted", () => {
		const { cwd, globalSettings, projectSettings } = setup()
		writeFile(projectSettings, { collapseWork: "all" })
		const result = writeCollapseWorkMode("off", { cwd, projectTrusted: false })
		expect(result).toEqual({ ok: true, path: globalSettings, scope: "global" })
		expect(readJson(globalSettings).collapseWork).toBe("off")
		expect(readJson(projectSettings).collapseWork).toBe("all")
	})

	it("writes global when no cwd is given", () => {
		const { globalSettings, projectSettings } = setup()
		writeFile(projectSettings, { collapseWork: "all" })
		const result = writeCollapseWorkMode("off", { projectTrusted: true })
		expect(result).toEqual({ ok: true, path: globalSettings, scope: "global" })
		expect(readJson(projectSettings).collapseWork).toBe("all")
	})

	it("writes the project file when trusted and the project already overrides the mode", () => {
		const { cwd, globalSettings, projectSettings } = setup()
		writeFile(globalSettings, { collapseWork: "all" })
		writeFile(projectSettings, { collapseWork: "all", theme: "kimchi-minimal" })
		const result = writeCollapseWorkMode("tools", { cwd, projectTrusted: true })
		expect(result).toEqual({ ok: true, path: projectSettings, scope: "project" })
		const projectRaw = readJson(projectSettings)
		expect(projectRaw.collapseWork).toBe("tools")
		expect(projectRaw.theme).toBe("kimchi-minimal")
		// The global file is untouched.
		expect(readJson(globalSettings)).toEqual({ collapseWork: "all" })
		// And a trusted read now sees the new value.
		expect(readCollapseWorkMode(cwd, { projectTrusted: true })).toBe("tools")
	})

	it("never touches a malformed trusted project file and falls back to global", () => {
		const { cwd, globalSettings, projectSettings } = setup()
		writeFile(projectSettings, "{ broken")
		const result = writeCollapseWorkMode("tools", { cwd, projectTrusted: true })
		// An unparseable project file cannot be merged into, so the write is safe
		// only because it lands in the global file instead.
		expect(result).toEqual({ ok: true, path: globalSettings, scope: "global" })
		expect(readFileSync(projectSettings, "utf8")).toBe("{ broken")
		expect(readJson(globalSettings).collapseWork).toBe("tools")
	})

	it("does not throw when the settings path is not writable", () => {
		const { root } = setup()
		// A regular file where the agent dir should be makes mkdir fail (ENOTDIR).
		const blocker = join(root, "not-a-dir")
		writeFileSync(blocker, "")
		const agentDir = join(blocker, "harness")
		process.env.KIMCHI_CODING_AGENT_DIR = agentDir
		const result = writeCollapseWorkMode("tools")
		expect(result.ok).toBe(false)
		expect(result.ok === false && result.error).toContain("cannot write")
	})

	it("does not throw when the settings path is a directory", () => {
		const { root } = setup()
		const agentDir = join(root, "blocked")
		mkdirSync(join(agentDir, "settings.json"), { recursive: true })
		process.env.KIMCHI_CODING_AGENT_DIR = agentDir
		const result = writeCollapseWorkMode("tools")
		expect(result.ok).toBe(false)
		expect(result.ok === false && result.error).toContain("refusing to overwrite")
	})

	it("getAgentDir respects KIMCHI_CODING_AGENT_DIR", () => {
		const { globalDir } = setup()
		expect(getAgentDir()).toBe(globalDir)
	})
})

describe("resolveCollapseWorkProjectTrust", () => {
	it("fails closed for an unrecorded cwd", () => {
		const { cwd } = setup()
		expect(resolveCollapseWorkProjectTrust(cwd)).toBe(false)
	})

	it("reflects the project-scope gate, including ancestor grants", () => {
		const { root, cwd } = setup()
		setProjectScopeTrusted(root, true)
		expect(resolveCollapseWorkProjectTrust(cwd)).toBe(true)
		setProjectScopeTrusted(root, false)
		expect(resolveCollapseWorkProjectTrust(cwd)).toBe(false)
	})

	it("round-trips into readCollapseWorkMode as the trust argument", () => {
		const { cwd, projectSettings } = setup()
		writeFile(projectSettings, { collapseWork: "off" })
		setProjectScopeTrusted(cwd, true)
		expect(readCollapseWorkMode(cwd, { projectTrusted: resolveCollapseWorkProjectTrust(cwd) })).toBe("off")
		resetProjectScopeTrustForTests()
		expect(readCollapseWorkMode(cwd, { projectTrusted: resolveCollapseWorkProjectTrust(cwd) })).toBe("all")
	})
})
