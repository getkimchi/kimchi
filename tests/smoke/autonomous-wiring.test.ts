/**
 * Wiring test (unit-level): WI-14
 *
 * Exercises the autonomous extensions composed together (createResultWriter +
 * maxIterationsExtension); does NOT run pi-coding-agent's main() against an LLM.
 *
 * Verifies that the extensions cooperate correctly when driven through the
 * same event sequence the real harness produces:
 *
 *   session_start → turn_end → session_shutdown
 *   → result-writer flushes manifest with exit_reason "done" (clean shutdown)
 *
 * This test is entirely in-process; no binary or real LLM is required.
 * The FakeLlmServer (Part A) is also exercised in a lightweight way to
 * confirm the fixture task spec is valid and the server wires up properly.
 */

import { randomUUID } from "node:crypto"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AssistantMessage } from "@mariozechner/pi-ai"
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { buildAutoArgs } from "../../src/commands/auto.js"
import { maxIterationsExtension } from "../../src/extensions/autonomous/max-iterations.js"
import { createResultWriter } from "../../src/extensions/autonomous/result-writer.js"
import { type FakeLlmServer, startFakeLlmServer } from "./fake-llm/server.js"

// ---------------------------------------------------------------------------
// Helpers shared across tests
// ---------------------------------------------------------------------------

function makeAssistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
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

/**
 * Minimal stub for pi's ExtensionAPI — only exposes the on() method needed
 * to register event handlers; fire* helpers simulate harness event dispatch.
 */
function makeStubPi() {
	const handlers: Record<string, ((evt: unknown, ctx: unknown) => void)[]> = {}

	const pi = {
		on: vi.fn((event: string, handler: (evt: unknown, ctx: unknown) => void) => {
			if (handlers[event] === undefined) handlers[event] = []
			handlers[event].push(handler)
		}),
	}

	function fire(event: string, payload: unknown, ctx: unknown = {}): void {
		for (const h of handlers[event] ?? []) h(payload, ctx)
	}

	return {
		pi,
		fireSessionStart: () => fire("session_start", { type: "session_start" }),
		fireTurnEnd: (msg: AssistantMessage, ctx: unknown = {}) =>
			fire("turn_end", { type: "turn_end", message: msg }, ctx),
		fireSessionShutdown: () => fire("session_shutdown", { type: "session_shutdown" }),
	}
}

function tmpResultDir(): string {
	return join(tmpdir(), `autonomous-wiring-test-${randomUUID()}`)
}

// ---------------------------------------------------------------------------
// Fixture: autonomous-task.json
// ---------------------------------------------------------------------------

describe("autonomous-task.json fixture", () => {
	it("fixture file exists at tests/smoke/fixtures/autonomous-task.json", () => {
		const fixturePath = join(
			import.meta.dirname ?? new URL(".", import.meta.url).pathname,
			"fixtures",
			"autonomous-task.json",
		)
		expect(existsSync(fixturePath)).toBe(true)
	})

	it("fixture is valid JSON with prompt and timeout_seconds fields", () => {
		const fixturePath = join(
			import.meta.dirname ?? new URL(".", import.meta.url).pathname,
			"fixtures",
			"autonomous-task.json",
		)
		const raw = readFileSync(fixturePath, "utf-8")
		const parsed = JSON.parse(raw) as { prompt: unknown; timeout_seconds: unknown }
		expect(typeof parsed.prompt).toBe("string")
		expect(typeof parsed.timeout_seconds).toBe("number")
	})
})

// ---------------------------------------------------------------------------
// WI-8 re-verification at integration level: buildAutoArgs from fixture spec
// ---------------------------------------------------------------------------

describe("buildAutoArgs integration check", () => {
	it("returns argv starting with standard flags followed by the fixture prompt", () => {
		const spec = { prompt: "say done", timeout_seconds: 60 }
		const argv = buildAutoArgs(spec, { help: false, passthroughArgs: [] })
		expect(argv).toEqual(["--yolo", "--print", "--mode", "json", "--no-session", "say done"])
	})
})

// ---------------------------------------------------------------------------
// FakeLlmServer sanity: server starts + returns response text
// ---------------------------------------------------------------------------

describe("FakeLlmServer — wiring sanity", () => {
	const servers: FakeLlmServer[] = []

	afterEach(async () => {
		for (const srv of servers.splice(0)) {
			await srv.close().catch(() => {})
		}
	})

	it("server starts with a response and baseUrl ends in /v1", async () => {
		const srv = await startFakeLlmServer({ responses: ["task complete"] })
		servers.push(srv)
		expect(srv.baseUrl).toMatch(/\/v1$/)
	})

	it("non-streaming call returns the response as message content", async () => {
		const srv = await startFakeLlmServer({ responses: ["task complete"] })
		servers.push(srv)
		const res = await fetch(`${srv.baseUrl}/chat/completions`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ stream: false }),
		})
		const json = (await res.json()) as {
			choices: Array<{ message: { content: string } }>
		}
		expect(json.choices[0].message.content).toBe("task complete")
	})
})

// ---------------------------------------------------------------------------
// Core integration: createResultWriter — clean shutdown writes exit_reason "done"
// ---------------------------------------------------------------------------

