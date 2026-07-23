import { describe, expect, it } from "vitest"
import { type CouncilCacheKey, CouncilSessionCache, hashCouncilCacheValue } from "./cache.js"
import { JudgeArtifactSchema } from "./schemas.js"

const key: CouncilCacheKey = {
	patchHash: "patch",
	baseSnapshotHash: "base",
	objectiveHash: "objective",
	constraintsHash: "constraints",
	evidenceHash: "evidence",
	role: "critic",
	modelId: "physical/model",
	promptVersion: "prompt",
	schemaVersion: "schema",
}

describe("CouncilSessionCache", () => {
	it("invalidates on every required key component", () => {
		for (const field of Object.keys(key) as Array<keyof CouncilCacheKey>) {
			const cache = new CouncilSessionCache()
			cache.setResult(key, { schema_version: 1 }, () => true)
			expect(cache.getResult({ ...key, [field]: `${key[field]}-changed` })).toBeUndefined()
		}
	})

	it("separates packets from validated results and clones values", () => {
		const cache = new CouncilSessionCache()
		const value = { schema_version: 1, findings: [] as string[] }
		cache.setResult(key, value, () => true)
		value.findings.push("mutated")

		expect(cache.getPacket(key)).toBeUndefined()
		expect(cache.getResult(key)).toEqual({ schema_version: 1, findings: [] })
		expect(cache.snapshot()).toMatchObject({ hits: 1, misses: 1, entries: 1 })
	})

	it("bounds entry count and byte size", () => {
		const cache = new CouncilSessionCache(2, 80, 60)
		expect(cache.setResult(key, { value: "a".repeat(20) }, () => true)).toBe(true)
		expect(cache.setResult({ ...key, role: "checker" }, { value: "b".repeat(20) }, () => true)).toBe(true)
		expect(cache.setResult({ ...key, role: "judge" }, { value: "c".repeat(20) }, () => true)).toBe(true)
		expect(cache.snapshot().entries).toBeLessThanOrEqual(2)
		expect(cache.snapshot().bytes).toBeLessThanOrEqual(80)
		expect(cache.setResult({ ...key, role: "repair" }, { value: "x".repeat(100) }, () => true)).toBe(false)
	})

	it("never caches a schema-invalid structured result", () => {
		const cache = new CouncilSessionCache()
		expect(
			cache.setResult(
				key,
				{ schema_version: 1, raw_reasoning: "private" },
				(value) => JudgeArtifactSchema.safeParse(value).success,
			),
		).toBe(false)
		expect(cache.getResult(key)).toBeUndefined()
	})

	it("hashes exact packet contents", () => {
		expect(hashCouncilCacheValue({ objective: "a" })).not.toBe(hashCouncilCacheValue({ objective: "b" }))
		expect(hashCouncilCacheValue({ objective: "a" })).toBe(hashCouncilCacheValue({ objective: "a" }))
	})
})
