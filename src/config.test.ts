import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { clearApiKey, loadConfig, readTelemetryConfig, writeApiKey } from "./config.js"

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
