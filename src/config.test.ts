import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { clearApiKey, loadConfig, writeApiKey } from "./config.js"

describe("loadConfig", () => {
	let tempDir: string
	let configPath: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-test-"))
		configPath = join(tempDir, "config.json")
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	it("reads apiKey from config file", () => {
		writeFileSync(configPath, JSON.stringify({ apiKey: "file-key-456" }))
		const config = loadConfig({ configPath })
		expect(config.apiKey).toBe("file-key-456")
	})

	it("reads api_key from config file for backward compatibility", () => {
		writeFileSync(configPath, JSON.stringify({ api_key: "file-key-456" }))
		const config = loadConfig({ configPath })
		expect(config.apiKey).toBe("file-key-456")
	})

	it("prefers apiKey over api_key when both are set", () => {
		writeFileSync(configPath, JSON.stringify({ apiKey: "new-key", api_key: "old-key" }))
		const config = loadConfig({ configPath })
		expect(config.apiKey).toBe("new-key")
	})

	it("returns empty apiKey when no key is found", () => {
		const config = loadConfig({ configPath })
		expect(config.apiKey).toBe("")
	})

	it("reads project config from .kimchi/config.json overriding global", () => {
		const globalDir = mkdtempSync(join(tmpdir(), "kimchi-test-"))
		const projectDir = mkdtempSync(join(tmpdir(), "kimchi-test-"))
		const globalPath = join(globalDir, "config.json")
		const projectPath = join(projectDir, ".kimchi", "config.json")

		writeFileSync(globalPath, JSON.stringify({ apiKey: "global-key" }))
		mkdirSync(dirname(projectPath), { recursive: true })
		writeFileSync(projectPath, JSON.stringify({ apiKey: "project-key" }))

		const config = loadConfig({ configPath: globalPath, cwd: projectDir })
		expect(config.apiKey).toBe("project-key")

		rmSync(globalDir, { recursive: true, force: true })
		rmSync(projectDir, { recursive: true, force: true })
	})

	it("merges mcpSearch shallowly (project overrides only provided keys)", () => {
		const globalDir = mkdtempSync(join(tmpdir(), "kimchi-test-"))
		const projectDir = mkdtempSync(join(tmpdir(), "kimchi-test-"))
		const globalPath = join(globalDir, "config.json")
		const projectPath = join(projectDir, ".kimchi", "config.json")

		writeFileSync(globalPath, JSON.stringify({ mcpSearch: { strategy: "regex", bm25K1: 1.5 } }))
		mkdirSync(dirname(projectPath), { recursive: true })
		writeFileSync(projectPath, JSON.stringify({ mcpSearch: { strategy: "bm25" } }))

		const config = loadConfig({ configPath: globalPath, cwd: projectDir })
		expect(config.mcpSearch.strategy).toBe("bm25")
		expect(config.mcpSearch.bm25K1).toBe(1.5) // inherited from global

		rmSync(globalDir, { recursive: true, force: true })
		rmSync(projectDir, { recursive: true, force: true })
	})

	it("falls back to global when .kimchi/config.json does not exist", () => {
		const globalDir = mkdtempSync(join(tmpdir(), "kimchi-test-"))
		const projectDir = mkdtempSync(join(tmpdir(), "kimchi-test-"))
		const globalPath = join(globalDir, "config.json")

		writeFileSync(globalPath, JSON.stringify({ apiKey: "global-key" }))

		const config = loadConfig({ configPath: globalPath, cwd: projectDir })
		expect(config.apiKey).toBe("global-key")

		rmSync(globalDir, { recursive: true, force: true })
		rmSync(projectDir, { recursive: true, force: true })
	})

	it("project llmEndpoint overrides global", () => {
		const globalDir = mkdtempSync(join(tmpdir(), "kimchi-test-"))
		const projectDir = mkdtempSync(join(tmpdir(), "kimchi-test-"))
		const globalPath = join(globalDir, "config.json")
		const projectPath = join(projectDir, ".kimchi", "config.json")

		writeFileSync(globalPath, JSON.stringify({ apiKey: "key", llmEndpoint: "https://global.example.com" }))
		mkdirSync(dirname(projectPath), { recursive: true })
		writeFileSync(projectPath, JSON.stringify({ apiKey: "key", llmEndpoint: "https://project.example.com" }))

		const config = loadConfig({ configPath: globalPath, cwd: projectDir })
		expect(config.llmEndpoint).toBe("https://project.example.com")

		rmSync(globalDir, { recursive: true, force: true })
		rmSync(projectDir, { recursive: true, force: true })
	})

	it("project skillPaths replaces global (not concatenated)", () => {
		const globalDir = mkdtempSync(join(tmpdir(), "kimchi-test-"))
		const projectDir = mkdtempSync(join(tmpdir(), "kimchi-test-"))
		const globalPath = join(globalDir, "config.json")
		const projectPath = join(projectDir, ".kimchi", "config.json")

		writeFileSync(globalPath, JSON.stringify({ apiKey: "key", skillPaths: ["/global/path"] }))
		mkdirSync(dirname(projectPath), { recursive: true })
		writeFileSync(projectPath, JSON.stringify({ apiKey: "key", skillPaths: ["/project/path"] }))

		const config = loadConfig({ configPath: globalPath, cwd: projectDir })
		expect(config.skillPaths).toEqual(["/project/path"])

		rmSync(globalDir, { recursive: true, force: true })
		rmSync(projectDir, { recursive: true, force: true })
	})

	it("gracefully ignores malformed project config JSON", () => {
		const globalDir = mkdtempSync(join(tmpdir(), "kimchi-test-"))
		const projectDir = mkdtempSync(join(tmpdir(), "kimchi-test-"))
		const globalPath = join(globalDir, "config.json")
		const projectPath = join(projectDir, ".kimchi", "config.json")

		writeFileSync(globalPath, JSON.stringify({ apiKey: "global-key" }))
		mkdirSync(dirname(projectPath), { recursive: true })
		writeFileSync(projectPath, "{ not valid json }")

		const config = loadConfig({ configPath: globalPath, cwd: projectDir })
		expect(config.apiKey).toBe("global-key")

		rmSync(globalDir, { recursive: true, force: true })
		rmSync(projectDir, { recursive: true, force: true })
	})

	it("ignores empty-string project values and falls back to global", () => {
		const globalDir = mkdtempSync(join(tmpdir(), "kimchi-test-"))
		const projectDir = mkdtempSync(join(tmpdir(), "kimchi-test-"))
		const globalPath = join(globalDir, "config.json")
		const projectPath = join(projectDir, ".kimchi", "config.json")

		writeFileSync(globalPath, JSON.stringify({ apiKey: "global-key", llmEndpoint: "https://global.example.com" }))
		mkdirSync(dirname(projectPath), { recursive: true })
		writeFileSync(projectPath, JSON.stringify({ apiKey: "", llmEndpoint: "" }))

		const config = loadConfig({ configPath: globalPath, cwd: projectDir })
		expect(config.apiKey).toBe("global-key")
		expect(config.llmEndpoint).toBe("https://global.example.com")

		rmSync(globalDir, { recursive: true, force: true })
		rmSync(projectDir, { recursive: true, force: true })
	})

	it("does not walk up the directory tree from a subfolder", () => {
		const globalDir = mkdtempSync(join(tmpdir(), "kimchi-test-"))
		const rootDir = mkdtempSync(join(tmpdir(), "kimchi-test-"))
		const subDir = join(rootDir, "src", "components")
		const globalPath = join(globalDir, "config.json")
		const rootProjectPath = join(rootDir, ".kimchi", "config.json")

		writeFileSync(globalPath, JSON.stringify({ apiKey: "global-key" }))
		mkdirSync(dirname(rootProjectPath), { recursive: true })
		writeFileSync(rootProjectPath, JSON.stringify({ apiKey: "root-project-key" }))
		mkdirSync(subDir, { recursive: true })

		// cwd is a subfolder that does NOT have .kimchi/config.json
		const config = loadConfig({ configPath: globalPath, cwd: subDir })
		// Should NOT pick up rootDir/.kimchi/config.json
		// Falls back to global only
		expect(config.apiKey).toBe("global-key")

		rmSync(globalDir, { recursive: true, force: true })
		rmSync(rootDir, { recursive: true, force: true })
	})
})