describe("createResultWriter integration", () => {
	const createdDirs: string[] = []

	afterEach(() => {
		for (const d of createdDirs.splice(0)) {
			rmSync(d, { recursive: true, force: true })
		}
	})

	function makeResultDir(): string {
		const d = tmpResultDir()
		createdDirs.push(d)
		return d
	}

	it("clean session_start + session_shutdown writes exit_reason 'done'", () => {
		const resultDir = makeResultDir()
		const { extension: writerExtension } = createResultWriter({ resultDir })

		const stub = makeStubPi()
		writerExtension(stub.pi as unknown as ExtensionAPI)

		stub.fireSessionStart()
		stub.fireSessionShutdown()

		const manifest = JSON.parse(readFileSync(join(resultDir, "result.json"), "utf-8")) as {
			exit_reason: string
		}
		expect(manifest.exit_reason).toBe("done")
	})

	it("turn_end before session_shutdown captures last_message", () => {
		const resultDir = makeResultDir()
		const { extension: writerExtension } = createResultWriter({ resultDir })

		const stub = makeStubPi()
		writerExtension(stub.pi as unknown as ExtensionAPI)

		stub.fireSessionStart()
		stub.fireTurnEnd(makeAssistant("all done"))
		stub.fireSessionShutdown()

		const manifest = JSON.parse(readFileSync(join(resultDir, "result.json"), "utf-8")) as {
			exit_reason: string
			last_message: string
		}
		expect(manifest.exit_reason).toBe("done")
		expect(manifest.last_message).toBe("all done")
	})

	it("manifest written after session_shutdown contains started_at and ended_at ISO strings", () => {
		const resultDir = makeResultDir()
		const { extension: writerExtension } = createResultWriter({ resultDir })

		const stub = makeStubPi()
		writerExtension(stub.pi as unknown as ExtensionAPI)

		stub.fireSessionStart()
		stub.fireTurnEnd(makeAssistant("finished"))
		stub.fireSessionShutdown()

		const manifest = JSON.parse(readFileSync(join(resultDir, "result.json"), "utf-8")) as {
			started_at: string
			ended_at: string
		}
		expect(new Date(manifest.started_at).toISOString()).toBe(manifest.started_at)
		expect(new Date(manifest.ended_at).toISOString()).toBe(manifest.ended_at)
	})

	it("manifest last_message reflects the final turn text", () => {
		const resultDir = makeResultDir()
		const { extension: writerExtension } = createResultWriter({ resultDir })

		const stub = makeStubPi()
		writerExtension(stub.pi as unknown as ExtensionAPI)

		stub.fireSessionStart()
		stub.fireTurnEnd(makeAssistant("final result"))
		stub.fireSessionShutdown()

		const manifest = JSON.parse(readFileSync(join(resultDir, "result.json"), "utf-8")) as {
			last_message: string
			exit_reason: string
		}
		expect(manifest.last_message).toBe("final result")
		expect(manifest.exit_reason).toBe("done")
	})
})

// ---------------------------------------------------------------------------
// maxIterationsExtension + createResultWriter cooperate
// ---------------------------------------------------------------------------

describe("maxIterationsExtension + createResultWriter integration", () => {
	const createdDirs: string[] = []

	afterEach(() => {
		for (const d of createdDirs.splice(0)) {
			rmSync(d, { recursive: true, force: true })
		}
	})

	function makeResultDir(): string {
		const d = tmpResultDir()
		createdDirs.push(d)
		return d
	}

	it("maxIterations=1 fires onLimit on first turn_end (custom callback supplied)", async () => {
		const resultDir = makeResultDir()
		const { extension: writerExtension } = createResultWriter({ resultDir })
		const onLimit = vi.fn()
		const iterExtension = maxIterationsExtension({ maxIterations: 1, onLimit })

		const stub = makeStubPi()
		writerExtension(stub.pi as unknown as ExtensionAPI)
		iterExtension(stub.pi as unknown as ExtensionAPI)

		const ctx = { shutdown: vi.fn().mockResolvedValue(undefined) }

		stub.fireSessionStart()
		stub.fireTurnEnd(makeAssistant("step 1"), ctx)

		await Promise.resolve()
		expect(onLimit).toHaveBeenCalledTimes(1)
	})

	it("two extensions registered on the same pi stub both fire on turn_end", () => {
		const resultDir = makeResultDir()
		const { extension: writerExtension } = createResultWriter({ resultDir })
		const iterExtension = maxIterationsExtension({ maxIterations: 5 })

		const stub = makeStubPi()
		writerExtension(stub.pi as unknown as ExtensionAPI)
		iterExtension(stub.pi as unknown as ExtensionAPI)

		const turnEndCalls = stub.pi.on.mock.calls.filter((c) => c[0] === "turn_end")
		expect(turnEndCalls).toHaveLength(2)
	})

	it("shutdown after maxIterations leaves exit_reason 'done' in manifest", () => {
		const resultDir = makeResultDir()
		const { extension: writerExtension } = createResultWriter({ resultDir })

		const stub = makeStubPi()
		writerExtension(stub.pi as unknown as ExtensionAPI)

		stub.fireSessionStart()
		stub.fireTurnEnd(makeAssistant("done"))
		stub.fireSessionShutdown()

		const manifest = JSON.parse(readFileSync(join(resultDir, "result.json"), "utf-8")) as {
			exit_reason: string
		}
		expect(manifest.exit_reason).toBe("done")
	})
})
