import { describe, expect, it, vi } from "vitest"
import * as config from "../../config.js"
import bashMaxTimeoutExtension, { bashMaxTimeoutSecondsFor } from "./index.js"

describe("bashMaxTimeoutSecondsFor", () => {
	it("returns the default in seconds when the call has no timeout", () => {
		expect(bashMaxTimeoutSecondsFor({}, 60_000)).toBe(60)
	})

	it("returns the per-call override in seconds when set", () => {
		expect(bashMaxTimeoutSecondsFor({ timeout: 5 }, 60_000)).toBe(5)
	})

	it("rounds the default up to the next whole second", () => {
		expect(bashMaxTimeoutSecondsFor({}, 2_500)).toBe(3)
	})

	it("treats non-positive overrides as missing", () => {
		expect(bashMaxTimeoutSecondsFor({ timeout: 0 }, 60_000)).toBe(60)
		expect(bashMaxTimeoutSecondsFor({ timeout: -3 }, 60_000)).toBe(60)
	})

	it("treats non-numeric overrides as missing", () => {
		expect(bashMaxTimeoutSecondsFor({ timeout: "10" }, 60_000)).toBe(60)
	})

	it("clamps the per-call override to defaultMs * 10", () => {
		// defaultMs = 1000 → cap = 10000ms = 10s
		expect(bashMaxTimeoutSecondsFor({ timeout: 999 }, 1_000)).toBe(10)
	})

	it("never returns less than 1 second", () => {
		expect(bashMaxTimeoutSecondsFor({}, 100)).toBe(1)
	})
})

describe("bashMaxTimeoutExtension handler", () => {
	function makePi(): {
		pi: Parameters<typeof bashMaxTimeoutExtension>[0]
		emit: (event: { toolName: string; input: Record<string, unknown> }) => void
	} {
		let handler: ((event: { toolName: string; input: Record<string, unknown> }) => unknown) | undefined
		const pi = {
			on: (event: string, fn: (e: { toolName: string; input: Record<string, unknown> }) => unknown) => {
				if (event === "tool_call") handler = fn
			},
		}
		return {
			pi: pi as unknown as Parameters<typeof bashMaxTimeoutExtension>[0],
			emit: (event) => {
				if (!handler) throw new Error("tool_call handler was not registered")
				handler(event)
			},
		}
	}

	function mockConfig(bashMaxTimeoutMs: number) {
		return vi.spyOn(config, "loadConfig").mockReturnValue({ bashMaxTimeoutMs } as ReturnType<typeof config.loadConfig>)
	}

	it("injects default timeout for bash when no override is set", () => {
		const spy = mockConfig(2_000)
		const { pi, emit } = makePi()
		bashMaxTimeoutExtension(pi)
		const input: Record<string, unknown> = { command: "sleep 10" }
		emit({ toolName: "bash", input })
		expect(input.timeout).toBe(2)
		spy.mockRestore()
	})

	it("preserves per-call bash timeout when set", () => {
		const spy = mockConfig(2_000)
		const { pi, emit } = makePi()
		bashMaxTimeoutExtension(pi)
		const input: Record<string, unknown> = { command: "sleep 10", timeout: 5 }
		emit({ toolName: "bash", input })
		expect(input.timeout).toBe(5)
		spy.mockRestore()
	})

	it("clamps oversized per-call bash timeout to the cap", () => {
		const spy = mockConfig(1_000) // cap = 10s
		const { pi, emit } = makePi()
		bashMaxTimeoutExtension(pi)
		const input: Record<string, unknown> = { command: "sleep 5", timeout: 999 }
		emit({ toolName: "bash", input })
		expect(input.timeout).toBe(10)
		spy.mockRestore()
	})

	it("matches bash regardless of case", () => {
		const spy = mockConfig(4_000)
		const { pi, emit } = makePi()
		bashMaxTimeoutExtension(pi)
		const input: Record<string, unknown> = { command: "echo hi" }
		emit({ toolName: "BASH", input })
		expect(input.timeout).toBe(4)
		spy.mockRestore()
	})

	it("does not touch non-bash tools", () => {
		const spy = mockConfig(60_000)
		const { pi, emit } = makePi()
		bashMaxTimeoutExtension(pi)
		const input: Record<string, unknown> = { path: "/etc/hosts" }
		emit({ toolName: "read", input })
		expect(input.timeout).toBeUndefined()
		expect(input.timeoutMs).toBeUndefined()
		expect(input.path).toBe("/etc/hosts")
		spy.mockRestore()
	})
})
