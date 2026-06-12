import { describe, expect, it } from "vitest"
import type { Ferment } from "../../../ferment/types.js"
import { buildPanelSnapshot } from "./snapshot.js"

const ferment: Ferment = {
	id: "ferment-1",
	name: "Panel polish",
	status: "running",
	activePhaseId: "phase-2",
	worktree: { path: "/tmp/project", branch: "ui/panel" },
	scoping: {},
	phases: [
		{
			id: "phase-1",
			index: 1,
			name: "Build",
			goal: "Build it",
			status: "completed",
			steps: [
				{ id: "step-1", index: 1, description: "Create files", status: "done" },
				{ id: "step-2", index: 2, description: "Verify", status: "verified" },
			],
		},
		{
			id: "phase-2",
			index: 2,
			name: "Quality",
			goal: "Check it",
			status: "active",
			grade: { grade: "B", rationale: "Good enough", gradedAt: "2026-01-01T00:00:00.000Z" },
			steps: [
				{ id: "step-3", index: 1, description: "Run tests", status: "running", startedAt: "2026-01-01T00:00:00.000Z" },
			],
		},
	],
	decisions: [],
	memories: [],
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:10:00.000Z",
}

describe("buildPanelSnapshot", () => {
	it("maps ferment state into phase and step rows", () => {
		const snapshot = buildPanelSnapshot(
			ferment,
			{
				getContinuationPolicy: () => "automated",
				getLastHumanInputAt: () => new Date("2026-01-01T00:05:00.000Z"),
			},
			Date.parse("2026-01-01T00:10:00.000Z"),
		)

		expect(snapshot.name).toBe("Panel polish")
		expect(snapshot.branch).toBe("ui/panel")
		expect(snapshot.activePhaseIndex).toBe(1)
		expect(snapshot.lastHumanInputAt).toBe("2026-01-01T00:05:00.000Z")
		expect(snapshot.phases[0]).toMatchObject({ doneSteps: 2, totalSteps: 2, active: false })
		expect(snapshot.phases[1]).toMatchObject({ id: "phase-2", grade: "B", active: true })
		expect(snapshot.stepsByPhase.get("phase-2")?.[0]).toMatchObject({
			id: "step-3",
			description: "Run tests",
			status: "running",
		})
	})
})
