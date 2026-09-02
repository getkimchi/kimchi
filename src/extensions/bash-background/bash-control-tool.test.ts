/**
 * Unit tests for the `bash_control` companion tool (consolidated cohort
 * control: stop_handles + wait).
 *
 * Uses a real registry/coordinator backed by a fake BashOperations so the
 * tool's interaction with the cohort is exercised end-to-end without a
 * real shell and with deterministic timing.
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
	coordinator = createReviewCoordinator({ registry, handoffSeconds: 1, reviewIntervalSeconds: 60 })
	state = { registry, coordinator, limitSeconds: 600 }
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
	const handle = registry.spawn(ops, command, "/test/cwd", undefined, { limitSeconds: 600 })
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
	it("schema exposes stop_handles + wait; legacy timing fields are deprecated", () => {
		const { tool } = setup()
		expect(tool.name).toBe("bash_control")
		const schema = tool.parameters as unknown as { properties: Record<string, { description?: string }> }
		expect(schema.properties).toHaveProperty("stop_handles")
		expect(schema.properties).toHaveProperty("wait")
		expect(schema.properties.extend_seconds?.description).toBeUndefined()
		expect(schema.properties.checkin_interval?.description).toBeUndefined()
	})

	it("description documents continuation-by-default and batch wait", () => {
		const { tool } = setup()
		expect(tool.description).toContain("stop_handles")
		expect(tool.description).toContain("wait: true")
		expect(tool.description).toContain("no-op")
	})
})

describe("bash_control — stop_handles", () => {
	it("rejects an empty no-op call", async () => {
		const { tool } = setup()
		const result = await callExecute(tool, { wait: false })
		expect(textOf(result)).toContain("Nothing to do")
		expect(result.details.reason).toBe("no-op")
	})

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
		// extend_seconds / checkin_interval are deprecated compatibility
		// inputs: accepted by the schema, never acted on.
		const result = await callExecute(tool, {
			stop_handles: [handle],
			wait: false,
			extend_seconds: 30,
			checkin_interval: 5,
		})
		expect(textOf(result)).toContain(` handle: ${handle}`)
		expect(result.details.exitedHandles).toEqual([handle])
	})

	it("legacy handle/action payloads are NOT translated", async () => {
		const { tool } = setup()
		spawnRunning("legacy")
		// An old-client payload names the process via `handle` with no
		// stop_handles: it is an inert no-op, not an implicit stop.
		const result = await callExecute(tool, { handle: "legacy", action: "stop" })
		expect(textOf(result)).toContain("Nothing to do")
		expect(result.details.reason).toBe("no-op")
	})
})

describe("bash_control — wait", () => {
	it("resolves on the first cohort exit with the terminal result and other statuses", async () => {
		const { tool } = setup()
		const exiting = spawnRunning("exiting")
		const staying = spawnRunning("staying")
		// Drain the pending shared first-handoff so the clock is in review phase.
		await vi.advanceTimersByTimeAsync(1000)

		const execPromise = callExecute(tool, { wait: true })
		await Promise.resolve()
		ops.emitMatching("exiting", "final words\n")
		await ops.exitMatching("exiting", 0)
		const result = await execPromise

		const text = textOf(result)
		expect(text).toContain(` handle: ${exiting}`)
		expect(text).toContain("exited (exit code 0)")
		expect(text).toContain("final words")
		expect(text).toContain(` handle: ${staying}`)
		expect(result.details.exitedHandles).toEqual([exiting])
		expect(result.details.runningHandles).toContain(staying)
		expect(registry.getEntry(exiting)).toBeUndefined()
	})

	it("resolves at the scheduled cohort review with a consolidated snapshot", async () => {
		const { tool } = setup()
		const a = spawnRunning("a")
		const b = spawnRunning("b")
		await vi.advanceTimersByTimeAsync(1000) // shared first handoff (review phase, +60s)
		ops.emitMatching("a", "progress-a\n")
		// Mark a's prior output delivered to prove incremental behavior.
		const markA = registry.snapshotSince(a)
		registry.markDelivered(a, markA.nextCursor)

		const execPromise = callExecute(tool, { wait: true })
		await Promise.resolve()
		ops.emitMatching("a", "new-a\n")
		await vi.advanceTimersByTimeAsync(60_000)
		const result = await execPromise

		const text = textOf(result)
		expect(text).toContain("cohort review")
		// a: only the new output is re-sent (incremental).
		expect(text).toContain("new-a")
		expect(text).not.toContain("progress-a")
		// b: silent process reported factually, never as "no progress".
		expect(text).toContain(` handle: ${b}`)
		expect(text).toContain("no new output observed")
		expect(text).not.toContain("no progress")
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
		expect(registry.getEntry(handle)?.state).toBe("running")
		expect(ops.aborted).toBe(false)
	})

	it("wait: true is required in the schema (no silent omission)", () => {
		const { tool } = setup()
		const schema = tool.parameters as unknown as { required?: string[] }
		expect(schema.required).toContain("wait")
	})

	it("wait with an empty cohort returns immediately", async () => {
		const { tool } = setup()
		spawnRunning("gone")
		await ops.exitMatching("gone", 0)
		await registry.whenExited(coordinator.handles()[0] ?? "")
		for (const h of [...coordinator.handles()]) {
			coordinator.handleRemoved(h)
			await registry.remove(h)
		}
		const result = await callExecute(tool, { wait: true })
		expect(textOf(result)).toContain("nothing to wait for")
	})

	it("stops are applied before the wait begins", async () => {
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
})
