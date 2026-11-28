import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { readModelThinkingLevelDefaults, writeModelThinkingLevelDefault } from "./config.js"
import {
	getModelThinkingLevelDefault,
	MODEL_THINKING_SELECTION_ENTRY_TYPE,
	readSessionThinkingSelections,
} from "./model-thinking.js"

const tempDirs: string[] = []

function makeConfig(initial: Record<string, unknown> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "kimchi-model-thinking-"))
	tempDirs.push(dir)
	const configPath = join(dir, "config.json")
	writeFileSync(configPath, JSON.stringify({ apiKey: "keep-me", ...initial }))
	return configPath
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("Model thinking defaults", () => {
	it("persists one default per concrete model without replacing other config", () => {
		const configPath = makeConfig()

		writeModelThinkingLevelDefault("test/reasoner", "high", configPath)
		writeModelThinkingLevelDefault("test/other", "low", configPath)
		writeModelThinkingLevelDefault("test/reasoner", "max", configPath)

		expect(getModelThinkingLevelDefault("test/reasoner", configPath)).toBe("max")
		expect(getModelThinkingLevelDefault("test/other", configPath)).toBe("low")
		expect(getModelThinkingLevelDefault("test/missing", configPath)).toBeUndefined()
		expect(JSON.parse(readFileSync(configPath, "utf-8"))).toMatchObject({
			apiKey: "keep-me",
			modelEffortDefaults: { "test/reasoner": "max", "test/other": "low" },
		})
	})

	it("reads flat defaults without rewriting configuration", () => {
		const configPath = makeConfig({
			modelEffortDefaults: { "test/flat": "medium" },
			sessionSelections: { test: "keep-session-settings" },
		})
		const originalConfig = readFileSync(configPath, "utf-8")

		expect(readModelThinkingLevelDefaults(configPath)).toEqual({ "test/flat": "medium" })
		expect(readFileSync(configPath, "utf-8")).toBe(originalConfig)
	})

	it("ignores malformed models, unknown levels, and non-string values when reading", () => {
		const configPath = makeConfig({
			modelEffortDefaults: {
				"test/reasoner": "medium",
				"test/invalid": "ultra",
				"test/nonstring": 4,
				"test/nested": { value: "high" },
				"test/array": ["high"],
			},
		})

		expect(getModelThinkingLevelDefault("test/reasoner", configPath)).toBe("medium")
		expect(getModelThinkingLevelDefault("test/invalid", configPath)).toBeUndefined()
		expect(getModelThinkingLevelDefault("test/nonstring", configPath)).toBeUndefined()
		expect(getModelThinkingLevelDefault("test/nested", configPath)).toBeUndefined()
		expect(getModelThinkingLevelDefault("test/array", configPath)).toBeUndefined()
	})

	it("does not resolve model defaults through a __proto__ config key", () => {
		const configPath = makeConfig({
			modelEffortDefaults: JSON.parse('{"__proto__":{"test/prototype":"max"}}'),
		})

		expect(Object.hasOwn(readModelThinkingLevelDefaults(configPath), "__proto__")).toBe(false)

		writeModelThinkingLevelDefault("test/reasoner", "high", configPath)
		expect(getModelThinkingLevelDefault("test/reasoner", configPath)).toBe("high")
	})
})

describe("Session thinkingLevel selections", () => {
	it("replays concrete-model selections with last write winning", () => {
		const entries = [
			{
				type: "custom",
				customType: MODEL_THINKING_SELECTION_ENTRY_TYPE,
				data: { modelId: "test/reasoner", value: "high" },
			},
			{ type: "message", role: "user", content: "unrelated" },
			{
				type: "custom",
				customType: MODEL_THINKING_SELECTION_ENTRY_TYPE,
				data: { modelId: "test/other", value: "low" },
			},
			{
				type: "custom",
				customType: MODEL_THINKING_SELECTION_ENTRY_TYPE,
				data: { modelId: "test/reasoner", value: "max" },
			},
		]

		expect(Object.fromEntries(readSessionThinkingSelections(entries))).toEqual({
			"test/reasoner": "max",
			"test/other": "low",
		})
	})

	it("ignores malformed and unavailable persisted entries", () => {
		const entries = [
			{ type: "custom", customType: MODEL_THINKING_SELECTION_ENTRY_TYPE, data: null },
			{
				type: "custom",
				customType: MODEL_THINKING_SELECTION_ENTRY_TYPE,
				data: { modelId: "test/reasoner", value: "ultra" },
			},
			{
				type: "custom",
				customType: MODEL_THINKING_SELECTION_ENTRY_TYPE,
				data: { modelId: 42, value: "high" },
			},
			{ type: "custom", customType: "another_entry", data: { modelId: "test/other", value: "low" } },
		]

		expect(readSessionThinkingSelections(entries).size).toBe(0)
	})
})
