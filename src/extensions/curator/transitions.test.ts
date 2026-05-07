import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { UsageTracker } from "../skills-manager/usage.js"
import { computeTransitions, runAutoTransitions } from "./transitions.js"

describe("computeTransitions", () => {
	it("returns empty arrays when no entries provided", () => {
		const result = computeTransitions([], new Date())
		expect(result.proposeStale).toHaveLength(0)
		expect(result.proposeArchive).toHaveLength(0)
		expect(result.proposeReactivate).toHaveLength(0)
	})

	it("proposes stale for active skill with activity > 30d ago", () => {
		const now = new Date("2026-05-07T10:00:00Z")
		const thirtyFiveDaysAgo = new Date(now.getTime() - 35 * 24 * 3600 * 1000).toISOString()
		const entries = [
			{ name: "old-skill", pinned: false, state: "active" as const, last_activity_at: thirtyFiveDaysAgo },
		]
		const result = computeTransitions(entries, now)
		expect(result.proposeStale).toContain("old-skill")
	})

	it("proposes archive for skill with activity > 90d ago", () => {
		const now = new Date("2026-05-07T10:00:00Z")
		const ninetyFiveDaysAgo = new Date(now.getTime() - 95 * 24 * 3600 * 1000).toISOString()
		const entries = [
			{ name: "ancient-skill", pinned: false, state: "active" as const, last_activity_at: ninetyFiveDaysAgo },
		]
		const result = computeTransitions(entries, now)
		expect(result.proposeArchive).toContain("ancient-skill")
		expect(result.proposeStale).not.toContain("ancient-skill")
	})

	it("proposes reactivate for stale skill with activity <= 30d ago", () => {
		const now = new Date("2026-05-07T10:00:00Z")
		const tenDaysAgo = new Date(now.getTime() - 10 * 24 * 3600 * 1000).toISOString()
		const entries = [{ name: "returning-skill", pinned: false, state: "stale" as const, last_activity_at: tenDaysAgo }]
		const result = computeTransitions(entries, now)
		expect(result.proposeReactivate).toContain("returning-skill")
	})

	it("never proposes transitions for pinned skills", () => {
		const now = new Date("2026-05-07T10:00:00Z")
		const ninetyFiveDaysAgo = new Date(now.getTime() - 95 * 24 * 3600 * 1000).toISOString()
		const entries = [
			{ name: "pinned-skill", pinned: true, state: "active" as const, last_activity_at: ninetyFiveDaysAgo },
		]
		const result = computeTransitions(entries, now)
		expect(result.proposeStale).not.toContain("pinned-skill")
		expect(result.proposeArchive).not.toContain("pinned-skill")
	})
})

describe("runAutoTransitions", () => {
	let tmpDir: string
	let tracker: UsageTracker

	beforeEach(async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "kimchi-transitions-test-"))
		tracker = new UsageTracker(tmpDir)
		await tracker.bumpCreate("active-old-skill", true)
	})

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
	})

	it("applies stale transition to .usage.json", async () => {
		const now = new Date("2026-05-07T10:00:00Z")
		const thirtyFiveDaysAgo = new Date(now.getTime() - 35 * 24 * 3600 * 1000).toISOString()

		// Manually patch created_at to simulate old activity
		const usagePath = join(tmpDir, ".usage.json")
		const { readFile, writeFile } = await import("node:fs/promises")
		const raw = await readFile(usagePath, "utf-8")
		const usage = JSON.parse(raw)
		usage["active-old-skill"].created_at = thirtyFiveDaysAgo
		usage["active-old-skill"].last_used_at = undefined
		await writeFile(usagePath, JSON.stringify(usage, null, 2))

		await runAutoTransitions(tmpDir, now)

		const entry = await tracker.get("active-old-skill")
		expect(entry?.state).toBe("stale")
	})

	it("returns transition result with proposed changes", async () => {
		const result = await runAutoTransitions(tmpDir, new Date())
		expect(result).toHaveProperty("proposeStale")
		expect(result).toHaveProperty("proposeArchive")
		expect(result).toHaveProperty("proposeReactivate")
	})
})
