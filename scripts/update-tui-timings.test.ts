import { describe, expect, it } from "vitest"
import { mergeTimings } from "./update-tui-timings.js"

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
