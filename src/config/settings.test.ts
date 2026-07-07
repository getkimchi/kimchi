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
	it("returns global value when sessionId is null", () => {
		const config = { theme: "dark" }
		expect(getConfigSetting(config, null, "theme", isString)).toBe("dark")
	})

	it("returns undefined when key is absent", () => {
		expect(getConfigSetting({}, null, "missing", isString)).toBeUndefined()
	})

	it("returns undefined when value fails the type guard", () => {
		const config = { count: "not-a-number" }
		expect(getConfigSetting(config, null, "count", isNumber)).toBeUndefined()
	})

	it("returns session-scoped value when sessionId is provided", () => {
		const config = {
			theme: "light",
			session_abc: { theme: "dark" },
		}
		expect(getConfigSetting(config, "abc", "theme", isString)).toBe("dark")
	})

	it("falls back to global when session key is missing from session scope", () => {
		const config = {
			theme: "light",
			session_abc: { other: true },
		}
		expect(getConfigSetting(config, "abc", "theme", isString)).toBe("light")
	})

	it("falls back to global when session scope does not exist", () => {
		const config = { theme: "global-value" }
		expect(getConfigSetting(config, "no-such-session", "theme", isString)).toBe("global-value")
	})

	it("session value takes precedence over global", () => {
		const config = {
			fontSize: 12,
			session_s1: { fontSize: 16 },
		}
		expect(getConfigSetting(config, "s1", "fontSize", isNumber)).toBe(16)
	})

	it("returns undefined when session value fails type guard but global also fails", () => {
		const config = {
			count: "nope",
			session_s1: { count: "still-nope" },
		}
		expect(getConfigSetting(config, "s1", "count", isNumber)).toBeUndefined()
	})

	it("falls back to global when session value fails the type guard", () => {
		const config = {
			count: 42,
			session_s1: { count: "not-a-number" },
		}
		expect(getConfigSetting(config, "s1", "count", isNumber)).toBe(42)
	})
})

// ───────────────────────────────────────────────────────────────────────────
// readConfigSetting — reads from disk (mocked json.js) via readJson
// ───────────────────────────────────────────────────────────────────────────

describe("readConfigSetting", () => {
	it("reads a global setting from the store", () => {
		seed({ multiModel: true })
		expect(readConfigSetting(null, "multiModel", isBoolean)).toBe(true)
	})

	it("returns undefined when key is absent", () => {
		seed({})
		expect(readConfigSetting(null, "missing", isString)).toBeUndefined()
	})

	it("returns undefined when readJson throws (malformed file)", () => {
		readJsonError = new SyntaxError("Unexpected token")
		expect(readConfigSetting(null, "anything", isString)).toBeUndefined()
	})

	it("reads a session-scoped setting", () => {
		seed({ session_sess1: { featureFlag: true } })
		expect(readConfigSetting("sess1", "featureFlag", isBoolean)).toBe(true)
	})

	it("falls back to global when session scope lacks the key", () => {
		seed({ featureFlag: false, session_sess1: {} })
		expect(readConfigSetting("sess1", "featureFlag", isBoolean)).toBe(false)
	})

	it("returns object values when type guard matches", () => {
		seed({ modelRoles: { orchestrator: "some/model" } })
		expect(readConfigSetting(null, "modelRoles", isObject)).toEqual({ orchestrator: "some/model" })
	})
})

// ───────────────────────────────────────────────────────────────────────────
// readConfigSettingAsync
// ───────────────────────────────────────────────────────────────────────────

describe("readConfigSettingAsync", () => {
	it("resolves with the setting value", async () => {
		seed({ color: "blue" })
		await expect(readConfigSettingAsync(null, "color", isString)).resolves.toBe("blue")
	})

	it("resolves with undefined when missing", async () => {
		seed({})
		await expect(readConfigSettingAsync(null, "color", isString)).resolves.toBeUndefined()
	})
})

// ───────────────────────────────────────────────────────────────────────────
// writeConfigSetting
// ───────────────────────────────────────────────────────────────────────────

describe("writeConfigSetting", () => {
	it("writes a global setting to an empty store", () => {
		seed({})
		writeConfigSetting(null, "theme", "dark")
		expect(readBack().theme).toBe("dark")
	})

	it("preserves existing keys when writing a new one", () => {
		seed({ existing: 123 })
		writeConfigSetting(null, "theme", "dark")
		const result = readBack()
		expect(result.existing).toBe(123)
		expect(result.theme).toBe("dark")
	})

	it("overwrites an existing global key", () => {
		seed({ theme: "light" })
		writeConfigSetting(null, "theme", "dark")
		expect(readBack().theme).toBe("dark")
	})

	it("does not write when value is unchanged (no-op optimization)", () => {
		seed({ theme: "dark" })
		const before = readBack()
		writeConfigSetting(null, "theme", "dark")
		const after = readBack()
		expect(after).toEqual(before)
	})

	it("writes a session-scoped setting", () => {
		seed({})
		writeConfigSetting("sess1", "featureFlag", true)
		expect((readBack().session_sess1 as Record<string, unknown>).featureFlag).toBe(true)
	})

	it("creates the session scope object if absent", () => {
		seed({ globalKey: "val" })
		writeConfigSetting("sess2", "model", "gpt-4o")
		const result = readBack()
		expect(result.session_sess2).toBeDefined()
		expect((result.session_sess2 as Record<string, unknown>).model).toBe("gpt-4o")
	})

	it("preserves other session-scoped keys", () => {
		seed({ session_s1: { a: 1, b: 2 } })
		writeConfigSetting("s1", "c", 3)
		const session = readBack().session_s1 as Record<string, unknown>
		expect(session.a).toBe(1)
		expect(session.b).toBe(2)
		expect(session.c).toBe(3)
	})

	it("does not write when session value is unchanged", () => {
		seed({ session_s1: { flag: true } })
		const before = readBack()
		writeConfigSetting("s1", "flag", true)
		expect(readBack()).toEqual(before)
	})

	it("silently returns when readJson throws (malformed file)", () => {
		readJsonError = new SyntaxError("Unexpected token")
		expect(() => writeConfigSetting(null, "key", "val")).not.toThrow()
	})

	it("handles undefined value at global scope", () => {
		seed({ key: "old" })
		writeConfigSetting(null, "key", undefined)
		expect(readBack().key).toBeUndefined()
	})

	it("handles object values", () => {
		seed({})
		writeConfigSetting(null, "modelRoles", { orchestrator: "a/b" })
		expect(readBack().modelRoles).toEqual({ orchestrator: "a/b" })
	})

	it("replaces object value when content changes", () => {
		seed({ modelRoles: { orchestrator: "a/b" } })
		writeConfigSetting(null, "modelRoles", { orchestrator: "c/d" })
		expect(readBack().modelRoles).toEqual({ orchestrator: "c/d" })
	})
})

// ───────────────────────────────────────────────────────────────────────────
// writeConfigSettingAsync
// ───────────────────────────────────────────────────────────────────────────

describe("writeConfigSettingAsync", () => {
	it("resolves after writing", async () => {
		seed({})
		await writeConfigSettingAsync(null, "theme", "dark")
		expect(readBack().theme).toBe("dark")
	})

	it("resolves for session-scoped writes", async () => {
		seed({})
		await writeConfigSettingAsync("s1", "key", 42)
		expect((readBack().session_s1 as Record<string, unknown>).key).toBe(42)
	})
})
