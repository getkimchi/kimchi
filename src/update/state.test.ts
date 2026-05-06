import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { isStale, isUpdateCheckDisabled, loadRepoState, saveRepoState } from "./state.js"

describe("update state cache", () => {
	let tmp: string
	let prevHome: string | undefined
	let prevXdg: string | undefined

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "kimchi-update-state-test-"))
		prevHome = process.env.HOME
		prevXdg = process.env.XDG_CACHE_HOME
		// statePath() consults XDG_CACHE_HOME first; pin it at the temp dir
		// so the test never touches the developer's real ~/.cache/kimchi.
		process.env.XDG_CACHE_HOME = tmp
	})

	afterEach(() => {
		// biome-ignore lint/performance/noDelete: env-var cleanup needs a real delete; assigning undefined would coerce to the literal string "undefined".
		if (prevHome === undefined) delete process.env.HOME
		else process.env.HOME = prevHome
		// biome-ignore lint/performance/noDelete: same as above.
		if (prevXdg === undefined) delete process.env.XDG_CACHE_HOME
		else process.env.XDG_CACHE_HOME = prevXdg
		rmSync(tmp, { recursive: true, force: true })
	})

	function statePathFor(): string {
		return join(tmp, "kimchi", "state.json")
	}

	function writeRawState(json: unknown): void {
		const path = statePathFor()
		mkdirSync(join(tmp, "kimchi"), { recursive: true })
		writeFileSync(path, JSON.stringify(json, null, 2))
	}

	it("returns null for a missing state file", () => {
		expect(loadRepoState("castai", "kimchi")).toBeNull()
	})

	it("round-trips per-repo state through saveRepoState + loadRepoState", () => {
		saveRepoState("castai", "kimchi", {
			checked_at: "2023-11-14T22:13:20.000Z",
			latest_version: "1.2.3",
			release_url: "https://github.com/castai/kimchi/releases/tag/v1.2.3",
		})
		const got = loadRepoState("castai", "kimchi")
		expect(got).toEqual({
			checked_at: "2023-11-14T22:13:20.000Z",
			latest_version: "1.2.3",
			release_url: "https://github.com/castai/kimchi/releases/tag/v1.2.3",
		})
	})

	it("preserves entries for other repos when updating one", () => {
		saveRepoState("a", "b", { checked_at: "2026-01-01T00:00:00Z", latest_version: "1.0.0" })
		saveRepoState("c", "d", { checked_at: "2026-01-02T00:00:00Z", latest_version: "2.0.0" })
		expect(loadRepoState("a", "b")?.latest_version).toBe("1.0.0")
		expect(loadRepoState("c", "d")?.latest_version).toBe("2.0.0")
	})

	it("writes on disk in snake_case + RFC3339", () => {
		saveRepoState("a", "b", {
			checked_at: "2023-11-14T22:13:20.000Z",
			latest_version: "1.0.0",
			release_url: "https://example/release",
		})
		const path = statePathFor()
		expect(existsSync(path)).toBe(true)
		const raw = JSON.parse(readFileSync(path, "utf-8"))
		expect(raw.repos["a/b"]).toEqual({
			checked_at: "2023-11-14T22:13:20.000Z",
			latest_version: "1.0.0",
			release_url: "https://example/release",
		})
	})

	it("reads snake_case + RFC3339 with timezone offset entry", () => {
		writeRawState({
			repos: {
				"castai/kimchi-dev": {
					checked_at: "2026-05-06T10:58:22.04543+03:00",
					latest_version: "v0.0.22",
					release_url: "https://github.com/castai/kimchi-dev/releases/tag/v0.0.22",
				},
			},
		})
		const got = loadRepoState("castai", "kimchi-dev")
		expect(got?.latest_version).toBe("v0.0.22")
		expect(got?.release_url).toBe("https://github.com/castai/kimchi-dev/releases/tag/v0.0.22")
		expect(got?.checked_at).toBe("2026-05-06T10:58:22.04543+03:00")
	})

	it("preserves a foreign-shape entry on save instead of overwriting it", () => {
		writeRawState({
			repos: {
				"castai/kimchi": {
					checked_at: "2026-05-06T10:05:19+03:00",
					latest_version: "v0.1.52",
					release_url: "https://github.com/castai/kimchi/releases/tag/v0.1.52",
				},
			},
		})
		saveRepoState("castai", "kimchi-dev", { checked_at: "2023-11-14T22:13:20.000Z", latest_version: "v0.0.22" })
		const raw = JSON.parse(readFileSync(statePathFor(), "utf-8"))
		expect(raw.repos["castai/kimchi"]).toEqual({
			checked_at: "2026-05-06T10:05:19+03:00",
			latest_version: "v0.1.52",
			release_url: "https://github.com/castai/kimchi/releases/tag/v0.1.52",
		})
		expect(raw.repos["castai/kimchi-dev"]).toEqual({
			checked_at: "2023-11-14T22:13:20.000Z",
			latest_version: "v0.0.22",
		})
	})

	describe("defensive parsing — malformed cache entries return null (no throw)", () => {
		it("returns null when latest_version is missing", () => {
			writeRawState({ repos: { "a/b": { checked_at: "2026-01-01T00:00:00Z" } } })
			expect(loadRepoState("a", "b")).toBeNull()
		})

		it("returns null when latest_version is the wrong type", () => {
			writeRawState({ repos: { "a/b": { checked_at: "2026-01-01T00:00:00Z", latest_version: 123 } } })
			expect(loadRepoState("a", "b")).toBeNull()
		})

		it("returns null when latest_version is empty string", () => {
			writeRawState({ repos: { "a/b": { checked_at: "2026-01-01T00:00:00Z", latest_version: "" } } })
			expect(loadRepoState("a", "b")).toBeNull()
		})

		it("returns null when checked_at is missing", () => {
			writeRawState({ repos: { "a/b": { latest_version: "1.0.0" } } })
			expect(loadRepoState("a", "b")).toBeNull()
		})

		it("returns null when checked_at is unparseable", () => {
			writeRawState({ repos: { "a/b": { checked_at: "not-a-date", latest_version: "1.0.0" } } })
			expect(loadRepoState("a", "b")).toBeNull()
		})

		it("returns null for a camelCase entry written by a different schema", () => {
			writeRawState({ repos: { "a/b": { checkedAt: 1_700_000_000_000, latestVersion: "1.0.0" } } })
			expect(loadRepoState("a", "b")).toBeNull()
		})

		it("returns null when the entry is not an object", () => {
			writeRawState({ repos: { "a/b": "garbage" } })
			expect(loadRepoState("a", "b")).toBeNull()
		})

		it("returns null when the file is invalid JSON", () => {
			const path = statePathFor()
			mkdirSync(join(tmp, "kimchi"), { recursive: true })
			writeFileSync(path, "{not valid json")
			expect(loadRepoState("a", "b")).toBeNull()
		})

		it("returns null when the top-level shape has no repos field", () => {
			writeRawState({ something_else: 1 })
			expect(loadRepoState("a", "b")).toBeNull()
		})
	})
})

