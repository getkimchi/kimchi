/**
 * Unit tests for the background `bash` tool definition.
 *
 * Uses a fake BashOperations injected via `createBackgroundBashToolDefinition`
 * options plus an explicit session state (registry + coordinator with a
 * short handoff) so no real shell is spawned and timing is deterministic.
 *
 * Contract under test: commands always go through the registry; the tool
 * resolves at process exit OR at the one-time initial handoff (≤15s),
 * never on a model-controlled cadence or timeout. Legacy `timeout` /
 * `checkin_interval` input fields are accepted and ignored.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import { createFakeOps, type FakeOps } from "./__mocks__/fake-bash-ops.js"
import { createBackgroundBashToolDefinition } from "./bash-background-tool.js"
import { createProcessRegistry } from "./process-registry.js"
import { createReviewCoordinator } from "./review-coordinator.js"
import type { BashSessionState } from "./session-registry.js"

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeState(handoffSeconds: number): BashSessionState {
	const registry = createProcessRegistry()
	return {
		registry,
		coordinator: createReviewCoordinator({ registry, handoffSeconds, reviewIntervalSeconds: 60 }),
		limitSeconds: 600,
	}
}

function makeTool(ops: FakeOps, state: BashSessionState) {
	return createBackgroundBashToolDefinition("/test/cwd", { operations: ops, state })
}

async function callExecute(
	tool: ReturnType<typeof makeTool>,
	params: { command: string; timeout?: number; checkin_interval?: number },
	signal?: AbortSignal,
) {
	return tool.execute("call-1", params as never, signal, undefined, undefined as never)
}

afterEach(() => {
	vi.useRealTimers()
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("createBackgroundBashToolDefinition — shape", () => {
	it("keeps the tool name as 'bash' and advertises only the command intent", () => {
		const state = makeState(1)
		const tool = makeTool(createFakeOps(), state)
		expect(tool.name).toBe("bash")
		const schema = tool.parameters as unknown as {
			properties: Record<string, { description?: string }>
			required?: string[]
		}
		expect(schema.properties).toHaveProperty("command")
		expect(schema.required).toEqual(["command"])
		// Legacy timing inputs are retained for compatibility but carry no
		// description that would teach the model to use them.
		expect(schema.properties.timeout?.description).toBeUndefined()
		expect(schema.properties.checkin_interval?.description).toBeUndefined()
	})

	it("base description stays timeout-free; the production description is composed by bashBackgroundExtension", () => {
		const state = makeState(1)
		const tool = makeTool(createFakeOps(), state)
		expect(tool.description).toContain("Execute a bash command")
		// The model no longer sets runtime or cadence knobs; the cohort
		// contract itself is the description bashBackgroundExtension
		// registers (see bashToolDescription / index.test.ts).
		expect(tool.description).not.toContain("timeout")
		expect(tool.description).not.toContain("checkin_interval")
	})
})

describe("createBackgroundBashToolDefinition — exit before handoff", () => {
	it("returns the full final output with no live handle", async () => {
		const state = makeState(5)
		const ops = createFakeOps()
		const tool = makeTool(ops, state)
		const execPromise = callExecute(tool, { command: "echo hi" })
		await Promise.resolve()
		ops.emit("hi\n")
		await ops.exit(0)
		const result = await execPromise

		const text = (result.content[0] as { text: string }).text
		expect(text).toContain("hi")
		expect(text).toContain("Process exited")
		expect(text).not.toContain("bash_control")
		expect(result.details?.exited).toBe(true)
		expect(result.details?.exitCode).toBe(0)
		expect(result.details?.handoff).toBeFalsy()
	})

	it("throws on a non-zero exit (upstream error parity)", async () => {
		const state = makeState(5)
		const ops = createFakeOps()
		const tool = makeTool(ops, state)
		const execPromise = callExecute(tool, { command: "false" })
		await Promise.resolve()
		ops.emit("boom\n")
		await ops.exit(3)
		await expect(execPromise).rejects.toThrow("Command exited with code 3")
	})

	it("does not pass an upstream timeout to ops.exec", async () => {
		const state = makeState(5)
		const ops = createFakeOps()
		const tool = makeTool(ops, state)
		const execPromise = callExecute(tool, { command: "true" })
		await Promise.resolve()
		await ops.exit(0)
		await execPromise
		expect(ops.started[0]?.timeout).toBeUndefined()
	})

	it("applies the session safety limit as the absolute deadline", async () => {
		vi.useFakeTimers()
		const state = makeState(60)
		state.limitSeconds = 10
		const ops = createFakeOps()
		const tool = makeTool(ops, state)
		const execPromise = callExecute(tool, { command: "sleep 100" })
		await Promise.resolve()
		const assertion = expect(execPromise).rejects.toThrow("Process killed by the harness safety limit (10s)")
		await vi.advanceTimersByTimeAsync(11_000) // past the 10s limit, before handoff
		await assertion
		expect(ops.aborted).toBe(true)
	})

	it("legacy timeout/checkin_interval fields are accepted and ignored", async () => {
		vi.useFakeTimers()
		const state = makeState(1)
		const ops = createFakeOps()
		const tool = makeTool(ops, state)
		// A legacy payload with an unrealistically small timeout must NOT
		// truncate the command: the harness limit governs, and the process
		// is still alive at the 1s handoff.
		const execPromise = callExecute(tool, { command: "sleep 100", timeout: 1, checkin_interval: 300 })
		await Promise.resolve()
		await vi.advanceTimersByTimeAsync(1000)
		const result = await execPromise
		expect(result.details?.exited).toBe(false)
		expect(result.details?.handoff).toBe(true)
		expect(ops.started[0]?.timeout).toBeUndefined()
		const handle = result.details?.handle ?? ""
		await state.registry.remove(handle)
	})
})

describe("createBackgroundBashToolDefinition — handoff", () => {
	it("returns the handle, facts, and unseen output at the one-time handoff", async () => {
		vi.useFakeTimers()
		const state = makeState(1)
		const ops = createFakeOps()
		const tool = makeTool(ops, state)
		const execPromise = callExecute(tool, { command: "pnpm run   test" })
		await Promise.resolve()
		ops.emit("first line\n")
		ops.emit("second line\n")
		await vi.advanceTimersByTimeAsync(1000)
		const result = await execPromise

		const details = result.details
		expect(details?.handle).toEqual(expect.any(String))
		expect(details?.exited).toBe(false)
		expect(details?.handoff).toBe(true)
		expect(details?.exitCode).toBeNull()
		const text = (result.content[0] as { text: string }).text
		expect(text).toContain("Background bash process")
		expect(text).toContain(` handle: ${details?.handle}`)
		expect(text).toContain(" command: pnpm run test") // summarized whitespace
		expect(text).toContain("first line")
		expect(text).toContain("second line")
		expect(text).toContain("continues by default")

		// The registry entry keeps running and joined the cohort clock.
		const handle = details?.handle ?? ""
		expect(state.registry.getEntry(handle)?.state).toBe("running")
		expect(state.coordinator.handles()).toContain(handle)

		await state.registry.remove(handle)
	})

	it("delivers the handoff output once (cursor advances)", async () => {
		vi.useFakeTimers()
		const state = makeState(1)
		const ops = createFakeOps()
		const tool = makeTool(ops, state)
		const execPromise = callExecute(tool, { command: "seq 2" })
		await Promise.resolve()
		ops.emit("one\n")
		await vi.advanceTimersByTimeAsync(1000)
		const result = await execPromise
		const handle = result.details?.handle ?? ""
		expect(state.registry.snapshotSince(handle).newBytes).toBe(0)

		await state.registry.remove(handle)
	})

	it("abort before the handoff kills the process and throws", async () => {
		vi.useFakeTimers()
		const state = makeState(60)
		const ops = createFakeOps()
		const tool = makeTool(ops, state)
		const controller = new AbortController()
		const execPromise = callExecute(tool, { command: "sleep 100" }, controller.signal)
		await Promise.resolve()
		const assertion = expect(execPromise).rejects.toThrow("Command aborted")
		controller.abort()
		await assertion
		expect(ops.aborted).toBe(true)
		expect(state.coordinator.size).toBe(0)
		expect(state.registry.size).toBe(0)
	})

	it("safety-limit kill before the handoff surfaces the distinct reason", async () => {
		vi.useFakeTimers()
		const state = makeState(60)
		state.limitSeconds = 5
		const ops = createFakeOps()
		const tool = makeTool(ops, state)
		const execPromise = callExecute(tool, { command: "sleep 100" })
		await Promise.resolve()
		const assertion = expect(execPromise).rejects.toThrow(/Process killed by the harness safety limit \(5s\)/)
		await vi.advanceTimersByTimeAsync(6_000)
		await assertion
	})
})
