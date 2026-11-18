import type { CustomEntry } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { createSessionLogHarness } from "../__mocks__/session-log.js"
import { createDirectorState } from "./plan.js"
import { DIRECTOR_SESSION_ENTRY_TYPE, DirectorStore } from "./state.js"

const makeHarness = createSessionLogHarness

describe("DirectorStore", () => {
	it("persists a complete Director plan and restores it through a new reader", () => {
		const harness = makeHarness()
		const store = new DirectorStore(harness)
		const initial = createDirectorState("Ship native Director", "run-native", "2026-11-18T12:00:00.000Z")
		initial.plan.currentPhase = "verify"
		initial.plan.tasks = [
			{ id: "build", title: "Build state", status: "completed", dependsOn: [], acceptWhen: "Tests pass" },
			{ id: "verify", title: "Verify lifecycle", status: "running", dependsOn: ["build"], owner: "agent-1" },
		]
		initial.plan.decisions = [{ id: "d1", text: "Use session entries", rationale: "No arbitrary writes" }]
		initial.plan.contracts = [{ id: "c1", text: "Orchestration only", version: 1 }]
		initial.plan.assumptions = ["AgentManager is authoritative"]
		initial.plan.ownership = [{ area: "src/extensions/director", workerId: "agent-1" }]
		initial.plan.verification = [
			{ summary: "State suite green", outcome: "completed", artifactPaths: ["artifacts/state.txt"] },
		]
		initial.plan.openQuestions = ["Resume remote first?"]
		initial.plan.artifactPaths = ["artifacts/state.txt"]
		initial.plan.workers["agent-1"] = {
			id: "agent-1",
			type: "Builder",
			description: "Build state",
			status: "running",
			disposition: "owned",
			result: "Implemented persistence",
			artifactPaths: ["artifacts/state.txt"],
		}

		store.commit(initial, 0)
		const restored = new DirectorStore(harness).read()

		expect(restored).toMatchObject({
			status: "active",
			runId: "run-native",
			objective: "Ship native Director",
			revision: 1,
			plan: initial.plan,
		})
		expect(harness.entries[0].customType).toBe(DIRECTOR_SESSION_ENTRY_TYPE)
	})

	it("rejects stale writes without replacing the latest snapshot", () => {
		const harness = makeHarness()
		const store = new DirectorStore(harness)
		store.commit(createDirectorState("First objective", "run-1"), 0)
		const current = store.read()
		if (!current) throw new Error("Expected saved Director state")
		store.commit({ ...current, objective: "Updated objective" }, 1)

		expect(() => store.commit({ ...current, objective: "Stale objective" }, 0)).toThrow(/revision/i)

		const latest = new DirectorStore(harness).read()
		expect(latest?.objective).toBe("Updated objective")
		expect(latest?.revision).toBe(2)
		expect(harness.entries).toHaveLength(2)
	})

	it("fails closed on a newer incompatible snapshot rather than resuming an older plan", () => {
		const harness = makeHarness()
		const store = new DirectorStore(harness)
		store.commit(createDirectorState("Good state", "run-good"), 0)
		harness.entries.push({
			type: "custom",
			customType: DIRECTOR_SESSION_ENTRY_TYPE,
			data: { status: "active" },
		} as CustomEntry)

		expect(() => new DirectorStore(harness).read()).toThrow(/incompatible|invalid/i)
	})

	it("returns undefined when the session never used Director", () => {
		expect(new DirectorStore(makeHarness()).read()).toBeUndefined()
	})
})