describe("writeApiKey", () => {
	let tempDir: string
	let configPath: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-test-"))
		configPath = join(tempDir, "config.json")
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	it("writes apiKey to config file", () => {
		writeApiKey("new-key-789", configPath)
		const raw = JSON.parse(readFileSync(configPath, "utf-8"))
		expect(raw.apiKey).toBe("new-key-789")
	})

	it("preserves existing fields when writing apiKey", () => {
		writeFileSync(configPath, JSON.stringify({ migrationState: "done" }))
		writeApiKey("new-key-789", configPath)
		const raw = JSON.parse(readFileSync(configPath, "utf-8"))
		expect(raw).toEqual({ migrationState: "done", apiKey: "new-key-789" })
	})
})

describe("clearApiKey", () => {
	let tempDir: string
	let configPath: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-test-"))
		configPath = join(tempDir, "config.json")
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	it("removes apiKey from config file", () => {
		writeFileSync(configPath, JSON.stringify({ apiKey: "key-to-clear", migrationState: "done" }))
		clearApiKey(configPath)
		const raw = JSON.parse(readFileSync(configPath, "utf-8"))
		expect(raw).toEqual({ migrationState: "done" })
	})

	it("removes legacy api_key from config file", () => {
		writeFileSync(configPath, JSON.stringify({ api_key: "key-to-clear", migrationState: "done" }))
		clearApiKey(configPath)
		const raw = JSON.parse(readFileSync(configPath, "utf-8"))
		expect(raw).toEqual({ migrationState: "done" })
	})

	it("removes both apiKey and api_key when both are present", () => {
		writeFileSync(configPath, JSON.stringify({ apiKey: "new-key", api_key: "old-key", migrationState: "done" }))
		clearApiKey(configPath)
		const raw = JSON.parse(readFileSync(configPath, "utf-8"))
		expect(raw).toEqual({ migrationState: "done" })
	})

	it("is a no-op when config file does not exist", () => {
		expect(() => clearApiKey(configPath)).not.toThrow()
	})
})
