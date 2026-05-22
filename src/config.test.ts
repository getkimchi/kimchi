import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	clearApiKey,
	loadConfig,
	readTelemetryConfig,
	writeApiKey,
	writeDeviceId,
	writeHideSessionModeDialog,
	writeSessionModeWizardSeenAt,
} from "./config.js"

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

	it("reads deviceId from config file", () => {
		writeFileSync(configPath, JSON.stringify({ deviceId: "550e8400-e29b-41d4-a716-446655440000" }))
		const config = loadConfig({ configPath })
		expect(config.deviceId).toBe("550e8400-e29b-41d4-a716-446655440000")
	})

	it("reads device_id from config file for backward compatibility", () => {
		writeFileSync(configPath, JSON.stringify({ device_id: "550e8400-e29b-41d4-a716-446655440000" }))
		const config = loadConfig({ configPath })
		expect(config.deviceId).toBe("550e8400-e29b-41d4-a716-446655440000")
	})

	it("prefers deviceId over device_id when both are set", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				deviceId: "preferred-uuid",
				device_id: "legacy-uuid",
			}),
		)
		const config = loadConfig({ configPath })
		expect(config.deviceId).toBe("preferred-uuid")
	})

	it("returns empty deviceId when no device ID is found", () => {
		const config = loadConfig({ configPath })
		expect(config.deviceId).toBe("")
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

	it("reads global onboarding state", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				onboarding: {
					sessionModeWizardSeenAt: "2026-05-19T09:30:00.000Z",
					hideSessionModeDialog: true,
				},
			}),
		)

		const config = loadConfig({ configPath })

		expect(config.onboarding.sessionModeWizardSeenAt).toBe("2026-05-19T09:30:00.000Z")
		expect(config.onboarding.hideSessionModeDialog).toBe(true)
	})

	it("reads hyphenated hide session mode dialog config for compatibility", () => {
		writeFileSync(configPath, JSON.stringify({ onboarding: { "hide-session-mode-dialog": true } }))

		const config = loadConfig({ configPath })

		expect(config.onboarding.hideSessionModeDialog).toBe(true)
	})

	it("does not read project onboarding state as global first-run state", () => {
		const globalDir = mkdtempSync(join(tmpdir(), "kimchi-test-"))
		const projectDir = mkdtempSync(join(tmpdir(), "kimchi-test-"))
		const globalPath = join(globalDir, "config.json")
		const projectPath = join(projectDir, ".kimchi", "config.json")

		writeFileSync(globalPath, JSON.stringify({ apiKey: "global-key" }))
		mkdirSync(dirname(projectPath), { recursive: true })
		writeFileSync(projectPath, JSON.stringify({ onboarding: { sessionModeWizardSeenAt: "project" } }))

		const config = loadConfig({ configPath: globalPath, cwd: projectDir })
		expect(config.onboarding.sessionModeWizardSeenAt).toBeUndefined()

		rmSync(globalDir, { recursive: true, force: true })
		rmSync(projectDir, { recursive: true, force: true })
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

	it("round-trips the API key", () => {
		writeApiKey("sekrit-42", configPath)
		const raw = readFileSync(configPath, "utf-8")
		expect(JSON.parse(raw).apiKey).toBe("sekrit-42")
	})

	it("overwrites any previous value", () => {
		writeFileSync(configPath, JSON.stringify({ apiKey: "first" }))
		writeApiKey("second", configPath)
		const raw = readFileSync(configPath, "utf-8")
		expect(JSON.parse(raw).apiKey).toBe("second")
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

	it("removes both apiKey and api_key fields", () => {
		writeFileSync(configPath, JSON.stringify({ apiKey: "a", api_key: "b", other: 1 }))
		clearApiKey(configPath)
		const raw = JSON.parse(readFileSync(configPath, "utf-8"))
		expect(raw).not.toHaveProperty("apiKey")
		expect(raw).not.toHaveProperty("api_key")
		expect(raw.other).toBe(1)
	})

	it("is a no-op when the file does not exist", () => {
		expect(() => clearApiKey(join(tempDir, "missing.json"))).not.toThrow()
	})
})

describe("writeDeviceId", () => {
	let tempDir: string
	let configPath: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-test-device-"))
		configPath = join(tempDir, "config.json")
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	it("writes deviceId field", () => {
		writeDeviceId("550e8400-e29b-41d4-a716-446655440000", configPath)
		const raw = JSON.parse(readFileSync(configPath, "utf-8"))
		expect(raw.deviceId).toBe("550e8400-e29b-41d4-a716-446655440000")
	})

	it("clears legacy device_id field", () => {
		writeFileSync(configPath, JSON.stringify({ device_id: "old-uuid", other: 1 }))
		writeDeviceId("new-uuid", configPath)
		const raw = JSON.parse(readFileSync(configPath, "utf-8"))
		expect(raw.deviceId).toBe("new-uuid")
		expect(raw).not.toHaveProperty("device_id")
	})

	it("overwrites any previous value", () => {
		writeDeviceId("first-uuid", configPath)
		writeDeviceId("second-uuid", configPath)
		const raw = JSON.parse(readFileSync(configPath, "utf-8"))
		expect(raw.deviceId).toBe("second-uuid")
	})
})

describe("readTelemetryConfig", () => {
	let tempDir: string
	let configPath: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-telemetry-test-"))
		configPath = join(tempDir, "config.json")
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	it("picks up telemetry.metricsEndpoint when present", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				telemetry: {
					enabled: true,
					metricsEndpoint: "https://custom.example.com/metrics:ingest",
				},
			}),
		)
		const config = readTelemetryConfig(configPath)
		expect(config.metricsEndpoint).toBe("https://custom.example.com/metrics:ingest")
	})

	it("falls back to default metrics endpoint when absent", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				telemetry: {
					enabled: true,
				},
			}),
		)
		const config = readTelemetryConfig(configPath)
		expect(config.metricsEndpoint).toBe("https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest")
	})

	it("disabled telemetry still returns defaults", () => {
		writeFileSync(configPath, JSON.stringify({}))
		const config = readTelemetryConfig(configPath)
		expect(config.enabled).toBe(false)
		expect(config.metricsEndpoint).toBe("https://api.cast.ai/ai-optimizer/v1beta/metrics:ingest")
	})
})

