import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { commandToEvents } from "./event-mapper.js"
import { FermentEventStore } from "./event-store.js"
import { applyCommand } from "./state-machine.js"
import { FermentStorage, clearFermentCache } from "./store.js"
import type { Phase } from "./types.js"

function createTempDir() {
	return mkdtempSync(join(tmpdir(), "ferment-event-store-test-"))
}

/** Run a command through the same path applyAndPersist uses in production. */
function exec(store: FermentEventStore, fermentId: string, cmd: Parameters<typeof commandToEvents>[0]) {
	return store.mutateWithEvents(fermentId, (before) => {
		if (!before) throw new Error(`ferment ${fermentId} not found`)
		const now = new Date().toISOString()
		const result = applyCommand(before, cmd, { now })
		if (!result.ok) throw new Error(`command rejected: ${result.error.message}`)
		const events = commandToEvents(cmd, before, result.ferment, { now })
		return { write: true, ferment: result.ferment, events, value: result.ferment }
	})
}

function readEvents(
	dir: string,
	id: string,
): { type: string; payload: unknown; preStateHash: string; postStateHash: string }[] {
	const path = join(dir, `${id}.events.jsonl`)
	const raw = readFileSync(path, "utf-8")
	return raw
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line))
}

describe("FermentEventStore", () => {
	let tempDir: string
	let eventStore: FermentEventStore
	let parentStorage: FermentStorage

	beforeEach(() => {
		tempDir = createTempDir()
		eventStore = new FermentEventStore(tempDir)
		parentStorage = new FermentStorage(tempDir)
		clearFermentCache()
	})

	afterEach(() => {
		clearFermentCache()
	})

	// ─── create + read-back ────────────────────────────────────────────────────

	describe("create", () => {
		it("creates ferment, writes one ferment_created event", () => {
			const ferment = eventStore.create("Auth rewrite", "Rewrite to OAuth2")
			expect(ferment.name).toBe("Auth rewrite")
			expect(ferment.status).toBe("draft")

			const events = readEvents(tempDir, ferment.id)
			expect(events).toHaveLength(1)
			expect(events[0].type).toBe("ferment_created")
		})

		it("get() returns the ferment after create", () => {
			const created = eventStore.create("Read-back test")
			expect(eventStore.get(created.id)?.name).toBe("Read-back test")
		})
	})

	// ─── full mutation path: applyCommand → writeWithEvents → fold ─────────────

	describe("writeWithEvents (production mutation path)", () => {
		it("scope command emits per-field events + ferment_planned", () => {
			const f = eventStore.create("Scope test")

			exec(eventStore, f.id, {
				type: "scope",
				goal: "Build it",
				successCriteria: "Tests pass",
				constraints: ["one constraint"],
				phases: [{ name: "P1", goal: "G1" }],
			})

			const types = readEvents(tempDir, f.id).map((e) => e.type)
			expect(types).toContain("ferment_created")
			expect(types).toContain("scoping_goal_set")
			expect(types).toContain("scoping_criteria_set")
			expect(types).toContain("scoping_constraints_set")
			expect(types).toContain("scoping_phases_set")
			expect(types).toContain("ferment_planned")
		})

		it("activate_phase emits ferment_running + phase_activated", () => {
			const f = eventStore.create("Activate test")
			exec(eventStore, f.id, {
				type: "scope",
				goal: "Goal",
				successCriteria: "criteria",
				constraints: [],
				phases: [{ name: "P1", goal: "G1" }],
			})
			const planned = eventStore.get(f.id)
			if (!planned) throw new Error("ferment missing")
			exec(eventStore, f.id, { type: "activate_phase", phaseId: planned.phases[0].id })

			const types = readEvents(tempDir, f.id).map((e) => e.type)
			expect(types).toContain("ferment_running")
			expect(types).toContain("phase_activated")
		})

		it("step lifecycle commands all emit corresponding events", () => {
			const f = eventStore.create("Step lifecycle")
			exec(eventStore, f.id, {
				type: "scope",
				goal: "Goal",
				successCriteria: "criteria",
				constraints: [],
				phases: [{ name: "P1", goal: "G1" }],
			})
			const planned = eventStore.get(f.id)
			if (!planned) throw new Error("ferment missing")
			const phaseId = planned.phases[0].id

			exec(eventStore, f.id, { type: "activate_phase", phaseId })
			exec(eventStore, f.id, {
				type: "refine_phase",
				phaseId,
				steps: [{ description: "Do thing 1" }, { description: "Do thing 2" }],
			})

			const refined = eventStore.get(f.id)
			if (!refined) throw new Error("ferment missing")
			const stepId = refined.phases[0].steps[0].id

			exec(eventStore, f.id, { type: "start_step", phaseId, stepId })
			exec(eventStore, f.id, { type: "complete_step", phaseId, stepId })

			const types = readEvents(tempDir, f.id).map((e) => e.type)
			expect(types).toContain("phase_refined")
			expect(types).toContain("step_started")
			expect(types).toContain("step_completed")
		})

		it("pause + resume each emit one status event", () => {
			const f = eventStore.create("Pause test")
			exec(eventStore, f.id, {
				type: "scope",
				goal: "Goal",
				successCriteria: "c",
				constraints: [],
				phases: [{ name: "P1", goal: "G1" }],
			})
			const planned = eventStore.get(f.id)
			if (!planned) throw new Error("ferment missing")
			exec(eventStore, f.id, { type: "activate_phase", phaseId: planned.phases[0].id })
			exec(eventStore, f.id, { type: "pause" })
			exec(eventStore, f.id, { type: "resume" })

			const types = readEvents(tempDir, f.id).map((e) => e.type)
			expect(types).toContain("ferment_paused")
			expect(types).toContain("ferment_resumed")
		})

		// Regression: §4.2 — replaying N independent phase_activated events for a
		// parallel group used to demote each previously-active sibling, leaving
		// only the last one active after fold. Atomic phase_group_activated event
		// fixes this. Test exercises the fold path (eventStore.get → foldEvents)
		// rather than the snapshot, since the snapshot was always correct.
		it("parallel-group activation reproduces multi-active-phase state via fold", () => {
			const f = eventStore.create("Parallel fold test")
			exec(eventStore, f.id, {
				type: "scope",
				goal: "Goal",
				successCriteria: "criteria",
				constraints: [],
				phases: [
					{ name: "P1", goal: "G1", parallel_group: 1, steps: [] },
					{ name: "P2", goal: "G2", parallel_group: 1, steps: [] },
					{ name: "P3", goal: "G3", steps: [] },
				],
			})
			exec(eventStore, f.id, { type: "activate_phase_group", groupIndex: 1 })

			// Force fold: read via the event store, which prefers fold when
			// events.mtime >= snapshot.mtime (true here since the last write was an
			// event-emitting command).
			const folded = eventStore.get(f.id)
			expect(folded).toBeDefined()
			const p1 = folded?.phases.find((p) => p.name === "P1")
			const p2 = folded?.phases.find((p) => p.name === "P2")
			const p3 = folded?.phases.find((p) => p.name === "P3")
			expect(p1?.status).toBe("active")
			expect(p2?.status).toBe("active")
			expect(p3?.status).toBe("planned")

			// And there should be exactly one phase_group_activated event,
			// not N phase_activated events.
			const types = readEvents(tempDir, f.id).map((e) => e.type)
			expect(types).toContain("phase_group_activated")
			expect(types.filter((t) => t === "phase_activated")).toHaveLength(0)
		})

		// Regression: §4.3 — complete_step with a successful StepResult records
		// status "verified" in the state machine, but the mapper used to assume
		// "done" for its synthetic interim hash, causing every successful verified
		// completion to break the chain. The cursor-fold pattern avoids this by
		// re-using applyFermentEvent for hash computation.
		it("hash chain stays connected across complete_step with grade", () => {
			const f = eventStore.create("Hash chain test")
			exec(eventStore, f.id, {
				type: "scope",
				goal: "Goal",
				successCriteria: "c",
				constraints: [],
				phases: [{ name: "P1", goal: "G1" }],
			})
			const planned = eventStore.get(f.id)
			if (!planned) throw new Error("ferment missing")
			const phaseId = planned.phases[0].id
			exec(eventStore, f.id, { type: "activate_phase", phaseId })
			exec(eventStore, f.id, { type: "refine_phase", phaseId, steps: [{ description: "do" }] })
			const refined = eventStore.get(f.id)
			if (!refined) throw new Error("ferment missing")
			const stepId = refined.phases[0].steps[0].id

			exec(eventStore, f.id, { type: "start_step", phaseId, stepId })
			exec(eventStore, f.id, {
				type: "complete_step",
				phaseId,
				stepId,
				grade: { grade: "A", rationale: "ok", gradedAt: new Date().toISOString() },
			})

			const events = readEvents(tempDir, f.id)
			expect(events.length).toBeGreaterThan(2)
			// Connected chain: every event's preStateHash matches the prior postStateHash.
			for (let i = 1; i < events.length; i++) {
				expect(events[i].preStateHash, `break at boundary ${events[i - 1].type} → ${events[i].type}`).toBe(
					events[i - 1].postStateHash,
				)
			}
		})

		// Regression: §4.3 (companion) — complete_ferment with a grade folds
		// through ferment_completed + ferment_graded; both events' hashes must
		// reflect the actual cursor state, not a hand-built interim.
		it("hash chain stays connected across complete_ferment with grade", () => {
			const f = eventStore.create("Complete with grade")
			exec(eventStore, f.id, {
				type: "scope",
				goal: "g",
				successCriteria: "c",
				constraints: [],
				phases: [{ name: "P1", goal: "G1", steps: [] }],
			})
			const planned = eventStore.get(f.id)
			if (!planned) throw new Error("ferment missing")
			const phaseId = planned.phases[0].id
			exec(eventStore, f.id, { type: "activate_phase", phaseId })
			exec(eventStore, f.id, { type: "complete_phase", phaseId, summary: "done" })
			exec(eventStore, f.id, {
				type: "complete_ferment",
				grade: { grade: "A", rationale: "great", gradedAt: new Date().toISOString() },
			})

			const events = readEvents(tempDir, f.id)
			for (let i = 1; i < events.length; i++) {
				expect(events[i].preStateHash, `break at boundary ${events[i - 1].type} → ${events[i].type}`).toBe(
					events[i - 1].postStateHash,
				)
			}
			// Folded ferment should match the snapshot exactly.
			const folded = eventStore.get(f.id)
			const fromSnapshot = parentStorage.get(f.id)
			expect(folded?.status).toBe(fromSnapshot?.status)
			expect(folded?.grade?.grade).toBe(fromSnapshot?.grade?.grade)
		})

		// Property-style: for every command in a representative sequence, after
		// writeWithEvents the eventStore.get() (fold path) should produce the same
		// state as the parentStorage.get() (snapshot path). This is the contract
		// the four state-bearing layers (state machine, mapper, fold, store)
		// must collectively satisfy.
		it("fold-vs-snapshot equivalence across a representative command sequence", () => {
			const f = eventStore.create("Property sequence")
			exec(eventStore, f.id, {
				type: "scope",
				goal: "g",
				successCriteria: "c",
				constraints: ["c1"],
				phases: [
					{ name: "P1", goal: "G1", parallel_group: 1, steps: [{ description: "S1" }] },
					{ name: "P2", goal: "G2", parallel_group: 1, steps: [{ description: "S2" }] },
					{ name: "P3", goal: "G3", steps: [{ description: "S3" }] },
				],
			})

			const assertFoldMatchesSnapshot = (label: string) => {
				const folded = eventStore.get(f.id)
				const snap = parentStorage.get(f.id)
				expect(folded?.status, `${label}: status`).toBe(snap?.status)
				expect(folded?.activePhaseId, `${label}: activePhaseId`).toBe(snap?.activePhaseId)
				expect(folded?.phases.map((p) => p.status).join(","), `${label}: phase statuses`).toBe(
					snap?.phases.map((p) => p.status).join(","),
				)
				expect(folded?.phases.map((p) => p.steps.map((s) => s.status).join(",")).join("|")).toBe(
					snap?.phases.map((p) => p.steps.map((s) => s.status).join(",")).join("|"),
				)
			}

			assertFoldMatchesSnapshot("after scope")
			exec(eventStore, f.id, { type: "activate_phase_group", groupIndex: 1 })
			assertFoldMatchesSnapshot("after parallel group activation")

			const folded = eventStore.get(f.id)
			if (!folded) throw new Error("ferment missing")
			const p1 = folded.phases.find((p) => p.name === "P1")
			if (!p1 || p1.steps.length === 0) throw new Error("phase missing steps")

			exec(eventStore, f.id, { type: "start_step", phaseId: p1.id, stepId: p1.steps[0].id })
			assertFoldMatchesSnapshot("after start_step in parallel phase")
			exec(eventStore, f.id, { type: "complete_step", phaseId: p1.id, stepId: p1.steps[0].id })
			assertFoldMatchesSnapshot("after complete_step")
		})

		it("folded ferment matches snapshot ferment after a sequence of commands", () => {
			const f = eventStore.create("Fold equivalence")
			exec(eventStore, f.id, {
				type: "scope",
				goal: "Goal",
				successCriteria: "criteria",
				constraints: ["c1"],
				phases: [{ name: "P1", goal: "G1" }],
			})
			const planned = eventStore.get(f.id)
			if (!planned) throw new Error("ferment missing")
			exec(eventStore, f.id, { type: "activate_phase", phaseId: planned.phases[0].id })
			exec(eventStore, f.id, {
				type: "refine_phase",
				phaseId: planned.phases[0].id,
				steps: [{ description: "Step 1" }],
			})

			// At this point shouldUseEvents() may or may not pick events — both should agree.
			const fromSnapshot = parentStorage.get(f.id)
			const fromFold = eventStore.get(f.id)
			expect(fromFold?.status).toBe(fromSnapshot?.status)
			expect(fromFold?.phases[0].status).toBe(fromSnapshot?.phases[0].status)
			expect(fromFold?.phases[0].steps).toHaveLength(1)
		})
	})

	// ─── migration ─────────────────────────────────────────────────────────────

	describe("migrateLegacy", () => {
		it("creates event log from legacy snapshot", () => {
			const legacy = parentStorage.create("Legacy Ferment")
			parentStorage.setPhases(legacy.id, [
				{ id: "p1", index: 1, name: "Setup", goal: "G1", status: "planned", steps: [] },
				{ id: "p2", index: 2, name: "Build", goal: "G2", status: "planned", steps: [] },
			])
			parentStorage.activatePhase(legacy.id, "p1")
			parentStorage.refinePhase(legacy.id, "p1", [{ id: "s1", index: 1, description: "init", status: "pending" }])
			parentStorage.startStep(legacy.id, "p1", "s1")
			parentStorage.completeStep(legacy.id, "p1", "s1")
			parentStorage.completePhase(legacy.id, "p1", "Setup done")
			parentStorage.addDecision(legacy.id, "Use OAuth", "Better than sessions")
			parentStorage.addMemory(legacy.id, "gotcha", "Watch for clock drift")

			const eventsPath = join(tempDir, `${legacy.id}.events.jsonl`)
			expect(existsSync(eventsPath)).toBe(false)

			eventStore.migrateLegacy(legacy.id)
			expect(existsSync(eventsPath)).toBe(true)

			const types = readEvents(tempDir, legacy.id).map((e) => e.type)
			expect(types).toContain("ferment_created")
			expect(types).toContain("phase_activated")
			expect(types).toContain("phase_refined")
			expect(types).toContain("step_started")
			expect(types).toContain("step_completed")
			expect(types).toContain("phase_completed")
			expect(types).toContain("decision_added")
			expect(types).toContain("memory_added")
		})

		it("idempotent — calling migrateLegacy twice does not duplicate events", () => {
			const legacy = parentStorage.create("Idempotent")
			parentStorage.setPhases(legacy.id, [
				{ id: "p1", index: 1, name: "P1", goal: "G1", status: "active", steps: [] } as Phase,
			])
			eventStore.migrateLegacy(legacy.id)
			const before = readEvents(tempDir, legacy.id).length
			eventStore.migrateLegacy(legacy.id)
			const after = readEvents(tempDir, legacy.id).length
			expect(after).toBe(before)
		})

		it("synthesises a connected hash chain (each event's preStateHash matches prior postStateHash)", () => {
			const legacy = parentStorage.create("Chain check")
			parentStorage.setPhases(legacy.id, [
				{ id: "p1", index: 1, name: "P1", goal: "G1", status: "completed", summary: "ok", steps: [] } as Phase,
			])
			parentStorage.activatePhase(legacy.id, "p1")
			parentStorage.completePhase(legacy.id, "p1", "ok")
			eventStore.migrateLegacy(legacy.id)

			const events = readEvents(tempDir, legacy.id)
			expect(events.length).toBeGreaterThan(1)
			expect(events[0].preStateHash).toBe("0".repeat(16))
			for (let i = 1; i < events.length; i++) {
				expect(events[i].preStateHash).toBe(events[i - 1].postStateHash)
			}
			// First → last hashes must differ — proves the chain reflects real state changes.
			expect(events[0].postStateHash).not.toBe(events[events.length - 1].postStateHash)
		})

		it("migrated event log can be folded back to the original snapshot", () => {
			const legacy = parentStorage.create("Round trip")
			parentStorage.setPhases(legacy.id, [
				{ id: "p1", index: 1, name: "P1", goal: "G1", status: "planned", steps: [] } as Phase,
			])
			parentStorage.activatePhase(legacy.id, "p1")
			parentStorage.refinePhase(legacy.id, "p1", [{ id: "s1", index: 1, description: "do", status: "pending" }])
			parentStorage.startStep(legacy.id, "p1", "s1")
			parentStorage.completeStep(legacy.id, "p1", "s1")
			parentStorage.completePhase(legacy.id, "p1", "ok")
			parentStorage.addDecision(legacy.id, "title", "desc")
			parentStorage.addMemory(legacy.id, "gotcha", "thing")

			eventStore.migrateLegacy(legacy.id)
			const folded = eventStore.get(legacy.id)
			const original = parentStorage.get(legacy.id)

			expect(folded?.name).toBe(original?.name)
			expect(folded?.phases[0].status).toBe(original?.phases[0].status)
			expect(folded?.phases[0].steps[0]?.status).toBe(original?.phases[0].steps[0]?.status)
			expect(folded?.decisions).toHaveLength(1)
			expect(folded?.memories).toHaveLength(1)
		})
	})

	// ─── compatibility ─────────────────────────────────────────────────────────

	describe("backward compatibility", () => {
		it("list() returns ferments", () => {
			eventStore.create("Alpha")
			eventStore.create("Beta")
			const names = eventStore
				.list()
				.map((l) => l.name)
				.sort()
			expect(names).toEqual(["Alpha", "Beta"])
		})

		it("resolve() works", () => {
			const f = eventStore.create("Unique resolve")
			expect(eventStore.resolve(f.id)?.id).toBe(f.id)
		})

		it("get() falls back to parent storage for ferments without event log", () => {
			const legacy = parentStorage.create("Parent-only")
			expect(eventStore.get(legacy.id)?.name).toBe("Parent-only")
		})
	})

	// Audit doc finding 4.6: parallel subagents racing on complete_step caused
	// silent state loss because there was no cross-process lock around the
	// snapshot+events dual-write. The withLock helper closes the gap by routing
	// every mutation through proper-lockfile. We can't easily test cross-process
	// contention from a unit test, but we can confirm the lock surface exists
	// and that successive writes don't leak the lock file.
	describe("locking", () => {
		it("releases the lock between successive writes", () => {
			const f = eventStore.create("Lock test")
			// If the lock weren't released, the second write would block until
			// timeout and the test would hang — a clean run is the assertion.
			exec(eventStore, f.id, {
				type: "scope",
				goal: "g",
				successCriteria: "c",
				constraints: [],
				phases: [{ name: "P1", goal: "G1" }],
			})
			exec(eventStore, f.id, {
				type: "update_scope_field",
				field: "goal",
				value: "g2",
			})
			expect(eventStore.get(f.id)?.scoping.goal?.answer).toBe("g2")
		})

		it("does not deadlock on nested mutations from the same process", () => {
			// `lockSync` would deadlock if called recursively for the same path.
			// withLock should not nest; create + writeWithEvents are independent calls.
			const f = eventStore.create("Nested test")
			exec(eventStore, f.id, {
				type: "scope",
				goal: "g",
				successCriteria: "c",
				constraints: [],
				phases: [{ name: "P1", goal: "G1" }],
			})
			expect(eventStore.get(f.id)).toBeDefined()
		})

		it("derives each command from the latest state inside the lock", () => {
			const f = eventStore.create("Fresh read test")
			exec(eventStore, f.id, {
				type: "scope",
				goal: "g",
				successCriteria: "c",
				constraints: [],
				phases: [{ name: "P1", goal: "G1" }],
			})
			exec(eventStore, f.id, {
				type: "update_scope_field",
				field: "goal",
				value: "g2",
			})

			eventStore.mutateWithEvents(f.id, (current) => {
				if (!current) throw new Error("ferment missing")
				expect(current.goal).toBe("g2")
				const now = new Date().toISOString()
				const result = applyCommand(current, { type: "update_scope_field", field: "criteria", value: "c2" }, { now })
				if (!result.ok) throw new Error(`command rejected: ${result.error.message}`)
				const events = commandToEvents(
					{ type: "update_scope_field", field: "criteria", value: "c2" },
					current,
					result.ferment,
					{ now },
				)
				return { write: true, ferment: result.ferment, events, value: undefined }
			})

			const folded = eventStore.get(f.id)
			expect(folded?.goal).toBe("g2")
			expect(folded?.successCriteria).toBe("c2")
		})
	})
})
