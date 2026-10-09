// Unit tests for the `_kimchi.dev/list_resources` and
// `_kimchi.dev/set_resource_enabled` ACP extension method handlers. All
// writes go through a temp settings path so the real harness settings are
// never touched.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RequestError } from "@agentclientprotocol/sdk"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { handleListResources, handleSetResourceEnabled } from "./resources.js"

/** Runs fn, returns the thrown RequestError, or fails the test if nothing threw. */
function thrownRequestError(fn: () => unknown): RequestError {
	try {
		fn()
	} catch (error) {
		return error as RequestError
	}
	throw new Error("expected the call to throw a RequestError")
}

function readSettings(settingsPath: string): Record<string, unknown> {
	return JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>
}

describe("handleListResources", () => {
	let tempDir: string
	let settingsPath: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-acp-resources-test-"))
		settingsPath = join(tempDir, "settings.json")
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	it("lists known resources with defaults, effective state, and no override", () => {
		const result = handleListResources({ settingsPath }) as {
			resources: Array<{
				id: string
				kind: string
				enabled: boolean
				defaultEnabled: boolean
				restartRequired: boolean
				experimental: boolean
				overridden: boolean
			}>
		}
		expect(result.resources.length).toBeGreaterThan(0)
		const memory = result.resources.find((r) => r.id === "extensions.memory")
		expect(memory).toMatchObject({
			kind: "extensions",
			enabled: false, // defaultEnabled: false, no override
			defaultEnabled: false,
			restartRequired: true,
			experimental: true,
			overridden: false,
		})
	})

	it("reflects a persisted override in the effective state and the overridden flag", () => {
		handleSetResourceEnabled({ settingsPath }, { resourceId: "extensions.memory", enabled: true })
		const result = handleListResources({ settingsPath }) as {
			resources: Array<{ id: string; enabled: boolean; overridden: boolean }>
		}
		const memory = result.resources.find((r) => r.id === "extensions.memory")
		expect(memory).toMatchObject({ enabled: true, overridden: true })
	})
})

describe("handleSetResourceEnabled", () => {
	let tempDir: string
	let settingsPath: string

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "kimchi-acp-resources-set-test-"))
		settingsPath = join(tempDir, "settings.json")
	})

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true })
	})

	it("persists the override and echoes restartRequired", () => {
		const result = handleSetResourceEnabled({ settingsPath }, { resourceId: "extensions.memory", enabled: true })
		expect(result).toEqual({ id: "extensions.memory", enabled: true, restartRequired: true })
		expect(readSettings(settingsPath)).toEqual({ resources: { "extensions.memory": true } })
	})

	it("a second write with the same value is idempotent, a different value updates", () => {
		handleSetResourceEnabled({ settingsPath }, { resourceId: "extensions.memory", enabled: true })
		handleSetResourceEnabled({ settingsPath }, { resourceId: "extensions.memory", enabled: true })
		expect(readSettings(settingsPath)).toEqual({ resources: { "extensions.memory": true } })
		handleSetResourceEnabled({ settingsPath }, { resourceId: "extensions.memory", enabled: false })
		expect(readSettings(settingsPath)).toEqual({ resources: { "extensions.memory": false } })
	})

	it("rejects a missing or mistyped resourceId", () => {
		const missing = thrownRequestError(() => handleSetResourceEnabled({ settingsPath }, { enabled: true }))
		expect(missing.code).toBe(-32602)
		expect(missing.message).toContain("resourceId")

		const typed = thrownRequestError(() =>
			handleSetResourceEnabled({ settingsPath }, { resourceId: 42, enabled: true }),
		)
		expect(typed.code).toBe(-32602)
	})

	it("rejects a missing or mistyped enabled", () => {
		const missing = thrownRequestError(() =>
			handleSetResourceEnabled({ settingsPath }, { resourceId: "extensions.memory" }),
		)
		expect(missing.code).toBe(-32602)
		expect(missing.message).toContain("enabled")

		const typed = thrownRequestError(() =>
			handleSetResourceEnabled({ settingsPath }, { resourceId: "extensions.memory", enabled: "on" }),
		)
		expect(typed.code).toBe(-32602)
	})

	it("rejects an unknown-but-well-formed resource id — no inert overrides", () => {
		const err = thrownRequestError(() =>
			handleSetResourceEnabled({ settingsPath }, { resourceId: "extensions.no-such-thing", enabled: true }),
		)
		expect(err.code).toBe(-32602)
		expect(err.message).toContain("extensions.no-such-thing")
		// Nothing was written for the unknown id — the settings file was never
		// created.
		expect(existsSync(settingsPath)).toBe(false)
	})

	it("a failed settings write surfaces as internalError, not invalidParams", () => {
		// A settings path whose parent is a regular file — writeJson cannot
		// create the directory (nor read through it), so the write itself
		// fails and the handler classifies it as environmental.
		const blocker = join(tempDir, "not-a-dir")
		writeFileSync(blocker, "occupied")
		const err = thrownRequestError(() =>
			handleSetResourceEnabled(
				{ settingsPath: join(blocker, "settings.json") },
				{ resourceId: "extensions.memory", enabled: true },
			),
		)
		expect(err.code).toBe(-32603)
		expect(err.message).toContain("Failed to persist resource override")
	})
})
