import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readPRWatchPreference, writePRWatchPreference } from "./settings.js"

vi.mock("@earendil-works/pi-coding-agent", () => ({ getAgentDir: vi.fn() }))

describe("general PR watching preference", () => {
	let directory: string
	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "pr-watch-preference-"))
		vi.mocked(getAgentDir).mockReturnValue(directory)
	})
	afterEach(() => rmSync(directory, { recursive: true, force: true }))

	it("remembers both decisions in user state without changing shared settings", () => {
		const shared = join(directory, "settings.json")
		writeFileSync(shared, '{"theme":"custom"}\n')
		expect(readPRWatchPreference()).toBeUndefined()
		writePRWatchPreference(true)
		expect(JSON.parse(readFileSync(join(directory, "pr-watch.json"), "utf8"))).toEqual({ enabled: true })
		expect(readPRWatchPreference()).toBe(true)
		writePRWatchPreference(false)
		expect(readPRWatchPreference()).toBe(false)
		expect(readFileSync(shared, "utf8")).toBe('{"theme":"custom"}\n')
	})

	it("does not infer consent from an invalid value or corrupt file, and preserves corruption on write", () => {
		const path = join(directory, "pr-watch.json")
		writeFileSync(path, '{"enabled":"yes"}')
		expect(readPRWatchPreference()).toBeUndefined()
		writeFileSync(path, '{"enabled":')
		expect(readPRWatchPreference()).toBeUndefined()
		expect(() => writePRWatchPreference(true)).toThrow()
		expect(readFileSync(path, "utf8")).toBe('{"enabled":')
	})
})
