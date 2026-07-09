import { rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Monkey-patch json.js so readJson / writeJson target a per-test temp file
// instead of the real ~/.config/kimchi/harness/settings.json. The real
// settings.ts logic runs unmodified.
// ---------------------------------------------------------------------------

const testDir = join(tmpdir(), `kimchi-settings-test-${process.pid}`)
const testPath = join(testDir, "settings.json")

/** Set to a non-null Error to make the next readJson call throw. */
let readJsonError: Error | null = null

vi.mock("./json.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("./json.js")>()
	return {
		...original,
		readJson: (_path: string) => {
			if (readJsonError) throw readJsonError
			return original.readJson(testPath)
		},
		writeJson: (_path: string, data: unknown) => original.writeJson(testPath, data),
	}
})

import { writeJson } from "./json.js"
import {
	getConfigSetting,
	readConfigSetting,
	readConfigSettingAsync,
	writeConfigSetting,
	writeConfigSettingAsync,
} from "./settings.js"

// Type-guard helpers used across tests.
const isString = (v: unknown): v is string => typeof v === "string"
const isNumber = (v: unknown): v is number => typeof v === "number"
const isBoolean = (v: unknown): v is boolean => typeof v === "boolean"
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null

/** Seed the temp settings file with given data. */
function seed(data: Record<string, unknown>): void {
	writeJson(testPath, data)
}

/** Read back the temp settings file. */
function readBack(): Record<string, unknown> {
	// We can't call the unmocked readJson synchronously from importActual (it's
	// async). Instead, use the fs directly:
	const { readFileSync } = require("node:fs")
	try {
		return JSON.parse(readFileSync(testPath, "utf-8"))
	} catch {
		return {}
	}
}

beforeEach(() => {
	readJsonError = null
	// Start each test with a clean (empty) settings file
	try {
		rmSync(testDir, { recursive: true, force: true })
	} catch {}
})

afterEach(() => {
	try {
		rmSync(testDir, { recursive: true, force: true })
	} catch {}
})

// ───────────────────────────────────────────────────────────────────────────
// getConfigSetting — pure, no I/O
// ───────────────────────────────────────────────────────────────────────────

describe("getConfigSetting", () => {
	it("returns global config value", () => {
		const config = { theme: "dark" }
		expect(getConfigSetting(config, "theme", isString)).toBe("dark")
	})

	it("returns undefined when key is absent", () => {
		expect(getConfigSetting({}, "missing", isString)).toBeUndefined()
	})

	it("returns undefined when value fails the type guard", () => {
		const config = { count: "not-a-number" }
		expect(getConfigSetting(config, "count", isNumber)).toBeUndefined()
	})
})

// ───────────────────────────────────────────────────────────────────────────
// readConfigSetting — reads from disk (mocked json.js) via readJson
// ───────────────────────────────────────────────────────────────────────────

describe("readConfigSetting", () => {
	it("reads a global setting from the store", () => {
		seed({ multiModel: true })
		expect(readConfigSetting("multiModel", isBoolean)).toBe(true)
	})

	it("returns undefined when key is absent", () => {
		seed({})
		expect(readConfigSetting("missing", isString)).toBeUndefined()
	})

	it("returns undefined when readJson throws (malformed file)", () => {
		readJsonError = new SyntaxError("Unexpected token")
		expect(readConfigSetting("anything", isString)).toBeUndefined()
	})

	it("returns object values when type guard matches", () => {
		seed({ modelRoles: { orchestrator: "some/model" } })
		expect(readConfigSetting("modelRoles", isObject)).toEqual({ orchestrator: "some/model" })
	})
})

// ───────────────────────────────────────────────────────────────────────────
// readConfigSettingAsync
// ───────────────────────────────────────────────────────────────────────────

describe("readConfigSettingAsync", () => {
	it("resolves with the setting value", async () => {
		seed({ color: "blue" })
		await expect(readConfigSettingAsync("color", isString)).resolves.toBe("blue")
	})

	it("resolves with undefined when missing", async () => {
		seed({})
		await expect(readConfigSettingAsync("color", isString)).resolves.toBeUndefined()
	})
})

// ───────────────────────────────────────────────────────────────────────────
// writeConfigSetting
// ───────────────────────────────────────────────────────────────────────────

describe("writeConfigSetting", () => {
	it("writes a setting to an empty store", () => {
		seed({})
		writeConfigSetting("theme", "dark")
		expect(readBack().theme).toBe("dark")
	})

	it("preserves existing keys when writing a new one", () => {
		seed({ existing: 123 })
		writeConfigSetting("theme", "dark")
		const result = readBack()
		expect(result.existing).toBe(123)
		expect(result.theme).toBe("dark")
	})

	it("overwrites an existing key", () => {
		seed({ theme: "light" })
		writeConfigSetting("theme", "dark")
		expect(readBack().theme).toBe("dark")
	})

	it("does not write when value is unchanged (no-op optimization)", () => {
		seed({ theme: "dark" })
		const before = readBack()
		writeConfigSetting("theme", "dark")
		const after = readBack()
		expect(after).toEqual(before)
	})

	it("silently returns when readJson throws (malformed file)", () => {
		readJsonError = new SyntaxError("Unexpected token")
		expect(() => writeConfigSetting("key", "val")).not.toThrow()
	})

	it("handles undefined value", () => {
		seed({ key: "old" })
		writeConfigSetting("key", undefined)
		expect(readBack().key).toBeUndefined()
	})

	it("handles object values", () => {
		seed({})
		writeConfigSetting("modelRoles", { orchestrator: "a/b" })
		expect(readBack().modelRoles).toEqual({ orchestrator: "a/b" })
	})

	it("replaces object value when content changes", () => {
		seed({ modelRoles: { orchestrator: "a/b" } })
		writeConfigSetting("modelRoles", { orchestrator: "c/d" })
		expect(readBack().modelRoles).toEqual({ orchestrator: "c/d" })
	})
})

// ───────────────────────────────────────────────────────────────────────────
// writeConfigSettingAsync
// ───────────────────────────────────────────────────────────────────────────

describe("writeConfigSettingAsync", () => {
	it("resolves after writing", async () => {
		seed({})
		await writeConfigSettingAsync("theme", "dark")
		expect(readBack().theme).toBe("dark")
	})
})
