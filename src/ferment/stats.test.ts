import { describe, expect, it } from "vitest"
import { computeStats } from "./stats.js"
import type { Ferment, FermentStatus } from "./types.js"

function makeFerment(overrides: Partial<Ferment> = {}): Ferment {
	return {
		id: "f-stats-1",
		name: "Stats Test Ferment",
		status: "draft",
		worktree: { path: "/tmp/test" },
		scoping: {},
		phases: [],
		decisions: [],
		memories: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	}
}

describe("computeStats — lifecycleStage", () => {
	const statuses: FermentStatus[] = ["draft", "planned", "running", "paused", "complete", "abandoned"]

	for (const status of statuses) {
		it(`returns lifecycleStage = "${status}" for a ferment with status "${status}"`, () => {
			const ferment = makeFerment({ status })
			const stats = computeStats(ferment)
			expect(stats.lifecycleStage).toBe(status)
		})
	}
})
