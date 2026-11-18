import { describe, expect, it, vi } from "vitest"
import { createSessionLogHarness } from "../__mocks__/session-log.js"
import {
	activateDirector,
	assertDirectorCanSpawn,
	type DirectorWorkerSnapshot,
	finishDirector,
	reconcileDirectorResume,
	reconcileDirectorWorker,
} from "./lifecycle.js"
import { createDirectorState } from "./plan.js"
import { DirectorStore } from "./state.js"

function makeWorker(id: string, overrides: Partial<DirectorWorkerSnapshot> = {}): DirectorWorkerSnapshot {
	return {
		id,
		type: "Builder",
		description: "Do work",
		status: "running",
		startedAt: 1,
		...overrides,
	}
}

function activeRun(worker?: DirectorWorkerSnapshot) {
	const state = createDirectorState("Run objective", "run-active")
	if (worker) {
		state.plan.workers[worker.id] = {
			id: worker.id,
			type: worker.type,
			description: worker.description,
			status: worker.status,
			disposition: "owned",
			artifactPaths: [],
		}
	}
	return state
}

function gateway(initial: DirectorWorkerSnapshot[] = []) {
	const workers = [...initial]
	return {
		workers,
		list: () => workers,
		abort: vi.fn((id: string) => {
			const worker = workers.find((candidate) => candidate.id === id)
			if (!worker) return false
			worker.status = "stopped"
			worker.completedAt = 2
			return true
		}),
	}
}

describe("Director lifecycle", () => {
	it("rejects activation with an existing worker or another orchestration runtime", () => {
		for (const barrier of [
			{ workers: [makeWorker("ordinary")], otherOrchestrationActive: false },
			{ workers: [], otherOrchestrationActive: true },
		]) {
			const harness = createSessionLogHarness()
			const store = new DirectorStore(harness)
			const live = gateway(barrier.workers)
			expect(() =>
				activateDirector(store, {
					objective: "New objective",
					runId: "new-run",
					gateway: live,
					otherOrchestrationActive: () => barrier.otherOrchestrationActive,
				}),
			).toThrow(/active|already running/i)
			expect(harness.entries).toHaveLength(0)
		}
	})

	it("activates once and never replaces the active objective", () => {
		const store = new DirectorStore(createSessionLogHarness())
		const live = gateway()
		const first = activateDirector(store, { objective: "First", runId: "first", gateway: live })
		expect(first.revision).toBe(1)

		expect(() => activateDirector(store, { objective: "Replacement", runId: "replacement", gateway: live })).toThrow(
			/active/i,
		)
		expect(store.read()?.runId).toBe("first")
		expect(store.read()?.objective).toBe("First")
	})

	it("starts a fresh objective after the previous run became inactive", () => {
		const store = new DirectorStore(createSessionLogHarness())
		const live = gateway()
		const first = activateDirector(store, { objective: "First", runId: "first", gateway: live })
		store.commit({ ...first, status: "inactive" }, first.revision)

		const second = activateDirector(store, { objective: "Second", runId: "second", gateway: live })
		expect(second.objective).toBe("Second")
		expect(second.revision).toBe(first.revision + 2)
	})

	it("rejects completion while required tasks are open", () => {
		const store = new DirectorStore(createSessionLogHarness())
		const initial = activeRun()
		initial.plan.tasks = [{ id: "unfinished", title: "Finish it", status: "running", dependsOn: [] }]
		store.commit(initial, 0)

		expect(() =>
			finishDirector(store, { outcome: "completed", verificationSummary: "Attempted tests", gateway: gateway() }),
		).toThrow(/complete or explicitly skip/i)
		expect(store.read()?.status).toBe("active")
	})

	it("requires verification and completed tasks before successful completion", () => {
		const harness = createSessionLogHarness()
		const store = new DirectorStore(harness)
		activateDirector(store, { objective: "Verify it", runId: "verify", gateway: gateway() })
		store.commit({ ...(store.read() ?? activeRun()) }, 1)

		expect(() => finishDirector(store, { outcome: "completed", gateway: gateway() })).toThrow(/verification/i)
		const withVerification = finishDirector(store, {
			outcome: "completed",
			verificationSummary: "Unit and lifecycle suites green",
			artifactPaths: ["artifacts/verification.txt"],
			gateway: gateway(),
		})
		expect(withVerification.status).toBe("inactive")
		expect(withVerification.plan.verification.at(-1)).toMatchObject({
			summary: "Unit and lifecycle suites green",
			outcome: "completed",
		})
	})

	it("finishes only after owned workers are stopped or explicitly handed off", () => {
		const stoppedStore = new DirectorStore(createSessionLogHarness())
		const liveWorker = makeWorker("worker-live")
		const live = gateway([liveWorker])
		stoppedStore.commit(activeRun(liveWorker), 0)
		const cancelled = finishDirector(stoppedStore, { outcome: "cancelled", gateway: live })
		expect(live.abort).toHaveBeenCalledWith("worker-live")
		expect(cancelled.plan.workers["worker-live"].disposition).toBe("stopped")
		expect(cancelled.status).toBe("inactive")

		const handedStore = new DirectorStore(createSessionLogHarness())
		const handedWorker = makeWorker("worker-handoff")
		const remaining = gateway([handedWorker])
		handedStore.commit(activeRun(handedWorker), 0)
		const handed = finishDirector(handedStore, {
			outcome: "completed",
			verificationSummary: "Handed off",
			gateway: remaining,
			handoff: true,
		})
		expect(remaining.abort).not.toHaveBeenCalled()
		expect(handed.plan.workers["worker-handoff"].disposition).toBe("handed-off")
		expect(handed.status).toBe("inactive")
	})
})

describe("Director resume reconciliation", () => {
	it("blocks new delegation until a missing local worker is explicitly resolved", () => {
		const store = new DirectorStore(createSessionLogHarness())
		store.commit(activeRun(makeWorker("dead-local")), 0)
		const live = gateway([])

		reconcileDirectorResume(store, live)
		expect(store.read()?.plan.workers["dead-local"].disposition).toBe("uncertain")
		expect(() => assertDirectorCanSpawn(store)).toThrow(/reconcil/i)

		reconcileDirectorWorker(store, { workerId: "dead-local", disposition: "stopped", note: "Local worker died" })
		expect(() => assertDirectorCanSpawn(store)).not.toThrow()
		expect(store.read()?.plan.workers["dead-local"].recoveryNote).toBe("Local worker died")
	})

	it("reuses a matching remote record without marking it uncertain", () => {
		const store = new DirectorStore(createSessionLogHarness())
		store.commit(activeRun(makeWorker("remote-1", { remote: true })), 0)
		const live = gateway([makeWorker("remote-1", { remote: true })])

		reconcileDirectorResume(store, live)
		expect(store.read()?.plan.workers["remote-1"].disposition).toBe("owned")
		expect(Object.keys(store.read()?.plan.workers ?? {})).toEqual(["remote-1"])
		expect(() => assertDirectorCanSpawn(store)).not.toThrow()
	})

	it("joins only workers with a matching terminal record", () => {
		const store = new DirectorStore(createSessionLogHarness())
		store.commit(activeRun(makeWorker("finished", { status: "completed", completedAt: 2 })), 0)
		const live = gateway([makeWorker("finished", { status: "completed", completedAt: 2 })])

		reconcileDirectorResume(store, live)
		expect(store.read()?.plan.workers["finished"].disposition).toBe("joined")
	})
})
