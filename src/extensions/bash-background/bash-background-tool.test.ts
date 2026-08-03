/**
 * Unit tests for the background `bash` tool definition.
 *
 * Uses a fake BashOperations injected via `createBackgroundBashToolDefinition`
 * options so no real shell is spawned. The fake emits output on demand and
 * can be driven to exit or held running so checkin behaviour is asserted
 * deterministically.
 *
 * Design: background mode is ENFORCED when timeout > 5 (or omitted, defaulting
 * to 120s). The agent cannot opt out — long-running commands always go through
 * the background checkin path. Only timeout <= 5 runs synchronously.
 */

import type { BashOperations } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createBackgroundBashToolDefinition } from "./bash-background-tool.js"

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

function makeTool(ops: FakeOps) {
	return createBackgroundBashToolDefinition("/test/cwd", { operations: ops })
}

async function callExecute(
	tool: ReturnType<typeof makeTool>,
	params: { command: string; timeout?: number; checkin_interval?: number },
) {
	const result = await tool.execute("call-1", params as never, undefined, undefined, undefined as never)
	return result
}

afterEach(() => {
	vi.useRealTimers()
})

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("createBackgroundBashToolDefinition — shape", () => {
	it("keeps the tool name as 'bash'", () => {
		const tool = makeTool(createFakeOps())
		expect(tool.name).toBe("bash")
	})

	it("exposes a checkin_interval parameter", () => {
		const tool = makeTool(createFakeOps())
		const schema = tool.parameters as unknown as { properties: Record<string, unknown> }
		expect(schema.properties).toHaveProperty("command")
		expect(schema.properties).toHaveProperty("timeout")
		expect(schema.properties).toHaveProperty("checkin_interval")
	})

	it("description mentions background/checkin behaviour without leaking the threshold", () => {
		const tool = makeTool(createFakeOps())
		expect(tool.description).toContain("background")
		expect(tool.description).toContain("checkin")
		// The threshold (5s) must not appear in the description
		expect(tool.description).not.toContain("timeout > 5")
		expect(tool.description).not.toContain("timeout <= 5")
		expect(tool.description).not.toContain("5 seconds")
	})
})

describe("createBackgroundBashToolDefinition — short-task path (timeout <= 5)", () => {
	it("delegates to upstream execute and returns full output once with no handle", async () => {
		const ops = createFakeOps()
		const tool = makeTool(ops)
		const execPromise = callExecute(tool, { command: "echo hi", timeout: 3 })
		await Promise.resolve()
		ops.emit("hi\n")
		await ops.exit(0)
		const result = await execPromise

		expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("hi") })
		expect(result.details?.handle).toBeUndefined()
		expect(result.details?.checkin).toBeFalsy()
	})

	it("timeout=5 is the boundary — still synchronous", async () => {
		const ops = createFakeOps()
		const tool = makeTool(ops)
		const execPromise = callExecute(tool, { command: "true", timeout: 5 })
		await Promise.resolve()
		await ops.exit(0)
		const result = await execPromise
		expect(ops.lastTimeout).toBe(5)
		expect(result.details?.handle).toBeUndefined()
	})

	it("passes the timeout through to upstream exec", async () => {
		const ops = createFakeOps()
		const tool = makeTool(ops)
		const execPromise = callExecute(tool, { command: "true", timeout: 5 })
		await Promise.resolve()
		await ops.exit(0)
		await execPromise
		expect(ops.lastTimeout).toBe(5)
	})
})

