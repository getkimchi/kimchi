import { spawnSync } from "node:child_process"
import { mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { describeChanges, mergeTimings, parseTarget, runIdsWithReports } from "./update-timings.js"

describe("mergeTimings", () => {
	it("replaces an old time with the new measurement", () => {
		expect(mergeTimings({ a: 10 }, [{ a: 12.34 }], ["a"])).toEqual({ a: 12.3 })
	})

	it("averages a file measured by several runs", () => {
		expect(mergeTimings({}, [{ a: 10 }, { a: 20 }], ["a"])).toEqual({ a: 15 })
	})

	it("keeps the old time of a file that did not run", () => {
		expect(mergeTimings({ quarantined: 40 }, [{ other: 5 }], ["quarantined", "other"])).toEqual({
			other: 5,
			quarantined: 40,
		})
	})

	it("adds a new file and drops a deleted one", () => {
		expect(mergeTimings({ deleted: 9 }, [{ added: 3 }], ["added"])).toEqual({ added: 3 })
	})

	it("leaves out a file that has never been measured", () => {
		expect(mergeTimings({}, [{}], ["unmeasured"])).toEqual({})
	})
})

describe("describeChanges", () => {
	it("counts updated, added and removed files", () => {
		expect(describeChanges({ same: 1, changed: 2, gone: 3 }, { same: 1, changed: 4, fresh: 5 })).toEqual({
			updated: 1,
			added: 1,
			removed: 1,
		})
	})

	it("reports nothing for equal timings", () => {
		expect(describeChanges({ a: 1 }, { a: 1 })).toEqual({ updated: 0, added: 0, removed: 0 })
	})

	it("handles empty timings", () => {
		expect(describeChanges({}, {})).toEqual({ updated: 0, added: 0, removed: 0 })
	})
})

describe("parseTarget", () => {
	it("uses the latest run without an argument", () => {
		expect(parseTarget(undefined)).toEqual({ kind: "latest" })
	})

	it("reads digits as a run ID", () => {
		expect(parseTarget("45685439335")).toEqual({ kind: "run", runId: "45685439335" })
	})

	it("reads anything else as a folder", () => {
		expect(parseTarget("/tmp/tui-timings")).toEqual({ kind: "folder", folder: "/tmp/tui-timings" })
		expect(parseTarget("12a")).toEqual({ kind: "folder", folder: "12a" })
	})
})

describe("runIdsWithReports", () => {
	const artifact = (run: number, created: string, expired = false) => ({
		expired,
		created_at: created,
		workflow_run: { id: run },
	})

	it("orders runs newest first", () => {
		expect(runIdsWithReports([artifact(1, "2026-11-24T10:00:00Z"), artifact(2, "2026-11-25T10:00:00Z")])).toEqual([
			"2",
			"1",
		])
	})

	it("skips expired reports", () => {
		expect(runIdsWithReports([artifact(1, "2026-11-25T10:00:00Z", true), artifact(2, "2026-11-24T10:00:00Z")])).toEqual(
			["2"],
		)
	})

	it("returns nothing when no run has reports", () => {
		expect(runIdsWithReports([])).toEqual([])
	})
})

describe("update-timings CLI errors", () => {
	const cli = resolve(import.meta.dirname, "update-timings.js")

	function run(args: string[], env: NodeJS.ProcessEnv) {
		return spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, ...env } })
	}

	it("explains a missing GitHub CLI and leaves no temp folder behind", () => {
		const tmp = mkdtempSync(join(tmpdir(), "timings-cli-test-"))
		try {
			const result = run(["123"], { PATH: "/nonexistent", TMPDIR: tmp })
			expect(result.status).toBe(1)
			expect(result.stderr).toContain("needs the GitHub CLI")
			expect(readdirSync(tmp)).toEqual([])
		} finally {
			rmSync(tmp, { recursive: true, force: true })
		}
	})

	it("reports an empty folder without changing the timings", () => {
		const empty = mkdtempSync(join(tmpdir(), "timings-cli-empty-"))
		try {
			const result = run([empty], {})
			expect(result.status).toBe(1)
			expect(result.stderr).toContain("no TUI timing reports found")
		} finally {
			rmSync(empty, { recursive: true, force: true })
		}
	})

	it("reports a missing folder", () => {
		const result = run(["/nonexistent/tui-timings"], {})
		expect(result.status).toBe(1)
		expect(result.stderr).toContain("folder not found")
	})
})
