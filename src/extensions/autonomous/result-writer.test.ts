import { randomUUID } from "node:crypto"
import { existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AssistantMessage } from "@mariozechner/pi-ai"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { readResult } from "../../autonomous/result.js"
import { createResultWriter } from "./result-writer.js"

function makeAssistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "kimi-k2.5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	}
}

type StubHandler = (evt: unknown, ctx: unknown) => unknown

function makeStubPi() {
	const handlers: Record<string, StubHandler[]> = {}
	return {
		on: vi.fn((event: string, handler: StubHandler) => {
			if (handlers[event] === undefined) handlers[event] = []
			handlers[event].push(handler)
		}),
		fireSessionStart: () => {
			for (const h of handlers.session_start ?? []) h({ type: "session_start" }, {})
		},
		fireTurnEnd: (message: AssistantMessage, ctx: unknown = {}) => {
			for (const h of handlers.turn_end ?? []) h({ type: "turn_end", message }, ctx)
		},
		fireSessionShutdown: () => {
			for (const h of handlers.session_shutdown ?? []) h({ type: "session_shutdown" }, {})
		},
	}
}

const helloMessage = makeAssistant([{ type: "text", text: "hello" }])

describe("createResultWriter", () => {
	const createdDirs: string[] = []

	function tmpDir(): string {
		const dir = join(tmpdir(), `result-writer-test-${randomUUID()}`)
		createdDirs.push(dir)
		return dir
	}

	afterEach(() => {
		for (const d of createdDirs) {
			try {
				rmSync(d, { recursive: true, force: true })
			} catch {
				// ignore
			}
		}
		createdDirs.length = 0
	})

	it("returns an object with extension and control properties of the right shape", () => {
		const { extension, control } = createResultWriter({ resultDir: tmpDir() })

		expect(typeof extension).toBe("function")
		expect(typeof control.markTimeout).toBe("function")
		expect(typeof control.markError).toBe("function")
		expect(typeof control.flush).toBe("function")
	})

	it("registers handlers for session_start, turn_end, and session_shutdown — exactly those three", () => {
		const resultDir = tmpDir()
		const { extension } = createResultWriter({ resultDir })
		const pi = makeStubPi()
		extension(pi as unknown as ExtensionAPI)

		const registeredEvents = pi.on.mock.calls.map((c) => c[0])
		expect(registeredEvents).toContain("session_start")
		expect(registeredEvents).toContain("turn_end")
		expect(registeredEvents).toContain("session_shutdown")
		expect(registeredEvents).toHaveLength(3)
	})

	it("writes result.json with exit_reason 'done' (default) after session_start + session_shutdown", () => {
		const resultDir = tmpDir()
		const { extension } = createResultWriter({ resultDir })
		const pi = makeStubPi()
		extension(pi as unknown as ExtensionAPI)

		pi.fireSessionStart()
		pi.fireSessionShutdown()

		expect(existsSync(join(resultDir, "result.json"))).toBe(true)
		const result = readResult(resultDir)
		expect(result.exit_reason).toBe("done")
	})

	it("writes last_message when turn_end fires before session_shutdown", () => {
		const resultDir = tmpDir()
		const { extension } = createResultWriter({ resultDir })
		const pi = makeStubPi()
		extension(pi as unknown as ExtensionAPI)

		pi.fireSessionStart()
		pi.fireTurnEnd(helloMessage)
		pi.fireSessionShutdown()

		const result = readResult(resultDir)
		expect(result.last_message).toBe("hello")
		expect(result.exit_reason).toBe("done")
	})

	it("last_message reflects the LATEST turn when multiple turn_end events fire", () => {
		const resultDir = tmpDir()
		const { extension } = createResultWriter({ resultDir })
		const pi = makeStubPi()
		extension(pi as unknown as ExtensionAPI)

		const firstMessage = makeAssistant([{ type: "text", text: "first" }])
		const secondMessage = makeAssistant([{ type: "text", text: "second" }])
		const thirdMessage = makeAssistant([{ type: "text", text: "third" }])

		pi.fireSessionStart()
		pi.fireTurnEnd(firstMessage)
		pi.fireTurnEnd(secondMessage)
		pi.fireTurnEnd(thirdMessage)
		pi.fireSessionShutdown()

		const result = readResult(resultDir)
		expect(result.last_message).toBe("third")
	})

	it("control.markTimeout() flushes immediately with exit_reason 'timeout' before session_shutdown fires", () => {
		const resultDir = tmpDir()
		const { extension, control } = createResultWriter({ resultDir })
		const pi = makeStubPi()
		extension(pi as unknown as ExtensionAPI)

		pi.fireSessionStart()
		control.markTimeout()

		expect(existsSync(join(resultDir, "result.json"))).toBe(true)
		const result = readResult(resultDir)
		expect(result.exit_reason).toBe("timeout")
	})

	it("control.markError({message}) flushes immediately with exit_reason 'error' and error.message", () => {
		const resultDir = tmpDir()
		const { extension, control } = createResultWriter({ resultDir })
		const pi = makeStubPi()
		extension(pi as unknown as ExtensionAPI)

		pi.fireSessionStart()
		control.markError({ message: "boom" })

		expect(existsSync(join(resultDir, "result.json"))).toBe(true)
		const result = readResult(resultDir)
		expect(result.exit_reason).toBe("error")
		expect(result.error?.message).toBe("boom")
	})

	it("flush is idempotent — calling markTimeout twice does not throw and ended_at is from the first call", () => {
		const resultDir = tmpDir()
		const { extension, control } = createResultWriter({ resultDir })
		const pi = makeStubPi()
		extension(pi as unknown as ExtensionAPI)

		pi.fireSessionStart()

		control.markTimeout()
		const firstResult = readResult(resultDir)
		const firstEndedAt = firstResult.ended_at

		// small delay to ensure time advances
		const laterDate = new Date(new Date(firstEndedAt).getTime() + 1000).toISOString()
		vi.setSystemTime(new Date(laterDate))

		control.markTimeout()

		const secondResult = readResult(resultDir)
		expect(secondResult.ended_at).toBe(firstEndedAt)

		vi.useRealTimers()
	})

	it("started_at and ended_at are valid ISO strings with ended_at >= started_at", () => {
		const resultDir = tmpDir()
		const { extension } = createResultWriter({ resultDir })
		const pi = makeStubPi()
		extension(pi as unknown as ExtensionAPI)

		pi.fireSessionStart()
		pi.fireSessionShutdown()

		const result = readResult(resultDir)

		expect(new Date(result.started_at).toISOString()).toBe(result.started_at)
		expect(new Date(result.ended_at).toISOString()).toBe(result.ended_at)
		expect(result.ended_at >= result.started_at).toBe(true)
	})

	it("logPath option is passed through to the manifest as log_path", () => {
		const resultDir = tmpDir()
		const logPath = "/workspace/.kimchi/run.log"
		const { extension } = createResultWriter({ resultDir, logPath })
		const pi = makeStubPi()
		extension(pi as unknown as ExtensionAPI)

		pi.fireSessionStart()
		pi.fireSessionShutdown()

		const result = readResult(resultDir)
		expect(result.log_path).toBe(logPath)
	})

	it("flushIfUnflushed is a no-op when already flushed via markTimeout", () => {
		const resultDir = tmpDir()
		const { extension, control } = createResultWriter({ resultDir })
		const pi = makeStubPi()
		extension(pi as unknown as ExtensionAPI)

		pi.fireSessionStart()
		control.markTimeout()

		const firstResult = readResult(resultDir)
		expect(firstResult.exit_reason).toBe("timeout")

		// calling flushIfUnflushed after already flushed should not overwrite
		control.flushIfUnflushed("error")

		const secondResult = readResult(resultDir)
		expect(secondResult.exit_reason).toBe("timeout")
	})

	it("flushIfUnflushed writes the manifest with the given exit_reason when not yet flushed", () => {
		const resultDir = tmpDir()
		const { extension, control } = createResultWriter({ resultDir })
		const pi = makeStubPi()
		extension(pi as unknown as ExtensionAPI)

		pi.fireSessionStart()

		expect(existsSync(join(resultDir, "result.json"))).toBe(false)

		control.flushIfUnflushed("error")

		expect(existsSync(join(resultDir, "result.json"))).toBe(true)
		const result = readResult(resultDir)
		expect(result.exit_reason).toBe("error")
	})
})
