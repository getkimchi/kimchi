/**
 * Unit tests for the cohort lifecycle coordinator.
 *
 * Verifies the per-command 2s handoffs (each command gets its own deadline),
 * the absence of any recurring clock (timer-count stability across long
 * advances), bounded checkpoint waits (300s default, caller-passed
 * durations, joiners without deadline resets, early exits, last-handle
 * removal, abort/dispose cleanup), and the checkpoint-streak bookkeeping.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createFakeOps, type FakeOps } from "./__mocks__/fake-bash-ops.js"
import { createProcessRegistry } from "./process-registry.js"
import { createReviewCoordinator } from "./review-coordinator.js"
import { createTerminalDelivery } from "./terminal-delivery.js"

const HANDOFF = 2

let ops: FakeOps
let registry: ReturnType<typeof createProcessRegistry>
// Long enough that the registry's safety-deadline timer never fires inside
// a test advance (its presence is constant, not under test).
const opts = { limitSeconds: 3600 }

function makeCoordinator(waitSeconds?: number) {
	return createReviewCoordinator({ registry, handoffSeconds: HANDOFF, waitSeconds })
}

function spawnOne(command = "sleep 100"): string {
	return registry.spawn(ops, command, "/tmp", undefined, opts)
}

beforeEach(() => {
	vi.useFakeTimers()
	ops = createFakeOps(0)
	registry = createProcessRegistry()
})

afterEach(async () => {
	vi.useRealTimers()
	await registry.shutdown()
})

describe("initial handoff", () => {
	it("resolves 'handoff' at the command's own 2s deadline", async () => {
		const c = makeCoordinator()
		const h = spawnOne()
		c.handleSpawned(h)
		const p = c.awaitInitialHandoff(h)
		await vi.advanceTimersByTimeAsync(HANDOFF * 1000 - 1)
		// Still pending one tick before the deadline.
		let settled = false
		void p.then(() => {
			settled = true
		})
		await vi.advanceTimersByTimeAsync(0)
		expect(settled).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		await expect(p).resolves.toBe("handoff")
	})

	it("resolves 'exited' when the process exits before the handoff", async () => {
		const c = makeCoordinator()
		const h = spawnOne()
		c.handleSpawned(h)
		const p = c.awaitInitialHandoff(h)
		const assertion = expect(p).resolves.toBe("exited")
		await ops.exit(0)
		await assertion
	})

	it("each command gets its own full handoff deadline (no shared clock)", async () => {
		const c = makeCoordinator()
		const h1 = spawnOne("a")
		c.handleSpawned(h1)
		const p1 = c.awaitInitialHandoff(h1)
		await vi.advanceTimersByTimeAsync(1_000) // h1 has 1s left
		const h2 = spawnOne("b")
		c.handleSpawned(h2)
		const p2 = c.awaitInitialHandoff(h2)
		// h1's deadline fires; h2 still has a full second of its own.
		await vi.advanceTimersByTimeAsync(1_000)
		await expect(p1).resolves.toBe("handoff")
		let h2Settled = false
		void p2.then(() => {
			h2Settled = true
		})
		await vi.advanceTimersByTimeAsync(0)
		expect(h2Settled).toBe(false)
		await vi.advanceTimersByTimeAsync(1_000)
		await expect(p2).resolves.toBe("handoff")
	})

	it("resolves 'aborted' when the signal fires before the handoff", async () => {
		const c = makeCoordinator()
		const h = spawnOne()
		c.handleSpawned(h)
		const controller = new AbortController()
		const p = c.awaitInitialHandoff(h, controller.signal)
		controller.abort()
		await expect(p).resolves.toBe("aborted")
	})

	it("clears the handoff timer after settlement (no leak)", async () => {
		const c = makeCoordinator()
		const h = spawnOne()
		c.handleSpawned(h)
		const before = vi.getTimerCount()
		const p = c.awaitInitialHandoff(h) // +1 handoff timer
		expect(vi.getTimerCount()).toBe(before + 1)
		await vi.advanceTimersByTimeAsync(HANDOFF * 1000)
		await p
		expect(vi.getTimerCount()).toBe(before)
	})
})

describe("no recurring clock", () => {
	it("arms no timer after the handoff — time passes with no wait and no callback", async () => {
		const c = makeCoordinator()
		const h = spawnOne()
		c.handleSpawned(h)
		const p = c.awaitInitialHandoff(h)
		await vi.advanceTimersByTimeAsync(HANDOFF * 1000)
		await p
		const afterHandoff = vi.getTimerCount()
		// Advance across multiple five-minute windows with no active wait:
		// no recurring review clock may arm (the only remaining timer is the
		// registry's safety deadline, which stays armed but is not new).
		await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
		await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
		expect(vi.getTimerCount()).toBe(afterHandoff)
	})

	it("creating a cohort with an active wait still adds only the wait's checkpoint timer", async () => {
		const c = makeCoordinator()
		const h = spawnOne()
		c.handleSpawned(h)
		const p = c.awaitInitialHandoff(h)
		await vi.advanceTimersByTimeAsync(HANDOFF * 1000)
		await p
		const afterHandoff = vi.getTimerCount()
		expect(c.beginCohortWait("call-1")).toEqual({ ok: true })
		const event = c.awaitCohortEvent("call-1", undefined, 10)
		expect(vi.getTimerCount()).toBe(afterHandoff + 1)
		await vi.advanceTimersByTimeAsync(10_000)
		await expect(event).resolves.toEqual({ kind: "checkpoint" })
		expect(vi.getTimerCount()).toBe(afterHandoff)
		c.endCohortWait("call-1")
	})
})

describe("cohort wait", () => {
	it("resolves on the first process exit", async () => {
		const c = makeCoordinator()
		const h = spawnOne()
		c.handleSpawned(h)
		expect(c.beginCohortWait("call-1")).toEqual({ ok: true })
		const event = c.awaitCohortEvent("call-1", undefined, 300)
		const assertion = expect(event).resolves.toEqual({ kind: "exit", handle: h })
		await ops.exit(0)
		await assertion
	})

	it("resolves at the 300s default checkpoint when no duration is passed", async () => {
		const c = makeCoordinator()
		const h = spawnOne()
		c.handleSpawned(h)
		expect(c.beginCohortWait("call-1")).toEqual({ ok: true })
		const event = c.awaitCohortEvent("call-1")
		let settled = false
		void event.then(() => {
			settled = true
		})
		await vi.advanceTimersByTimeAsync(299_000)
		await vi.advanceTimersByTimeAsync(0)
		expect(settled).toBe(false)
		await vi.advanceTimersByTimeAsync(1_000)
		await expect(event).resolves.toEqual({ kind: "checkpoint" })
	})

	it("honors a caller-passed duration (600s cap comes from the caller)", async () => {
		const c = makeCoordinator()
		const h = spawnOne()
		c.handleSpawned(h)
		expect(c.beginCohortWait("call-1")).toEqual({ ok: true })
		const event = c.awaitCohortEvent("call-1", undefined, 600)
		let settled = false
		void event.then(() => {
			settled = true
		})
		await vi.advanceTimersByTimeAsync(599_000)
		await vi.advanceTimersByTimeAsync(0)
		expect(settled).toBe(false)
		await vi.advanceTimersByTimeAsync(1_000)
		await expect(event).resolves.toEqual({ kind: "checkpoint" })
	})

	it("schedules fractional durations exactly (no one-second minimum)", async () => {
		const c = makeCoordinator()
		const h = spawnOne()
		c.handleSpawned(h)
		expect(c.beginCohortWait("call-1")).toEqual({ ok: true })
		const event = c.awaitCohortEvent("call-1", undefined, 0.05)
		let settled = false
		void event.then(() => {
			settled = true
		})
		await vi.advanceTimersByTimeAsync(49)
		expect(settled).toBe(false)
		await vi.advanceTimersByTimeAsync(1)
		await expect(event).resolves.toEqual({ kind: "checkpoint" })
	})

	it("a joiner spawned DURING the wait resolves it on exit without restarting the checkpoint", async () => {
		const c = makeCoordinator()
		const h1 = spawnOne("a")
		c.handleSpawned(h1)
		expect(c.beginCohortWait("call-1")).toEqual({ ok: true })
		const event = c.awaitCohortEvent("call-1", undefined, 300)
		const timerCountAfterWait = vi.getTimerCount()
		const h2 = spawnOne("b")
		c.handleSpawned(h2)
		// The joiner adds only its own registry deadline timer — the wait's
		// checkpoint was NOT restarted or postponed.
		const joinerDeadline = vi.getTimerCount() - timerCountAfterWait
		expect(joinerDeadline).toBe(1)
		const assertion = expect(event).resolves.toEqual({ kind: "exit", handle: h2 })
		await ops.exitMatching("b", 0)
		await assertion
	})

	it("rejects a second concurrent wait without stealing ownership", async () => {
		const c = makeCoordinator()
		const h = spawnOne()
		c.handleSpawned(h)
		expect(c.beginCohortWait("call-1")).toEqual({ ok: true })
		const claim2 = c.beginCohortWait("call-2")
		expect(claim2.ok).toBe(false)
		expect(c.hasActiveWait()).toBe(true)
		const event = c.awaitCohortEvent("call-1")
		const assertion = expect(event).resolves.toEqual({ kind: "exit", handle: h })
		await ops.exit(0)
		await assertion
		c.endCohortWait("call-1")
		expect(c.hasActiveWait()).toBe(false)
	})

	it("resolves immediately when a handle is already terminal when the wait begins", async () => {
		const c = makeCoordinator()
		const h = spawnOne()
		c.handleSpawned(h)
		// Exit with no active wait: the exit observer fires unobserved.
		await ops.exit(0)
		expect(c.beginCohortWait("call-1")).toEqual({ ok: true })
		const event = c.awaitCohortEvent("call-1")
		await expect(event).resolves.toEqual({ kind: "exit", handle: h })
	})

	it("removing the last handle settles the wait instead of stranding it until the deadline", async () => {
		const c = makeCoordinator()
		const h = spawnOne()
		c.handleSpawned(h)
		expect(c.beginCohortWait("call-1")).toEqual({ ok: true })
		const event = c.awaitCohortEvent("call-1", undefined, 300)
		// Simulate an external collection removing the handle without an
		// observable exit (e.g. a racing stop already collected it).
		c.handleRemoved(h)
		await expect(event).resolves.toEqual({ kind: "empty" })
	})

	it("removing the last handle after its exit already settled the wait is a no-op", async () => {
		const c = makeCoordinator()
		const h = spawnOne()
		c.handleSpawned(h)
		expect(c.beginCohortWait("call-1")).toEqual({ ok: true })
		const event = c.awaitCohortEvent("call-1")
		const assertion = expect(event).resolves.toEqual({ kind: "exit", handle: h })
		await ops.exit(0)
		await assertion
		// The collection path removes the handle after the wait resolved.
		c.handleRemoved(h)
		expect(c.hasActiveWait()).toBe(false)
	})

	it("a settled wait ignores late exits of handles that outlive it", async () => {
		const c = makeCoordinator()
		const h1 = spawnOne("a")
		c.handleSpawned(h1)
		expect(c.beginCohortWait("call-1")).toEqual({ ok: true })
		const first = c.awaitCohortEvent("call-1", undefined, 300)
		const assertion = expect(first).resolves.toEqual({ kind: "checkpoint" })
		await vi.advanceTimersByTimeAsync(300_000)
		await assertion
		// A process spawned after the wait settled may exit without
		// throwing or resurrecting a wait.
		const h2 = spawnOne("b")
		c.handleSpawned(h2)
		await ops.exitMatching("b", 0)
		expect(c.hasActiveWait()).toBe(false)
	})

	it("does not accumulate timers across many sequential waits on one long-lived command", async () => {
		const c = makeCoordinator()
		const h = spawnOne()
		c.handleSpawned(h)
		const handoff = c.awaitInitialHandoff(h)
		await vi.advanceTimersByTimeAsync(HANDOFF * 1000)
		await handoff
		for (let i = 0; i < 20; i++) {
			expect(c.beginCohortWait(`call-${i}`)).toEqual({ ok: true })
			const event = c.awaitCohortEvent(`call-${i}`, undefined, 10)
			await vi.advanceTimersByTimeAsync(10_000)
			await expect(event).resolves.toEqual({ kind: "checkpoint" })
		}
		// Only the registry's safety-deadline timer remains armed — each
		// wait's checkpoint timer was cleared on settlement.
		const stable = vi.getTimerCount()
		expect(stable).toBe(1)
		await vi.advanceTimersByTimeAsync(10_000)
		expect(vi.getTimerCount()).toBe(stable)
	})

	it("abort resolves the wait as 'aborted' and clears its timer", async () => {
		const c = makeCoordinator()
		const h = spawnOne()
		c.handleSpawned(h)
		expect(c.beginCohortWait("call-1")).toEqual({ ok: true })
		const controller = new AbortController()
		const before = vi.getTimerCount()
		const event = c.awaitCohortEvent("call-1", controller.signal, 300)
		expect(vi.getTimerCount()).toBe(before + 1)
		const assertion = expect(event).resolves.toEqual({ kind: "aborted" })
		controller.abort()
		await assertion
		expect(vi.getTimerCount()).toBe(before)
		expect(c.hasActiveWait()).toBe(false)
	})

	it("dispose resolves pending waits as 'aborted' and clears timers", async () => {
		const c = makeCoordinator()
		const h = spawnOne()
		c.handleSpawned(h)
		expect(c.beginCohortWait("call-1")).toEqual({ ok: true })
		const event = c.awaitCohortEvent("call-1", undefined, 300)
		const assertion = expect(event).resolves.toEqual({ kind: "aborted" })
		c.dispose()
		await assertion
		await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
		expect(c.hasActiveWait()).toBe(false)
	})
})

describe("checkpoint streaks", () => {
	it("starts at zero for a new process", () => {
		const c = makeCoordinator()
		const h = spawnOne()
		c.handleSpawned(h)
		expect(c.getCheckpointStreak(h)).toBe(0)
	})

	it("commitWaitTimeout increments only reported handles", () => {
		const c = makeCoordinator()
		const a = spawnOne("a")
		const b = spawnOne("b")
		c.handleSpawned(a)
		c.handleSpawned(b)
		c.commitWaitTimeout([a])
		expect(c.getCheckpointStreak(a)).toBe(1)
		expect(c.getCheckpointStreak(b)).toBe(0)
		c.commitWaitTimeout([a])
		expect(c.getCheckpointStreak(a)).toBe(2)
	})

	it("commitObservation resets reported handles", () => {
		const c = makeCoordinator()
		const a = spawnOne("a")
		c.handleSpawned(a)
		c.commitWaitTimeout([a])
		c.commitWaitTimeout([a])
		c.commitObservation([a])
		expect(c.getCheckpointStreak(a)).toBe(0)
	})

	it("handleRemoved deletes the history; a re-joined handle starts fresh", () => {
		const c = makeCoordinator()
		const a = spawnOne("a")
		c.handleSpawned(a)
		c.commitWaitTimeout([a])
		c.handleRemoved(a)
		expect(c.getCheckpointStreak(a)).toBe(0)
	})

	it("commitWaitTimeout ignores handles no longer in the cohort", () => {
		const c = makeCoordinator()
		const a = spawnOne("a")
		c.handleSpawned(a)
		c.handleRemoved(a)
		c.commitWaitTimeout([a])
		expect(c.getCheckpointStreak(a)).toBe(0)
	})
})

describe("pending automatic delivery", () => {
	it("checks already queued results after subscribing without starting a timer", async () => {
		const c = makeCoordinator()
		c.handleSpawned(spawnOne())
		const delivery = createTerminalDelivery()
		delivery.record("exit", "payload", "automatic")
		delivery.markQueued("exit", "batch")
		const timersBefore = vi.getTimerCount()
		c.beginCohortWait("call")
		await expect(c.awaitCohortEvent("call", undefined, 10, delivery)).resolves.toEqual({ kind: "pending-delivery" })
		expect(vi.getTimerCount()).toBe(timersBefore)
		expect(c.hasActiveWait()).toBe(false)
	})

	it("does not wake for available outcomes or results owned by another control call", async () => {
		const c = makeCoordinator()
		c.handleSpawned(spawnOne())
		const delivery = createTerminalDelivery()
		c.beginCohortWait("call")
		const event = c.awaitCohortEvent("call", undefined, 1, delivery)
		delivery.record("available", "payload", "automatic")
		delivery.record("owned", "payload", { controlCallId: "other" })
		expect(delivery.markQueued("owned", "batch")).toBeUndefined()
		await vi.advanceTimersByTimeAsync(1_000)
		await expect(event).resolves.toEqual({ kind: "checkpoint" })
	})

	it.each([
		"checkpoint",
		"abort",
		"exit",
		"dispose",
		"pending",
	] as const)("cleans up the enqueue subscription and timer on %s", async (mode) => {
		const c = makeCoordinator()
		c.handleSpawned(spawnOne())
		const delivery = createTerminalDelivery()
		const subscribe = delivery.onQueuedAutomatic.bind(delivery)
		const cleanup = vi.fn()
		vi.spyOn(delivery, "onQueuedAutomatic").mockImplementation((listener) => {
			const unsubscribe = subscribe(listener)
			return () => {
				cleanup()
				unsubscribe()
			}
		})
		const controller = new AbortController()
		c.beginCohortWait("call")
		const event = c.awaitCohortEvent("call", controller.signal, 10, delivery)
		if (mode === "checkpoint") await vi.advanceTimersByTimeAsync(10_000)
		else if (mode === "abort") controller.abort()
		else if (mode === "exit") await ops.exit(0)
		else if (mode === "dispose") c.dispose()
		else {
			delivery.record("exit", "payload", "automatic")
			delivery.markQueued("exit", "batch")
		}
		await event
		expect(cleanup).toHaveBeenCalledOnce()
		expect(c.hasActiveWait()).toBe(false)
		// Late enqueues cannot wake or re-clean an already settled wait.
		delivery.record("late", "payload", "automatic")
		delivery.markQueued("late", "late-batch")
		expect(cleanup).toHaveBeenCalledOnce()
		expect(vi.getTimerCount()).toBe(mode === "exit" ? 0 : 1)
	})
})
