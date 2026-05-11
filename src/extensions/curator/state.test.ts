import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DEFAULT_CURATOR_STATE, loadState, saveState, shouldRunNow } from "./state.js"

describe("shouldRunNow", () => {
	it("returns false when paused", () => {
		const state = { ...DEFAULT_CURATOR_STATE, paused: true }
		expect(shouldRunNow(state, 3 * 3600)).toBe(false)
	})

	it("returns false when running and last_run_at < 4h ago", () => {
		const now = new Date("2026-05-07T12:00:00Z")
		const recentRun = new Date(now.getTime() - 1 * 3600 * 1000).toISOString()
		const state = { ...DEFAULT_CURATOR_STATE, running: true, last_run_at: recentRun }
		expect(shouldRunNow(state, 3 * 3600, now)).toBe(false)
	})

	it("clears stale lock when running and last_run_at > 4h ago (blocked by 7d interval)", () => {
		const now = new Date("2026-05-07T12:00:00Z")
		const staleRun = new Date(now.getTime() - 5 * 3600 * 1000).toISOString()
		const state = { ...DEFAULT_CURATOR_STATE, running: true, last_run_at: staleRun }
		// stale lock cleared, but 5h < 7d so still blocked by interval check
		expect(shouldRunNow(state, 3 * 3600, now)).toBe(false)
	})

	it("returns false when last_run_at is within 7 days", () => {
		const now = new Date("2026-05-07T12:00:00Z")
		const recentRun = new Date(now.getTime() - 2 * 24 * 3600 * 1000).toISOString()
		const state = { ...DEFAULT_CURATOR_STATE, last_run_at: recentRun }
		expect(shouldRunNow(state, 3 * 3600, now)).toBe(false)
	})

	it("returns false when idle < 2h", () => {
		expect(shouldRunNow(DEFAULT_CURATOR_STATE, 1 * 3600)).toBe(false)
	})

	it("returns true when all checks pass (no last_run_at, idle >= 2h)", () => {
		expect(shouldRunNow(DEFAULT_CURATOR_STATE, 3 * 3600)).toBe(true)
	})

	it("returns true when last_run_at is > 7 days ago and idle >= 2h", () => {
		const now = new Date("2026-05-07T12:00:00Z")
		const oldRun = new Date(now.getTime() - 8 * 24 * 3600 * 1000).toISOString()
		const state = { ...DEFAULT_CURATOR_STATE, last_run_at: oldRun }
		expect(shouldRunNow(state, 3 * 3600, now)).toBe(true)
	})
})

describe("loadState / saveState", () => {
	let tmpDir: string

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "kimchi-curator-test-"))
	})

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
	})

	it("returns DEFAULT_CURATOR_STATE when file does not exist", async () => {
		const state = await loadState(join(tmpDir, ".curator_state.json"))
		expect(state).toEqual(DEFAULT_CURATOR_STATE)
	})

	it("round-trips state through save/load", async () => {
		const statePath = join(tmpDir, ".curator_state.json")
		const saved = {
			...DEFAULT_CURATOR_STATE,
			last_run_at: "2026-05-07T10:00:00.000Z",
			run_count: 3,
			last_run_summary: "2 merged",
		}
		await saveState(statePath, saved)
		const loaded = await loadState(statePath)
		expect(loaded).toEqual(saved)
	})
})