describe("writeSessionModeWizardSeenAt", () => {
	let tempDir: string
	let configPath: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-test-"))
		configPath = join(tempDir, "config.json")
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	it("writes onboarding.sessionModeWizardSeenAt", () => {
		writeSessionModeWizardSeenAt("2026-05-19T09:30:00.000Z", configPath)
		const raw = JSON.parse(readFileSync(configPath, "utf-8"))
		expect(raw.onboarding.sessionModeWizardSeenAt).toBe("2026-05-19T09:30:00.000Z")
	})

	it("preserves unrelated fields and existing onboarding fields", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				apiKey: "key",
				onboarding: { otherWizardSeenAt: "2026-05-18T10:00:00.000Z" },
			}),
		)

		writeSessionModeWizardSeenAt("2026-05-19T09:30:00.000Z", configPath)
		const raw = JSON.parse(readFileSync(configPath, "utf-8"))

		expect(raw).toEqual({
			apiKey: "key",
			onboarding: {
				otherWizardSeenAt: "2026-05-18T10:00:00.000Z",
				sessionModeWizardSeenAt: "2026-05-19T09:30:00.000Z",
			},
		})
	})
})

describe("writeHideSessionModeDialog", () => {
	let tempDir: string
	let configPath: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-test-"))
		configPath = join(tempDir, "config.json")
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	it("writes onboarding.hideSessionModeDialog", () => {
		writeHideSessionModeDialog(true, configPath)
		const raw = JSON.parse(readFileSync(configPath, "utf-8"))
		expect(raw.onboarding.hideSessionModeDialog).toBe(true)
	})

	it("preserves unrelated fields and existing onboarding fields", () => {
		writeFileSync(
			configPath,
			JSON.stringify({
				apiKey: "key",
				onboarding: { sessionModeWizardSeenAt: "2026-05-19T09:30:00.000Z" },
			}),
		)

		writeHideSessionModeDialog(true, configPath)
		const raw = JSON.parse(readFileSync(configPath, "utf-8"))

		expect(raw).toEqual({
			apiKey: "key",
			onboarding: {
				sessionModeWizardSeenAt: "2026-05-19T09:30:00.000Z",
				hideSessionModeDialog: true,
			},
		})
	})
})
