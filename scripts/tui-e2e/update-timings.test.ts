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