describe("isStale", () => {
	const day = 24 * 60 * 60 * 1000
	const t0 = Date.parse("2026-01-01T00:00:00Z")

	it("returns false for a fresh check", () => {
		expect(isStale({ checked_at: "2026-01-01T00:00:00Z", latest_version: "1" }, t0)).toBe(false)
	})
	it("returns false within 24h", () => {
		expect(isStale({ checked_at: "2026-01-01T00:00:00Z", latest_version: "1" }, t0 + day - 1)).toBe(false)
	})
	it("returns true past 24h", () => {
		expect(isStale({ checked_at: "2026-01-01T00:00:00Z", latest_version: "1" }, t0 + day + 1)).toBe(true)
	})
	it("returns true when checked_at is unparseable (defensive)", () => {
		expect(isStale({ checked_at: "garbage", latest_version: "1" }, t0)).toBe(true)
	})
})

describe("isUpdateCheckDisabled", () => {
	let prev: string | undefined
	beforeEach(() => {
		prev = process.env.KIMCHI_NO_UPDATE_CHECK
		// biome-ignore lint/performance/noDelete: env-var cleanup needs a real delete.
		delete process.env.KIMCHI_NO_UPDATE_CHECK
	})
	afterEach(() => {
		// biome-ignore lint/performance/noDelete: same as above.
		if (prev === undefined) delete process.env.KIMCHI_NO_UPDATE_CHECK
		else process.env.KIMCHI_NO_UPDATE_CHECK = prev
	})

	it("returns false when unset", () => {
		expect(isUpdateCheckDisabled()).toBe(false)
	})
	it("returns false for empty string (matches gh CLI conventions)", () => {
		process.env.KIMCHI_NO_UPDATE_CHECK = ""
		expect(isUpdateCheckDisabled()).toBe(false)
	})
	it("returns true for any non-empty value", () => {
		process.env.KIMCHI_NO_UPDATE_CHECK = "1"
		expect(isUpdateCheckDisabled()).toBe(true)
		process.env.KIMCHI_NO_UPDATE_CHECK = "true"
		expect(isUpdateCheckDisabled()).toBe(true)
	})
})
