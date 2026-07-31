/**
 * Unit tests for the `bash_control` companion tool.
 *
 * Uses a real `ProcessRegistry` backed by a fake `BashOperations` so the
 * tool's interaction with the registry (spawn/extend/kill/snapshot) is
 * exercised end-to-end without a real shell.
 */

import type { BashOperations } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createBashControlToolDefinition } from "./bash-control-tool.js"
import { createProcessRegistry } from "./process-registry.js"

// ─── Fake BashOperations ─────────────────────────────────────────────────────

interface FakeOps extends BashOperations {
	lastTimeout: number | undefined
	lastSignal: AbortSignal | undefined
	exit(code: number | null): Promise<void>
	emit(data: Buffer | string): void
}

function createFakeOps(): FakeOps {
	let onData: (data: Buffer) => void = () => {}
	let settle: (r: { exitCode: number | null }) => void
	let rejectExec: (err: Error) => void
	const promise = new Promise<{ exitCode: number | null }>((resolve, reject) => {
		settle = resolve
		rejectExec = reject
	})
	const ops: FakeOps = {
		lastTimeout: undefined,
		lastSignal: undefined,
		async exit(code) {
			settle({ exitCode: code })
			await promise
		},
		emit(data) {
			onData(typeof data === "string" ? Buffer.from(data) : data)
		},
		exec: async (_command, _cwd, opts) => {
			ops.lastTimeout = opts.timeout
			ops.lastSignal = opts.signal
			onData = opts.onData
			if (opts.signal) {
				opts.signal.addEventListener("abort", () => rejectExec(new Error("aborted")), { once: true })
			}
			return promise
		},
	}
	return ops
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setup() {
	const ops = createFakeOps()
	const registry = createProcessRegistry()
	const tool = createBashControlToolDefinition(() => registry)
	// Spawn a background process that stays running until the test drives it.
	const handle = registry.spawn(ops, "long-running", "/test/cwd", undefined, {
		intervalSeconds: 1,
		deadlineMs: Date.now() + 120_000,
	})
	return { ops, registry, tool, handle }
}

async function callExecute(
	tool: ReturnType<typeof createBashControlToolDefinition>,
	params: { handle: string; action: "continue" | "stop"; extend_seconds?: number },
) {
	const result = await tool.execute("call-1", params as never, undefined, undefined, undefined as never)
	return result
}

afterEach(() => {
	vi.useRealTimers()
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("createBashControlToolDefinition — shape", () => {
	it("is named 'bash_control'", () => {
		const tool = createBashControlToolDefinition(() => undefined)
		expect(tool.name).toBe("bash_control")
	})

	it("schema has handle, action (continue|stop), optional extend_seconds", () => {
		const tool = createBashControlToolDefinition(() => undefined)
		const schema = tool.parameters as unknown as { properties: Record<string, unknown> }
		expect(schema.properties).toHaveProperty("handle")
		expect(schema.properties).toHaveProperty("action")
		expect(schema.properties).toHaveProperty("extend_seconds")
	})

	it("description mentions continue/stop", () => {
		const tool = createBashControlToolDefinition(() => undefined)
		expect(tool.description).toContain("continue")
		expect(tool.description).toContain("stop")
	})
})

describe("bash_control — action 'continue'", () => {
	it("re-arms the next checkin and returns tail output + handle", async () => {
		vi.useFakeTimers()
		const { ops, tool, handle } = setup()
		ops.emit("first output\n")
		// Continue blocks until the next checkin (1s interval).
		const execPromise = callExecute(tool, { handle, action: "continue" })
		ops.emit("second output\n")
		await vi.advanceTimersByTimeAsync(1000)
		const result = await execPromise

		expect(result.details.handle).toBe(handle)
		expect(result.details.exited).toBe(false)
		expect(result.details.action).toBe("continue")
		expect((result.content[0] as { text: string }).text).toContain("second output")
		expect((result.content[0] as { text: string }).text).toContain("bash_control")
		// Cleanup
		await ops.exit(0).catch(() => {})
	})

	it("extend_seconds pushes the deadline out before re-arming", async () => {
		vi.useFakeTimers()
		const { ops, registry, tool, handle } = setup()
		const before = registry.getEntry(handle)?.deadlineMs
		const execPromise = callExecute(tool, { handle, action: "continue", extend_seconds: 30 })
		await Promise.resolve()
		const after = registry.getEntry(handle)?.deadlineMs
		expect(after).toBe(before !== undefined ? before + 30_000 : undefined)
		ops.emit("extended\n")
		await vi.advanceTimersByTimeAsync(1000)
		const result = await execPromise
		expect(result.details.exited).toBe(false)
		expect((result.content[0] as { text: string }).text).toContain("extended")
		await ops.exit(0).catch(() => {})
	})

	it("returns final output when the process exits before the next checkin", async () => {
		vi.useFakeTimers()
		const { ops, registry, tool, handle } = setup()
		ops.emit("done output\n")
		// Exit the process before calling continue.
		await ops.exit(0)
		await registry.whenExited(handle)
		const result = await callExecute(tool, { handle, action: "continue" })
		expect(result.details.exited).toBe(true)
		expect(result.details.exitCode).toBe(0)
		expect((result.content[0] as { text: string }).text).toContain("done output")
	})

	it("extend_seconds of 0 or omitted keeps the existing deadline", async () => {
		vi.useFakeTimers()
		const { ops, registry, tool, handle } = setup()
		const before = registry.getEntry(handle)?.deadlineMs
		const execPromise = callExecute(tool, { handle, action: "continue", extend_seconds: 0 })
		await Promise.resolve()
		const after = registry.getEntry(handle)?.deadlineMs
		expect(after).toBe(before)
		await vi.advanceTimersByTimeAsync(1000)
		await execPromise
		await ops.exit(0).catch(() => {})
	})
})

describe("bash_control — action 'stop'", () => {
	it("kills the process and returns final tail output + exitCode", async () => {
		const { ops, tool, handle } = setup()
		ops.emit("final output\n")
		const result = await callExecute(tool, { handle, action: "stop" })
		expect(result.details.action).toBe("stop")
		expect(result.details.exited).toBe(true)
		expect(result.details.reason).toBe("stop")
		expect((result.content[0] as { text: string }).text).toContain("final output")
		expect((result.content[0] as { text: string }).text).toContain("Process stopped")
	})

	it("stop on an already-exited process returns final output", async () => {
		const { ops, registry, tool, handle } = setup()
		ops.emit("exited output\n")
		await ops.exit(0)
		await registry.whenExited(handle)
		const result = await callExecute(tool, { handle, action: "stop" })
		expect(result.details.exited).toBe(true)
		expect(result.details.exitCode).toBe(0)
		expect((result.content[0] as { text: string }).text).toContain("exited output")
	})
})

describe("bash_control — error cases", () => {
	it("returns an error when no registry is available", async () => {
		const tool = createBashControlToolDefinition(() => undefined)
		const result = await callExecute(tool, { handle: "h", action: "continue" })
		expect(result.details.exited).toBe(true)
		expect(result.details.reason).toBe("no-registry")
		expect((result.content[0] as { text: string }).text).toContain("no active bash session registry")
	})

	it("returns an error for an unknown handle", async () => {
		const { registry } = setup()
		const tool = createBashControlToolDefinition(() => registry)
		const result = await callExecute(tool, { handle: "nonexistent", action: "continue" })
		expect(result.details.exited).toBe(true)
		expect(result.details.reason).toBe("unknown-handle")
		expect((result.content[0] as { text: string }).text).toContain("unknown handle")
	})
})
