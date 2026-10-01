/**
 * Unit tests for the `bash_control` companion tool (cohort inspection,
 * stopping, bounded waits).
 *
 * Uses a real registry/coordinator backed by a fake BashOperations so the
 * tool's interaction with the cohort is exercised end-to-end without a
 * real shell and with deterministic timing (fake clocks drive the 300s
 * default and the 600s cap exactly).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createFakeOps, type FakeOps } from "./__mocks__/fake-bash-ops.js"
import { createBashControlToolDefinition } from "./bash-control-tool.js"
import { createProcessRegistry, type ProcessRegistry } from "./process-registry.js"
import { createReviewCoordinator, type ReviewCoordinator } from "./review-coordinator.js"
import type { BashSessionState } from "./session-registry.js"

// ─── Helpers ──────────────────────────────────────────────────────────────────

let ops: FakeOps
let registry: ProcessRegistry
let coordinator: ReviewCoordinator
let state: BashSessionState

beforeEach(() => {
	vi.useFakeTimers()
	ops = createFakeOps()
	registry = createProcessRegistry()
	coordinator = createReviewCoordinator({ registry, handoffSeconds: 1 })
	state = { registry, coordinator, limitSeconds: 3600 }
})

afterEach(async () => {
	vi.useRealTimers()
	await registry.shutdown()
})

function setup() {
	const tool = createBashControlToolDefinition(() => state)
	return { tool }
}

function spawnRunning(command = "long-running"): string {
	const handle = registry.spawn(ops, command, "/test/cwd", undefined, { limitSeconds: 3600 })
	coordinator.handleSpawned(handle)
	return handle
}

async function callExecute(
	tool: ReturnType<typeof createBashControlToolDefinition>,
	params: Record<string, unknown>,
	signal?: AbortSignal,
) {
	return tool.execute("call-1", params as never, signal, undefined, undefined as never)
}

function textOf(result: { content: { type: string; text?: string }[] }): string {
	return result.content.map((b) => b.text ?? "").join("\n")
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("createBashControlToolDefinition — shape", () => {
	it("schema exposes stop_handles + wait + waitSeconds; legacy timing fields are deprecated", () => {
		const { tool } = setup()
		expect(tool.name).toBe("bash_control")
		const schema = tool.parameters as unknown as { properties: Record<string, { description?: string }> }
		expect(schema.properties).toHaveProperty("stop_handles")
		expect(schema.properties).toHaveProperty("wait")
		expect(schema.properties.waitSeconds?.description).toContain("300")
		expect(schema.properties.waitSeconds?.description).toContain("600")
		expect(schema.properties.extend_seconds?.description).toBeUndefined()
		expect(schema.properties.checkin_interval?.description).toBeUndefined()
	})

	it("wait: true is required in the schema (no silent omission)", () => {
		const { tool } = setup()
		const schema = tool.parameters as unknown as { required?: string[] }
		expect(schema.required).toContain("wait")
	})

	it("description documents inspection, bounded waits, and checkpoints", () => {
		const { tool } = setup()
		expect(tool.description).toContain("wait: false")
		expect(tool.description).toContain("wait: true")
		expect(tool.description).toContain("checkpoint")
		expect(tool.description).not.toContain("no-op")
	})
})

describe("bash_control — duration validation", () => {
	it("rejects waitSeconds with wait: false before applying any stop", async () => {
		const { tool } = setup()
		const victim = spawnRunning("victim")
		const result = await callExecute(tool, { wait: false, waitSeconds: 30, stop_handles: [victim] })
		expect(result.details.reason).toBe("invalid-params")
		expect(textOf(result)).toContain("waitSeconds applies only to wait: true")
		// No mutation: the victim survives untouched.
		expect(registry.getEntry(victim)?.state).toBe("running")
	})

	it("rejects waitSeconds with wait: false even when the value is not a number", async () => {
		const { tool } = setup()
		const victim = spawnRunning("victim")
		const result = await callExecute(tool, { wait: false, waitSeconds: true, stop_handles: [victim] })
		expect(result.details.reason).toBe("invalid-params")
		expect(textOf(result)).toContain("waitSeconds applies only to wait: true")
		// No mutation: a boolean duration must not silently degrade to
		// "omitted" and let the stop through.
		expect(registry.getEntry(victim)?.state).toBe("running")
		expect(coordinator.handles()).toContain(victim)
	})

	it("rejects a null waitSeconds with wait: false before applying stops", async () => {
		const { tool } = setup()
		const victim = spawnRunning("victim")
		const result = await callExecute(tool, { wait: false, waitSeconds: null, stop_handles: [victim] })
		expect(result.details.reason).toBe("invalid-params")
		expect(textOf(result)).toContain("waitSeconds applies only to wait: true")
		// `null` is a supplied invalid value, not an omitted field: no stop.
		expect(registry.getEntry(victim)?.state).toBe("running")
		expect(coordinator.handles()).toContain(victim)
	})

	it("rejects non-positive and non-finite durations without mutations", async () => {
		const { tool } = setup()
		for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
			const handle = spawnRunning("survivor")
			const result = await callExecute(tool, { wait: true, waitSeconds: bad })
			expect(result.details.reason).toBe("invalid-params")
			expect(textOf(result)).toContain("finite positive")
			expect(registry.getEntry(handle)?.state).toBe("running")
			expect(coordinator.handles()).toContain(handle)
		}
	})

	it("rejects non-number waitSeconds shapes without mutations", async () => {
		const { tool } = setup()
		for (const bad of [true, false, "soon", { seconds: 5 }, [300]]) {
			const handle = spawnRunning("survivor")
			const result = await callExecute(tool, { wait: true, waitSeconds: bad })
			expect(result.details.reason).toBe("invalid-params")
			expect(textOf(result)).toContain("finite positive number")
			expect(registry.getEntry(handle)?.state).toBe("running")
			expect(coordinator.handles()).toContain(handle)
		}
	})

	it("rejects a null waitSeconds with wait: true instead of treating it as omitted", async () => {
		const { tool } = setup()
		const handle = spawnRunning("null-duration")
		const result = await callExecute(tool, { wait: true, waitSeconds: null })
		expect(result.details.reason).toBe("invalid-params")
		expect(textOf(result)).toContain("finite positive number")
		// No timer armed, no mutation.
		expect(registry.getEntry(handle)?.state).toBe("running")
	})

	it("rejects a non-number waitSeconds from an unvalidated direct call", async () => {
		const { tool } = setup()
		spawnRunning("survivor")
		const result = await callExecute(tool, { wait: true, waitSeconds: "soon" })
		expect(result.details.reason).toBe("invalid-params")
	})

	it("schedules fractional durations exactly instead of flooring to a second", async () => {
		const { tool } = setup()
		const handle = spawnRunning("quick-checkpoint")
		const execPromise = callExecute(tool, { wait: true, waitSeconds: 0.1 })
		await Promise.resolve()
		await vi.advanceTimersByTimeAsync(100)
		const result = await execPromise
		expect(result.details.event).toBe("checkpoint")
		// The requested duration is honored exactly — reported as 0.1s, not
		// floored to 1s.
		expect(result.details.effectiveWaitSeconds).toBe(0.1)
		expect(coordinator.getCheckpointStreak(handle)).toBe(1)
	})

	it("caps a duration above 600s at 600s instead of rejecting it", async () => {
		const { tool } = setup()
		const handle = spawnRunning("capped")
		const execPromise = callExecute(tool, { wait: true, waitSeconds: 5000 })
		await Promise.resolve()
		let settled = false
		void execPromise.then(() => {
			settled = true
		})
		await vi.advanceTimersByTimeAsync(599_000)
		await vi.advanceTimersByTimeAsync(0)
		expect(settled).toBe(false)
		await vi.advanceTimersByTimeAsync(1_000)
		const result = await execPromise
		expect(result.details.event).toBe("checkpoint")
		expect(result.details.effectiveWaitSeconds).toBe(600)
		expect(result.details.waitedSeconds).toBe(600)
		await registry.remove(handle).catch(() => {})
	})

	it("reports the requested duration when it is within the cap", async () => {
		const { tool } = setup()
		const handle = spawnRunning("short-wait")
		const execPromise = callExecute(tool, { wait: true, waitSeconds: 10 })
		await Promise.resolve()
		await vi.advanceTimersByTimeAsync(10_000)
		const result = await execPromise
		expect(result.details.effectiveWaitSeconds).toBe(10)
		await registry.remove(handle).catch(() => {})
	})
})

describe("bash_control — immediate inspection (wait: false)", () => {
	it("returns a consolidated snapshot without stopping anything", async () => {
		const { tool } = setup()
		const a = spawnRunning("alpha")
		const b = spawnRunning("beta")
		ops.emitMatching("alpha", "progress\n")

		const result = await callExecute(tool, { wait: false })
		const text = textOf(result)
		expect(result.details.event).toBe("inspection")
		expect(text).toContain("Inspection of 2 background bash processes")
		expect(text).toContain(`${a}: alpha`)
		expect(text).toContain(`${b}: beta`)
		expect(text).toContain("Running: 0s")
		expect(text).toContain("Last output: no output yet")
		expect(text).toContain("Consecutive wait checkpoints: 0")
		expect(text).toContain("Safety budget remaining: 3600s")
		expect(text).toContain("progress")
		expect(result.details.runningHandles).toEqual(expect.arrayContaining([a, b]))
		expect(registry.getEntry(a)?.state).toBe("running")
		expect(registry.getEntry(b)?.state).toBe("running")
		expect(ops.aborted).toBe(false)
	})

	it("delivers available terminal results in the inspection sweep", async () => {
		const { tool } = setup()
		const dead = spawnRunning("goner")
		const alive = spawnRunning("stayer")
		ops.emitMatching("goner", "final words\n")
		await ops.exitMatching("goner", 3)
		await vi.advanceTimersByTimeAsync(0)

		const result = await callExecute(tool, { wait: false })
		const text = textOf(result)
		expect(text).toContain(` handle: ${dead}`)
		expect(text).toContain("exit code 3")
		expect(text).toContain("final words")
		expect(result.details.exitedHandles).toEqual([dead])
		expect(result.details.event).toBe("inspection")
		expect(registry.getEntry(dead)).toBeUndefined()
		expect(registry.getEntry(alive)?.state).toBe("running")
	})

	it("returns 'No background processes remain' for an empty cohort", async () => {
		const { tool } = setup()
		const result = await callExecute(tool, { wait: false })
		expect(textOf(result)).toContain("No background processes remain")
		expect(result.details.event).toBe("inspection")
	})

	it("preserves the genuine no-session-state error", async () => {
		const tool = createBashControlToolDefinition(() => undefined)
		const result = await callExecute(tool, { wait: false })
		expect(result.details.reason).toBe("no-registry")
	})

	it("resets the checkpoint streak of the running processes it reports", async () => {
		const { tool } = setup()
		const handle = spawnRunning("streaky")
		// Simulate two prior timeout checkpoints.
		coordinator.commitWaitTimeout([handle])
		coordinator.commitWaitTimeout([handle])
		expect(coordinator.getCheckpointStreak(handle)).toBe(2)

		const result = await callExecute(tool, { wait: false })
		// The response reports the streak AT inspection time...
		expect(textOf(result)).toContain("Consecutive wait checkpoints: 2")
		// ...and the inspection resets it.
		expect(coordinator.getCheckpointStreak(handle)).toBe(0)
	})

	it("legacy handle/action payloads degrade to an inspection (not translated)", async () => {
		const { tool } = setup()
		spawnRunning("legacy")
		const result = await callExecute(tool, { handle: "legacy", action: "stop" })
		expect(result.details.reason).toBeUndefined()
		expect(result.details.event).toBe("inspection")
		expect(textOf(result)).toContain("Inspection of 1 background bash process")
		expect(registry.getEntry(coordinator.handles()[0] ?? "")?.state).toBe("running")
	})

	it("advances delivered cursors only for included output", async () => {
		const { tool } = setup()
		const handle = spawnRunning("cursored")
		ops.emitMatching("cursored", "first\n")
		await callExecute(tool, { wait: false })
		expect(registry.snapshotSince(handle).newBytes).toBe(0)
	})
})

describe("bash_control — stop_handles", () => {
	it("stops one handle and returns its final result; unlisted handles keep running", async () => {
		const { tool } = setup()
		const victim = spawnRunning("victim")
		const survivor = spawnRunning("survivor")
		ops.emitMatching("victim", "victim output\n")

		const result = await callExecute(tool, { stop_handles: [victim] })
		const text = textOf(result)
		expect(text).toContain(` handle: ${victim}`)
		expect(text).toContain("stopped on request")
		expect(text).toContain("victim output")
		expect(result.details.exitedHandles).toEqual([victim])

		expect(registry.getEntry(victim)).toBeUndefined()
		expect(registry.getEntry(survivor)?.state).toBe("running")
		expect(coordinator.handles()).toEqual([survivor])
	})

	it("deduplicates stop_handles while preserving first-occurrence order", async () => {
		const { tool } = setup()
		const a = spawnRunning("a")
		const b = spawnRunning("b")
		const result = await callExecute(tool, { stop_handles: [a, b, a] })
		const text = textOf(result)
		// a is stopped exactly once.
		expect(text.split(` handle: ${a}`).length - 1).toBe(1)
		expect(result.details.exitedHandles).toEqual([a, b])
		expect(registry.getEntry(a)).toBeUndefined()
		expect(registry.getEntry(b)).toBeUndefined()
	})

	it("stops several handles in one call with per-process results", async () => {
		const { tool } = setup()
		const a = spawnRunning("a")
		const b = spawnRunning("b")
		const c = spawnRunning("c")
		const result = await callExecute(tool, { stop_handles: [a, c] })
		const text = textOf(result)
		expect(text).toContain(` handle: ${a}`)
		expect(text).toContain(` handle: ${c}`)
		expect(text).not.toContain(` handle: ${b}`)
		expect(result.details.exitedHandles?.sort()).toEqual([a, c].sort())
		expect(registry.getEntry(b)?.state).toBe("running")
	})

	it("releases the terminal claim when collection fails, preserving fallback delivery", async () => {
		const victim = spawnRunning("victim")
		ops.emitMatching("victim", "victim output\n")
		// A one-time collection failure: the stop call errors out mid-snapshot.
		const failingState: BashSessionState = {
			...state,
			registry: {
				...registry,
				finalSnapshot: () => {
					throw new Error("snapshot boom")
				},
			},
		}
		const failingTool = createBashControlToolDefinition(() => failingState)
		await expect(callExecute(failingTool, { stop_handles: [victim], wait: false })).rejects.toThrow("snapshot boom")
		// The claim was released (not left locked): the entry remains in the
		// registry AND any collector — a later call or the extension's
		// fallback — can acquire it.
		expect(registry.getEntry(victim)).toBeDefined()
		expect(registry.claimTerminal(victim)).toBe(true)
		registry.releaseTerminal(victim)
		// A later call with the real registry delivers the terminal result.
		const { tool } = setup()
		const result = await callExecute(tool, { stop_handles: [victim], wait: false })
		expect(result.details.exitedHandles).toEqual([victim])
		expect(textOf(result)).toContain("victim output")
	})

	it("two parallel stop calls deliver the same terminal result exactly once", async () => {
		const { tool } = setup()
		const victim = spawnRunning("victim")
		ops.emitMatching("victim", "shared output\n")
		// Both calls race for the same handle: the collection claim is
		// atomic, so exactly one delivers the terminal result.
		const first = tool.execute(
			"call-a",
			{ stop_handles: [victim], wait: false } as never,
			undefined,
			undefined,
			undefined as never,
		)
		const second = tool.execute(
			"call-b",
			{ stop_handles: [victim], wait: false } as never,
			undefined,
			undefined,
			undefined as never,
		)
		const [a, b] = await Promise.all([first, second])
		const deliveries = [a, b].filter((r) => r.details.exitedHandles?.includes(victim))
		expect(deliveries).toHaveLength(1)
		const texts = `${textOf(a)}\n${textOf(b)}`
		// The output body appears exactly once across both responses.
		expect(texts.split("shared output").length - 1).toBe(1)
		expect(registry.getEntry(victim)).toBeUndefined()
		// The losing call reports the concurrent claim instead of duplicating.
		expect(texts).toContain("already being resolved by another call")
	})

	it("reports unknown handles individually without losing valid actions", async () => {
		const { tool } = setup()
		const real = spawnRunning("real")
		const result = await callExecute(tool, { stop_handles: ["bogus", real] })
		const text = textOf(result)
		expect(text).toContain("Unknown handle 'bogus'")
		expect(text).toContain(` handle: ${real}`)
		expect(registry.getEntry(real)).toBeUndefined()
	})

	it("legacy timing fields are accepted but ignored (no translation)", async () => {
		const { tool } = setup()
		const handle = spawnRunning("legacy")
		const result = await callExecute(tool, {
			stop_handles: [handle],
			wait: false,
			extend_seconds: 30,
			checkin_interval: 5,
		})
		expect(textOf(result)).toContain(` handle: ${handle}`)
		expect(result.details.exitedHandles).toEqual([handle])
	})

	it("stop-only calls include the inspection snapshot of survivors", async () => {
		const { tool } = setup()
		const victim = spawnRunning("victim")
		const stayer = spawnRunning("stayer")
		const result = await callExecute(tool, { stop_handles: [victim], wait: false })
		const text = textOf(result)
		expect(text).toContain(` handle: ${victim}`)
		expect(text).toContain(`${stayer}: stayer`)
		expect(result.details.event).toBe("inspection")
		expect(result.details.runningHandles).toEqual([stayer])
	})
})

describe("bash_control — wait", () => {
	it("resolves on the first cohort exit with the terminal result and other statuses", async () => {
		const { tool } = setup()
		const exiting = spawnRunning("exiting")
		const staying = spawnRunning("staying")
		await vi.advanceTimersByTimeAsync(1000) // past the handoff

		const execPromise = callExecute(tool, { wait: true })
		await Promise.resolve()
		ops.emitMatching("exiting", "final words\n")
		await ops.exitMatching("exiting", 0)
		const result = await execPromise

		const text = textOf(result)
		expect(result.details.event).toBe("exit")
		expect(text).toContain(` handle: ${exiting}`)
		expect(text).toContain("exited (exit code 0)")
		expect(text).toContain("final words")
		expect(text).toContain("Still running (1):")
		expect(text).toContain(`${staying}: staying`)
		expect(result.details.exitedHandles).toEqual([exiting])
		expect(result.details.runningHandles).toContain(staying)
		expect(registry.getEntry(exiting)).toBeUndefined()
	})

	it("measures actual wait elapsed time, not the requested duration", async () => {
		const { tool } = setup()
		spawnRunning("early-exit")
		const execPromise = callExecute(tool, { wait: true }) // 300s default
		await Promise.resolve()
		// Exit after 17s of the 300s request.
		await vi.advanceTimersByTimeAsync(17_000)
		await ops.exitMatching("early-exit", 0)
		const result = await execPromise
		expect(result.details.effectiveWaitSeconds).toBe(300)
		expect(result.details.waitedSeconds).toBe(17)
		expect(result.details.event).toBe("exit")
	})

	it("resolves at the 300s default checkpoint with consolidated evidence", async () => {
		const { tool } = setup()
		const a = spawnRunning("alpha")
		const b = spawnRunning("beta")
		await vi.advanceTimersByTimeAsync(1000)
		ops.emitMatching("alpha", "progress-a\n")
		// Mark a's prior output delivered to prove incremental behavior.
		const markA = registry.snapshotSince(a)
		registry.markDelivered(a, markA.nextCursor)

		const execPromise = callExecute(tool, { wait: true })
		await Promise.resolve()
		ops.emitMatching("alpha", "new-a\n")
		await vi.advanceTimersByTimeAsync(300_000)
		const result = await execPromise

		const text = textOf(result)
		expect(result.details.event).toBe("checkpoint")
		expect(result.details.effectiveWaitSeconds).toBe(300)
		expect(result.details.waitedSeconds).toBe(300)
		expect(text).toContain("Wait checkpoint: requested 300s, waited 300s.")
		// a: only the new output is re-sent (incremental).
		expect(text).toContain("new-a")
		expect(text).not.toContain("progress-a")
		// b: silent process reported factually, never as "no progress".
		expect(text).toContain(`${b}: beta`)
		expect(text).toContain("No new output")
		expect(text).not.toContain("no progress")
		// Evidence lines and reassessment guidance.
		expect(text).toContain("Consecutive wait checkpoints: 1")
		expect(text).toContain("Safety budget remaining: 3299s")
		expect(text).toContain("Reassess the runtime against the expected duration")
	})

	it("increments the streak on a checkpoint and resets it on an exit response", async () => {
		const { tool } = setup()
		const handle = spawnRunning("streaky")
		await vi.advanceTimersByTimeAsync(1000)

		// Checkpoint 1.
		let execPromise = callExecute(tool, { wait: true, waitSeconds: 10 })
		await Promise.resolve()
		await vi.advanceTimersByTimeAsync(10_000)
		await execPromise
		expect(coordinator.getCheckpointStreak(handle)).toBe(1)

		// Checkpoint 2.
		execPromise = callExecute(tool, { wait: true, waitSeconds: 10 })
		await Promise.resolve()
		await vi.advanceTimersByTimeAsync(10_000)
		const cp2 = await execPromise
		expect(textOf(cp2)).toContain("Consecutive wait checkpoints: 2")
		expect(coordinator.getCheckpointStreak(handle)).toBe(2)

		// An exit response resets the streak of the running handles it
		// reports — here the process itself exits, so its history is gone.
		execPromise = callExecute(tool, { wait: true, waitSeconds: 10 })
		await Promise.resolve()
		await ops.exitMatching("streaky", 0)
		await execPromise
		expect(coordinator.getCheckpointStreak(handle)).toBe(0)
	})

	it("a joiner during a wait does not inherit the older process's streak", async () => {
		const { tool } = setup()
		const old1 = spawnRunning("old-one")
		await vi.advanceTimersByTimeAsync(1000)
		// One checkpoint for old-one.
		let execPromise = callExecute(tool, { wait: true, waitSeconds: 10 })
		await Promise.resolve()
		await vi.advanceTimersByTimeAsync(10_000)
		await execPromise
		expect(coordinator.getCheckpointStreak(old1)).toBe(1)

		// A joiner arrives, then the wait times out again: the joiner starts
		// from its own zero count; old-one's streak grows to 2.
		const joiner = spawnRunning("joiner")
		execPromise = callExecute(tool, { wait: true, waitSeconds: 10 })
		await Promise.resolve()
		await vi.advanceTimersByTimeAsync(10_000)
		const result = await execPromise
		expect(coordinator.getCheckpointStreak(joiner)).toBe(1)
		expect(coordinator.getCheckpointStreak(old1)).toBe(2)
		expect(textOf(result)).toContain(`${joiner}: joiner`)
	})

	it("an exit landing before the timer fires is delivered as terminal output, not still running", async () => {
		const { tool } = setup()
		const racer = spawnRunning("racer")
		const execPromise = callExecute(tool, { wait: true, waitSeconds: 10 })
		await Promise.resolve()
		// The exit lands at 9.5s — before the 10s checkpoint fires.
		await vi.advanceTimersByTimeAsync(9_500)
		await ops.exitMatching("racer", 0)
		await vi.advanceTimersByTimeAsync(500)
		const result = await execPromise
		expect(textOf(result)).toContain(` handle: ${racer}`)
		expect(textOf(result)).toContain("exited (exit code 0)")
		expect(result.details.event).toBe("exit")
		expect(result.details.runningHandles).toEqual([])
		expect(registry.getEntry(racer)).toBeUndefined()
	})

	it("an exit landing after checkpoint settlement is not lost by the response", async () => {
		const { tool } = setup()
		const racer = spawnRunning("racer")
		const execPromise = callExecute(tool, { wait: true, waitSeconds: 10 })
		await Promise.resolve()
		// The checkpoint fires first; the exit lands after settlement but
		// before the tool result would be consumed. The response reports the
		// process as it was at build time (a checkpoint with the process
		// running); the later exit stays in the registry for the extension's
		// unattended-exit delivery — it must not be silently dropped.
		await vi.advanceTimersByTimeAsync(10_000)
		const result = await execPromise
		expect(result.details.event).toBe("checkpoint")
		expect(result.details.runningHandles).toEqual([racer])
		expect(registry.getEntry(racer)).toBeDefined()
		// The exit arrives now: the entry flips terminal but remains
		// uncollected by this response — an exit watcher/next call owns it.
		await ops.exitMatching("racer", 0)
		expect(registry.getEntry(racer)?.state).not.toBe("running")
	})

	it("a checkpoint leaves commands running and does not extend their safety limits", async () => {
		const { tool } = setup()
		const handle = spawnRunning("budgeted")
		const deadlineBefore = registry.getEntry(handle)?.deadlineMs
		const execPromise = callExecute(tool, { wait: true, waitSeconds: 5 })
		await Promise.resolve()
		await vi.advanceTimersByTimeAsync(5_000)
		await execPromise
		expect(registry.getEntry(handle)?.state).toBe("running")
		expect(registry.getEntry(handle)?.deadlineMs).toBe(deadlineBefore)
	})

	it("rejects a second concurrent wait", async () => {
		const { tool } = setup()
		spawnRunning("a")
		const first = tool.execute("call-1", { wait: true } as never, undefined, undefined, undefined as never)
		await Promise.resolve()
		const second = await tool.execute("call-2", { wait: true } as never, undefined, undefined, undefined as never)
		expect(textOf(second)).toContain("already active")
		expect(second.details.reason).toBe("wait-conflict")
		// The first wait still owns the slot and resolves on exit.
		const assertion = expect(first).resolves.toMatchObject({
			details: expect.objectContaining({ exitedHandles: expect.any(Array) }),
		})
		await ops.exitMatching("a", 0)
		await assertion
	})

	it("abort cancels the wait without killing the cohort", async () => {
		const { tool } = setup()
		const handle = spawnRunning("keep-alive")
		const controller = new AbortController()
		const execPromise = callExecute(tool, { wait: true }, controller.signal)
		await Promise.resolve()
		controller.abort()
		const result = await execPromise

		expect(textOf(result)).toContain("Wait cancelled")
		expect(result.details.aborted).toBe(true)
		expect(result.details.event).toBe("aborted")
		expect(registry.getEntry(handle)?.state).toBe("running")
		expect(ops.aborted).toBe(false)
	})

	it("an aborted wait does not increment checkpoint streaks", async () => {
		const { tool } = setup()
		const handle = spawnRunning("streaky")
		const controller = new AbortController()
		const execPromise = callExecute(tool, { wait: true, waitSeconds: 10 }, controller.signal)
		await Promise.resolve()
		controller.abort()
		await execPromise
		expect(coordinator.getCheckpointStreak(handle)).toBe(0)
	})

	it("wait with an empty cohort returns immediately without starting a timer", async () => {
		const { tool } = setup()
		const timersBefore = vi.getTimerCount()
		const result = await callExecute(tool, { wait: true })
		expect(textOf(result)).toContain("nothing to wait for")
		expect(result.details.event).toBe("empty")
		expect(vi.getTimerCount()).toBe(timersBefore)
	})

	it("stops are applied before the wait begins; survivors claimed by the wait", async () => {
		const { tool } = setup()
		const victim = spawnRunning("victim")
		const staying = spawnRunning("staying")
		const execPromise = callExecute(tool, { stop_handles: [victim], wait: true })
		await ops.exitMatching("staying", 0)
		const result = await execPromise
		expect(registry.getEntry(victim)).toBeUndefined()
		expect(result.details.exitedHandles).toEqual(expect.arrayContaining([victim]))
		const text = textOf(result)
		expect(text).toContain(` handle: ${victim}`)
		expect(text).toContain(` handle: ${staying}`)
		// The victim's terminal result appears exactly once (not double-counted
		// by the wait's terminal sweep).
		const occurrences = text.split(` handle: ${victim}`).length - 1
		expect(occurrences).toBe(1)
	})

	it("stop-plus-wait with no survivors returns the stop outcomes immediately", async () => {
		const { tool } = setup()
		const victim = spawnRunning("victim")
		const timersBefore = vi.getTimerCount()
		const result = await callExecute(tool, { stop_handles: [victim], wait: true, waitSeconds: 300 })
		expect(registry.getEntry(victim)).toBeUndefined()
		expect(result.details.exitedHandles).toEqual([victim])
		expect(result.details.event).toBe("exit")
		expect(textOf(result)).toContain("No background processes remain running")
		// No wait timer was armed.
		expect(vi.getTimerCount()).toBe(timersBefore - 1)
	})

	it("stop-plus-wait timing out increments survivor streaks per the wait's settlement", async () => {
		const { tool } = setup()
		const victim = spawnRunning("victim")
		const survivor = spawnRunning("survivor")
		const execPromise = callExecute(tool, { stop_handles: [victim], wait: true, waitSeconds: 10 })
		await Promise.resolve()
		await vi.advanceTimersByTimeAsync(10_000)
		const result = await execPromise
		// The victim was stopped; the wait ended on its checkpoint timer.
		expect(result.details.exitedHandles).toContain(victim)
		expect(result.details.runningHandles).toEqual([survivor])
		expect(result.details.event).toBe("checkpoint")
		expect(textOf(result)).toContain("Wait checkpoint: requested 10s")
		// The survivor's streak INCREMENTED (the event that ended the wait
		// was the checkpoint), not reset by the stop's terminal delivery.
		expect(coordinator.getCheckpointStreak(survivor)).toBe(1)
	})
})
