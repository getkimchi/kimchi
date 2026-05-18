import { describe, expect, it } from "vitest"
import type { Ferment } from "../../ferment/types.js"
import { formatScopingContext } from "./format.js"

function makeFerment(overrides: Partial<Ferment> = {}): Ferment {
	const now = "2026-01-01T00:00:00.000Z"
	return {
		id: "ferment-1",
		name: "Test Ferment",
		status: "draft",
		worktree: { path: "/repo" },
		scoping: {},
		phases: [],
		decisions: [],
		memories: [],
		createdAt: now,
		updatedAt: now,
		...overrides,
	}
}

describe("formatScopingContext", () => {
	it("renders Assumptions line when scoping.assumptions is set", () => {
		const f = makeFerment({
			scoping: {
				goal: { answer: "Ship OAuth login", confirmedAt: "2026-01-01T00:00:00.000Z" },
				assumptions: { answer: "API limits documented", confirmedAt: "2026-01-01T00:00:00.000Z" },
			},
		})

		const output = formatScopingContext(f)

		expect(output).toContain("Assumptions: API limits documented")
	})

	it("omits Assumptions line when scoping.assumptions is undefined", () => {
		const f = makeFerment({
			scoping: {
				goal: { answer: "Ship OAuth login", confirmedAt: "2026-01-01T00:00:00.000Z" },
			},
		})

		const output = formatScopingContext(f)

		expect(output).not.toContain("Assumptions")
	})

	it("returns empty string when scoping has no fields set", () => {
		const f = makeFerment({ scoping: {} })

		const output = formatScopingContext(f)

		expect(output).toBe("")
	})
})
