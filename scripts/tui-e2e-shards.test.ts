import { readdirSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { planShards } from "./tui-e2e-shards.js"

const tuiDir = resolve(import.meta.dirname, "../tests/e2e/tui")

describe("planShards", () => {
	it("puts every file in exactly one shard", () => {
		const stems = ["a", "b", "c", "d", "e"]
		const shards = planShards(stems, { a: 5, b: 4, c: 3, d: 2, e: 1 }, 2)
		expect(shards.flatMap((shard) => shard.stems).sort()).toEqual(stems)
	})

	it("spreads the slow files over different shards", () => {
		const shards = planShards(["slow1", "slow2", "fast1", "fast2"], { slow1: 100, slow2: 90, fast1: 10, fast2: 5 }, 2)
		expect(shards.map((shard) => shard.seconds)).toEqual([105, 100])
		expect(shards[0].stems).toContain("slow1")
		expect(shards[1].stems).toContain("slow2")
	})

	it("counts a file without a measured time as the median", () => {
		const shards = planShards(["new", "a", "b", "c"], { a: 1, b: 10, c: 100 }, 1)
		expect(shards[0].seconds).toBe(121)
	})

	it("counts every file as 1 second when nothing is measured", () => {
		const shards = planShards(["a", "b", "c"], {}, 2)
		expect(shards.map((shard) => shard.stems)).toEqual([["a", "c"], ["b"]])
	})

	it("ignores timings of files that no longer exist", () => {
		const shards = planShards(["a"], { a: 3, removed: 500 }, 1)
		expect(shards[0].seconds).toBe(3)
	})

	it("returns empty shards when there are more shards than files", () => {
		const shards = planShards(["a"], { a: 3 }, 3)
		expect(shards.map((shard) => shard.stems)).toEqual([["a"], [], []])
	})

	it("gives the same plan for the same files in any order", () => {
		const timings = { a: 4, b: 4, c: 2, d: 2 }
		expect(planShards(["d", "c", "b", "a"], timings, 2)).toEqual(planShards(["a", "b", "c", "d"], timings, 2))
	})

	it("keeps the checked-in timings within 25% of an even split", () => {
		const { files } = JSON.parse(readFileSync(resolve(tuiDir, "timings.json"), "utf8"))
		const stems = readdirSync(tuiDir)
			.filter((name) => name.endsWith(".test.ts"))
			.map((name) => name.replace(/\.test\.ts$/, ""))
		const shards = planShards(stems, files, 6)
		const seconds = shards.map((shard) => shard.seconds)
		const even = seconds.reduce((sum, value) => sum + value, 0) / seconds.length
		expect(Math.max(...seconds)).toBeLessThan(even * 1.25)
	})
})
