/**
 * Unit tests for the session review coordinator.
 *
 * Verifies the single shared review clock: staggered commands produce at
 * most one recurring review per interval, later joiners never create or
 * reset review timers, exits and waits are independent, and an empty
 * cohort resets the cycle.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createFakeOps, type FakeOps } from "./__mocks__/fake-bash-ops.js"
import { createProcessRegistry } from "./process-registry.js"
import { createReviewCoordinator } from "./review-coordinator.js"

const HANDOFF = 15
const INTERVAL = 60

let ops: FakeOps
let registry: ReturnType<typeof createProcessRegistry>
const opts = { limitSeconds: 600 }

function makeCoordinator(onReviewDue?: () => void) {
	return createReviewCoordinator({
		registry,
		onReviewDue,
		handoffSeconds: HANDOFF,
		reviewIntervalSeconds: INTERVAL,
	})
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
	it("resolves 'handoff' at the shared 15s deadline for the first joiner", async () => {
		const c = makeCoordinator()
		const h = spawnOne()
		c.handleSpawned(h)
		const p = c.awaitInitialHandoff(h)
		await vi.advanceTimersByTimeAsync(HANDOFF * 1000)
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

	it("joiners share the pending first handoff (never a longer wait)", async () => {
		const c = makeCoordinator()
		const h1 = spawnOne("a")
		c.handleSpawned(h1)
		const p1 = c.awaitInitialHandoff(h1)
		await vi.advanceTimersByTimeAsync(5_000)
		const h2 = spawnOne("b")
		c.handleSpawned(h2)
		const p2 = c.awaitInitialHandoff(h2)
		// 10s later both resolve — h2 did not get a fresh 15s wait.
		await vi.advanceTimersByTimeAsync(10_000)
		await expect(p1).resolves.toBe("handoff")
		await expect(p2).resolves.toBe("handoff")
	})

	it("a later joiner (during the review phase) gets its own bounded handoff without touching the clock", async () => {
		const c = makeCoordinator()
		const h1 = spawnOne("a")
		c.handleSpawned(h1)
		const p1 = c.awaitInitialHandoff(h1)
		await vi.advanceTimersByTimeAsync(HANDOFF * 1000) // first handoff → review phase, next review at +60s
		await expect(p1).resolves.toBe("handoff")
		const reviewAt = c.nextReviewAtMs
		expect(reviewAt).toBeDefined()

		const h2 = spawnOne("b")
		c.handleSpawned(h2)
		const p2 = c.awaitInitialHandoff(h2)
		await vi.advanceTimersByTimeAsync(HANDOFF * 1000)
		await expect(p2).resolves.toBe("handoff")
		// The recurring review time was not postponed by the join.
		expect(c.nextReviewAtMs).toBe(reviewAt)
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
})

describe("shared review clock", () => {
	it("fires the first recurring review 60s after the first handoff, not per process", async () => {
		const due = vi.fn()
		const c = makeCoordinator(due)
		const h1 = spawnOne("a")
		c.handleSpawned(h1)
		const p1 = c.awaitInitialHandoff(h1)
		await vi.advanceTimersByTimeAsync(10_000)
		const h2 = spawnOne("b")
		c.handleSpawned(h2)
		const p2 = c.awaitInitialHandoff(h2)
		const h3 = spawnOne("c")
		c.handleSpawned(h3)
		const p3 = c.awaitInitialHandoff(h3)

		await vi.advanceTimersByTimeAsync(5_000) // t=15s: shared first handoff
		await Promise.all([p1, p2, p3])
		expect(due).not.toHaveBeenCalled()

		await vi.advanceTimersByTimeAsync(INTERVAL * 1000) // t=75s: review #1
		expect(due).toHaveBeenCalledTimes(1)
		c.reviewDelivered()

		await vi.advanceTimersByTimeAsync(INTERVAL * 1000) // t=135s: review #2
		expect(due).toHaveBeenCalledTimes(2)
	})

	it("does not enqueue a second pending review while one is outstanding", async () => {
		const due = vi.fn()
		const c = makeCoordinator(due)
		const h = spawnOne()
		c.handleSpawned(h)
		const p = c.awaitInitialHandoff(h)
		await vi.advanceTimersByTimeAsync(HANDOFF * 1000)
		await p

		await vi.advanceTimersByTimeAsync(INTERVAL * 1000)
		expect(c.hasPendingReview()).toBe(true)
		expect(due).toHaveBeenCalledTimes(1)
		// Next tick while pending: no new notification.
		await vi.advanceTimersByTimeAsync(INTERVAL * 1000)
		expect(due).toHaveBeenCalledTimes(1)
		c.reviewDelivered()
		expect(c.hasPendingReview()).toBe(false)
		await vi.advanceTimersByTimeAsync(INTERVAL * 1000)
		expect(due).toHaveBeenCalledTimes(2)
	})

	it("resets the clock when the cohort empties; the next process starts a fresh cycle", async () => {
		const due = vi.fn()
		const c = makeCoordinator(due)
		const h1 = spawnOne("a")
		c.handleSpawned(h1)
		const p1 = c.awaitInitialHandoff(h1)
		await vi.advanceTimersByTimeAsync(HANDOFF * 1000)
		await p1

		c.handleRemoved(h1)
		expect(c.size).toBe(0)
		expect(c.nextReviewAtMs).toBeUndefined()

		const h2 = spawnOne("b")
		c.handleSpawned(h2)
		const p2 = c.awaitInitialHandoff(h2)
		await vi.advanceTimersByTimeAsync(HANDOFF * 1000)
		await expect(p2).resolves.toBe("handoff")
		await vi.advanceTimersByTimeAsync(INTERVAL * 1000)
		expect(due).toHaveBeenCalledTimes(1)
	})

	it("a due review resolves an active cohort wait instead of firing the callback", async () => {
		const due = vi.fn()
		const c = makeCoordinator(due)
		const h = spawnOne()
		c.handleSpawned(h)
		const p = c.awaitInitialHandoff(h)
		await vi.advanceTimersByTimeAsync(HANDOFF * 1000)
		await p

		expect(c.beginCohortWait("call-1")).toEqual({ ok: true })
		const event = c.awaitCohortEvent("call-1")
		const assertion = expect(event).resolves.toEqual({ kind: "review" })
		await vi.advanceTimersByTimeAsync(INTERVAL * 1000)
		await assertion
		expect(due).not.toHaveBeenCalled()
		expect(c.hasPendingReview()).toBe(false)
	})
})

describe("cohort wait", () => {
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

	it("resolves the wait on the first process exit, independent of the review clock", async () => {
		const c = makeCoordinator()
		const h = spawnOne()
		c.handleSpawned(h)
		const p = c.awaitInitialHandoff(h)
		await vi.advanceTimersByTimeAsync(HANDOFF * 1000)
		await p

		c.beginCohortWait("call-1")
		const event = c.awaitCohortEvent("call-1")
		const assertion = expect(event).resolves.toEqual({ kind: "exit", handle: h })
		await vi.advanceTimersByTimeAsync(10_000) // well before the 60s review
		await ops.exit(0)
		await assertion
	})

	it("a joiner spawned DURING an active wait still resolves it on exit", async () => {
		const c = makeCoordinator()
		const h1 = spawnOne("a")
		c.handleSpawned(h1)
		const p = c.awaitInitialHandoff(h1)
		await vi.advanceTimersByTimeAsync(HANDOFF * 1000)
		await p

		c.beginCohortWait("call-1")
		const event = c.awaitCohortEvent("call-1")
		// Spawn + join a second process AFTER the wait began: the wait must
		// not keep blocking on the original cohort alone.
		const h2 = spawnOne("b")
		c.handleSpawned(h2)
		const assertion = expect(event).resolves.toEqual({ kind: "exit", handle: h2 })
		await ops.exitMatching("b", 0)
		await assertion
	})

	it("a settled wait ignores late exits of handles that outlive it", async () => {
		const c = makeCoordinator()
		const h1 = spawnOne("a")
		c.handleSpawned(h1)
		const p = c.awaitInitialHandoff(h1)
		await vi.advanceTimersByTimeAsync(HANDOFF * 1000)
		await p

		c.beginCohortWait("call-1")
		const first = c.awaitCohortEvent("call-1")
		const assertion = expect(first).resolves.toEqual({ kind: "exit", handle: h1 })
		await ops.exitMatching("a", 0)
		await assertion
		// The wait is consumed; a second process spawned while it was active
		// may exit without throwing or resurrecting a wait.
		const h2 = spawnOne("b")
		c.handleSpawned(h2)
		await ops.exitMatching("b", 0)
		expect(c.hasActiveWait()).toBe(false)
	})

	it("abort resolves the wait as 'aborted'", async () => {
		const c = makeCoordinator()
		const h = spawnOne()
		c.handleSpawned(h)
		c.beginCohortWait("call-1")
		const controller = new AbortController()
		const event = c.awaitCohortEvent("call-1", controller.signal)
		const assertion = expect(event).resolves.toEqual({ kind: "aborted" })
		controller.abort()
		await assertion
		expect(c.hasActiveWait()).toBe(false)
	})

	it("dispose resolves pending waits as 'aborted' and clears timers", async () => {
		const due = vi.fn()
		const c = makeCoordinator(due)
		const h = spawnOne()
		c.handleSpawned(h)
		c.beginCohortWait("call-1")
		const event = c.awaitCohortEvent("call-1")
		const assertion = expect(event).resolves.toEqual({ kind: "aborted" })
		c.dispose()
		await assertion
		await vi.advanceTimersByTimeAsync(10 * INTERVAL * 1000)
		expect(due).not.toHaveBeenCalled()
	})
})
