import { describe, expect, it } from "vitest"
import { behind, compareVersions, selectTarget } from "./versions.ts"

const times = {
	created: "2026-01-01T00:00:00Z",
	modified: "2026-10-22T00:00:00Z",
	"1.3.0": "2026-10-15T19:13:30Z",
	"1.4.0": "2026-10-21T22:48:58Z",
	"1.4.1-beta.0": "2026-10-22T00:00:00Z",
}

describe("selectTarget", () => {
	it("picks the latest version once it had 2 quiet days", () => {
		expect(selectTarget(times, "1.3.0", new Date("2026-10-27T00:00:00Z"))).toEqual({
			target: "1.4.0",
			chain: ["1.4.0"],
		})
	})

	it("returns no target when the only newer version is younger than 2 days", () => {
		expect(selectTarget(times, "1.3.0", new Date("2026-10-23T00:00:00Z")).target).toBeNull()
	})

	it("picks a settled intermediate while a newer burst is in flight", () => {
		const t = {
			"1.0.0": "2026-10-01T00:00:00Z",
			"1.1.0": "2026-10-05T00:00:00Z",
			"1.2.0": "2026-10-09T00:00:00Z",
		}
		expect(selectTarget(t, "1.0.0", new Date("2026-10-10T00:00:00Z"))).toEqual({
			target: "1.1.0",
			chain: ["1.1.0"],
		})
	})

	it("skips a version followed by a quick fix release", () => {
		const t = {
			"1.0.0": "2026-10-01T00:00:00Z",
			"1.1.0": "2026-10-05T00:00:00Z",
			"1.1.1": "2026-10-05T06:00:00Z",
		}
		expect(selectTarget(t, "1.0.0", new Date("2026-10-10T00:00:00Z"))).toEqual({
			target: "1.1.1",
			chain: ["1.1.0", "1.1.1"],
		})
	})

	it("returns no target when baseline is the latest version", () => {
		expect(selectTarget(times, "1.4.0", new Date("2026-10-27T00:00:00Z"))).toEqual({ target: null, chain: [] })
	})
})

describe("behind", () => {
	it("counts versions, days and minor lines behind", () => {
		expect(behind(times, "1.3.0", new Date("2026-10-27T00:00:00Z"))).toEqual({
			versions: 1,
			days: 11,
			lines: 1,
			latest: "1.4.0",
		})
	})
})

describe("compareVersions", () => {
	it("orders versions numerically", () => {
		const sorted = ["1.0.10", "0.99.2", "1.0.0", "1.0.2"].sort(compareVersions)
		expect(sorted).toEqual(["0.99.2", "1.0.0", "1.0.2", "1.0.10"])
	})
})