describe("createBackgroundBashToolDefinition — background checkin path (timeout > 5 or omitted)", () => {
	it("resolves at the checkin, not on process exit, with a handle and tail window", async () => {
		vi.useFakeTimers()
		const ops = createFakeOps()
		const tool = makeTool(ops)
		const execPromise = callExecute(tool, { command: "long", timeout: 60, checkin_interval: 1 })
		await Promise.resolve()
		ops.emit("first line\n")
		ops.emit("second line\n")
		await vi.advanceTimersByTimeAsync(1000)
		const result = await execPromise

		const details = result.details
		expect(details?.handle).toEqual(expect.any(String))
		expect(details?.exited).toBe(false)
		expect(details?.checkin).toBe(true)
		expect(result.content[0]?.type).toBe("text")
		expect((result.content[0] as { text: string }).text).toContain("second line")
		expect((result.content[0] as { text: string }).text).toContain("bash_control")
		expect(details?.handle).toEqual(expect.any(String))
		expect((result.content[0] as { text: string }).text).toContain(details?.handle ?? "__no_handle__")

		await ops.exit(0).catch(() => {})
	})

	it("timeout=6 enters background mode (just above threshold)", async () => {
		vi.useFakeTimers()
		const ops = createFakeOps()
		const tool = makeTool(ops)
		const execPromise = callExecute(tool, { command: "long", timeout: 6, checkin_interval: 1 })
		await Promise.resolve()
		ops.emit("x\n")
		await vi.advanceTimersByTimeAsync(1000)
		const result = await execPromise
		expect(result.details?.handle).toEqual(expect.any(String))
		expect(result.details?.checkin).toBe(true)
		await ops.exit(0).catch(() => {})
	})

	it("omitting timeout enters background mode (defaults to 120)", async () => {
		vi.useFakeTimers()
		const ops = createFakeOps()
		const tool = makeTool(ops)
		const execPromise = callExecute(tool, { command: "long", checkin_interval: 1 })
		await Promise.resolve()
		ops.emit("x\n")
		await vi.advanceTimersByTimeAsync(1000)
		const result = await execPromise
		expect(result.details?.handle).toEqual(expect.any(String))
		expect(result.details?.checkin).toBe(true)
		await ops.exit(0).catch(() => {})
	})

	it("uses default 15s interval when checkin_interval is omitted", async () => {
		vi.useFakeTimers()
		const ops = createFakeOps()
		const tool = makeTool(ops)
		const execPromise = callExecute(tool, { command: "long", timeout: 60 })
		await Promise.resolve()
		ops.emit("tick\n")
		const peek = vi.advanceTimersByTimeAsync(5000)
		let resolved = false
		execPromise.then(() => {
			resolved = true
		})
		await peek
		expect(resolved).toBe(false)
		await vi.advanceTimersByTimeAsync(11000)
		const result = await execPromise
		expect(result.details?.handle).toEqual(expect.any(String))
		expect(result.details?.checkin).toBe(true)
		await ops.exit(0).catch(() => {})
	})

	it("uses explicit checkin_interval when provided", async () => {
		vi.useFakeTimers()
		const ops = createFakeOps()
		const tool = makeTool(ops)
		const execPromise = callExecute(tool, { command: "long", timeout: 60, checkin_interval: 2 })
		await Promise.resolve()
		ops.emit("a\n")
		await vi.advanceTimersByTimeAsync(2000)
		const result = await execPromise
		expect(result.details?.checkin).toBe(true)
		await ops.exit(0).catch(() => {})
	})

	it("background mode does not pass an upstream timeout to ops.exec", async () => {
		vi.useFakeTimers()
		const ops = createFakeOps()
		const tool = makeTool(ops)
		const execPromise = callExecute(tool, { command: "long", timeout: 60, checkin_interval: 1 })
		await Promise.resolve()
		await vi.advanceTimersByTimeAsync(1000)
		await execPromise
		expect(ops.lastTimeout).toBeUndefined()
		await ops.exit(0).catch(() => {})
	})

	it("resolves with final output when the process exits before the first checkin", async () => {
		// Use a fake ops that exits immediately (before the checkin timer arms).
		const ops = createFakeOps()
		// Pre-settle the exec promise so the process exits immediately on spawn.
		const tool = makeTool(ops)
		// Start execute, then immediately drive the fake to exit.
		const execPromise = callExecute(tool, { command: "fast-ish", timeout: 60, checkin_interval: 1 })
		await Promise.resolve()
		ops.emit("done output\n")
		await ops.exit(0)
		const result = await execPromise
		// Success exit before first checkin: returns plain output like upstream.
		// No handle, no checkin flag, no status line.
		expect((result.content[0] as { text: string }).text).toContain("done output")
		expect((result.content[0] as { text: string }).text).not.toContain("Process exited")
		expect((result.content[0] as { text: string }).text).not.toContain("bash_control")
		expect(result.details?.handle).toBeUndefined()
		expect(result.details?.checkin).toBeFalsy()
	})
})
