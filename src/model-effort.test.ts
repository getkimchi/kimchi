import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { readModelEffortDefaults, writeModelEffortDefault } from "./config.js"
import {
	getModelEffortDefault,
	MODEL_EFFORT_SELECTION_ENTRY_TYPE,
	readSessionEffortSelections,
} from "./model-effort.js"

const tempDirs: string[] = []

function makeConfig(initial: Record<string, unknown> = {}): string {
	const dir = mkdtempSync(join(tmpdir(), "kimchi-model-effort-"))
	tempDirs.push(dir)
	const configPath = join(dir, "config.json")
	writeFileSync(configPath, JSON.stringify({ apiKey: "keep-me", ...initial }))
	return configPath
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("Model effort defaults", () => {
	it("persists concrete-model values independently per App-mode without replacing other config", () => {
		const configPath = makeConfig()

		writeModelEffortDefault("chat", "test/reasoner", "high", configPath)
		writeModelEffortDefault("design", "test/reasoner", "low", configPath)
		writeModelEffortDefault("code", "test/reasoner", "max", configPath)

		expect(getModelEffortDefault("chat", "test/reasoner", configPath)).toBe("high")
		expect(getModelEffortDefault("design", "test/reasoner", configPath)).toBe("low")
		expect(getModelEffortDefault("code", "test/reasoner", configPath)).toBe("max")
		expect(getModelEffortDefault("chat", "test/other", configPath)).toBeUndefined()
		expect(JSON.parse(readFileSync(configPath, "utf-8"))).toMatchObject({ apiKey: "keep-me" })
	})

	it("ignores malformed modes, models, and unknown levels when reading", () => {
		const configPath = makeConfig({
			modelEffortDefaults: {
				chat: { "test/reasoner": "medium", "test/invalid": "ultra", "test/nonstring": 4 },
				code: ["high"],
				unknown: { "test/reasoner": "high" },
			},
		})

		expect(getModelEffortDefault("chat", "test/reasoner", configPath)).toBe("medium")
		expect(getModelEffortDefault("chat", "test/invalid", configPath)).toBeUndefined()
		expect(getModelEffortDefault("chat", "test/nonstring", configPath)).toBeUndefined()
		expect(getModelEffortDefault("code", "test/reasoner", configPath)).toBeUndefined()
	})

	it("does not resolve App-mode defaults through a __proto__ config key", () => {
		const configPath = makeConfig({
			modelEffortDefaults: JSON.parse('{"__proto__":{"chat":"max"}}'),
		})

		expect(readModelEffortDefaults(configPath).chat).toBeUndefined()

		writeModelEffortDefault("chat", "test/reasoner", "high", configPath)
		expect(getModelEffortDefault("chat", "test/reasoner", configPath)).toBe("high")
	})
})

describe("Session effort selections", () => {
	it("replays concrete-model selections with last write winning", () => {
		const entries = [
			{
				type: "custom",
				customType: MODEL_EFFORT_SELECTION_ENTRY_TYPE,
				data: { modelId: "test/reasoner", value: "high" },
			},
			{ type: "message", role: "user", content: "unrelated" },
			{
				type: "custom",
				customType: MODEL_EFFORT_SELECTION_ENTRY_TYPE,
				data: { modelId: "test/other", value: "low" },
			},
			{
				type: "custom",
				customType: MODEL_EFFORT_SELECTION_ENTRY_TYPE,
				data: { modelId: "test/reasoner", value: "max" },
			},
		]

		expect(Object.fromEntries(readSessionEffortSelections(entries))).toEqual({
			"test/reasoner": "max",
			"test/other": "low",
		})
	})

	it("ignores malformed and unavailable persisted entries", () => {
		const entries = [
			{ type: "custom", customType: MODEL_EFFORT_SELECTION_ENTRY_TYPE, data: null },
			{
				type: "custom",
				customType: MODEL_EFFORT_SELECTION_ENTRY_TYPE,
				data: { modelId: "test/reasoner", value: "ultra" },
			},
			{
				type: "custom",
				customType: MODEL_EFFORT_SELECTION_ENTRY_TYPE,
				data: { modelId: 42, value: "high" },
			},
			{ type: "custom", customType: "another_entry", data: { modelId: "test/other", value: "low" } },
		]

		expect(readSessionEffortSelections(entries).size).toBe(0)
	})
})
