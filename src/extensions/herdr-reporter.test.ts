/**
 * Co-located tests for the herdr reporter extension.
 *
 * The reporter talks to herdr over a Unix domain socket using newline-
 * delimited JSON-RPC. To keep these tests fast and hermetic we mock
 * `node:net` with an in-memory fake socket server. The fake socket is
 * itself an EventEmitter so it mirrors the surface the reporter uses
 * (`connect`, `close`, `error`, `write`, `end`, `destroy`).
 */

import { EventEmitter } from "node:events"
import type { EventBus, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// node:net mock
// ---------------------------------------------------------------------------

interface RecordedRequest {
	jsonrpc: string
	id: string
	method: string
	params: Record<string, unknown>
}

interface FakeSocket extends EventEmitter {
	write: ReturnType<typeof vi.fn>
	end: ReturnType<typeof vi.fn>
	destroy: ReturnType<typeof vi.fn>
}

const recordedRequests: RecordedRequest[] = []
let destroyOnConnect = false

function makeFakeSocket(): FakeSocket {
	const socket = new EventEmitter() as FakeSocket
	socket.write = vi.fn((data: string | Buffer, cb?: (err?: Error | null) => void) => {
		try {
			const text = typeof data === "string" ? data : data.toString("utf8")
			const trimmed = text.replace(/\n$/, "")
			if (trimmed.length > 0) {
				const parsed = JSON.parse(trimmed) as RecordedRequest
				recordedRequests.push(parsed)
			}
		} catch (err) {
			cb?.(err as Error)
			return false
		}
		cb?.(null)
		return true
	})
	// The reporter now writes via `socket.end(data, callback)` and resolves
	// on the callback firing (Node's "finish" semantics: data flushed +
	// FIN queued). Mirror that by parsing the data argument and invoking
	// the callback on the next microtask, instead of relying on a `close`
	// event — the peer's half of a real socket can stay open well past
	// our short timeouts.
	socket.end = vi.fn((data?: string | Buffer, cb?: () => void) => {
		if (data !== undefined && data !== null) {
			try {
				const text = typeof data === "string" ? data : data.toString("utf8")
				const trimmed = text.replace(/\n$/, "")
				if (trimmed.length > 0) {
					const parsed = JSON.parse(trimmed) as RecordedRequest
					recordedRequests.push(parsed)
				}
			} catch {
				queueMicrotask(() => cb?.())
				return
			}
		}
		queueMicrotask(() => cb?.())
	})
	socket.destroy = vi.fn(() => {
		queueMicrotask(() => socket.emit("close"))
	})
	return socket
}

vi.mock("node:net", () => {
	const createConnection = vi.fn((_address: string) => {
		const sock = makeFakeSocket()
		// Defer the connect event so listeners attach first, just like a
		// real socket would.
		queueMicrotask(() => {
			if (destroyOnConnect) {
				sock.destroy()
				sock.emit("error", new Error("herdr socket destroyed on connect"))
			} else {
				sock.emit("connect")
			}
		})
		return sock
	})
	return {
		default: { createConnection },
		createConnection,
	}
})

// Import after the mock is registered so the reporter picks it up.
const herdrReporterModule = await import("./herdr-reporter.js")
const { createHerdrReporter, readHerdrEnv, beforeExitReleasers } = herdrReporterModule
const herdrReporterExtension = herdrReporterModule.default

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	return {
		mode: "tui",
		hasUI: true,
		cwd: "/tmp",
		ui: {} as ExtensionContext["ui"],
		sessionManager: {
			getSessionFile: () => "/tmp/session.jsonl",
			getSessionId: () => "sess-abc",
		} as unknown as ExtensionContext["sessionManager"],
		modelRegistry: {} as ExtensionContext["modelRegistry"],
		model: undefined,
		scopedModels: [],
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		...overrides,
	}
}

interface FakePi {
	handlers: Map<string, Array<(...args: unknown[]) => unknown>>
	events: EventBus & { emit: ReturnType<typeof vi.fn>; listeners: Map<string, Array<(data: unknown) => void>> }
	api: ExtensionAPI & { herdrReporter?: unknown }
}

function makeFakePi(): FakePi {
	const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>()
	const listeners = new Map<string, Array<(data: unknown) => void>>()
	const events = {
		emit: vi.fn((channel: string, data: unknown) => {
			const list = listeners.get(channel) ?? []
			for (const fn of list) fn(data)
		}),
		on: vi.fn((channel: string, handler: (data: unknown) => void) => {
			if (!listeners.has(channel)) listeners.set(channel, [])
			listeners.get(channel)?.push(handler)
			return () => {
				const list = listeners.get(channel) ?? []
				const idx = list.indexOf(handler)
				if (idx >= 0) list.splice(idx, 1)
			}
		}),
		listeners,
	} as unknown as EventBus & { emit: ReturnType<typeof vi.fn>; listeners: Map<string, Array<(data: unknown) => void>> }

	const api = {
		on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
			if (!handlers.has(event)) handlers.set(event, [])
			handlers.get(event)?.push(handler)
		}),
		events,
	} as unknown as ExtensionAPI & { herdrReporter?: unknown }

	return { handlers, events, api }
}

function getHandler(pi: FakePi, event: string): (...args: unknown[]) => Promise<void> | void {
	const list = pi.handlers.get(event)
	if (!list || list.length === 0) throw new Error(`No handler for ${event}`)
	return list[0] as (...args: unknown[]) => Promise<void> | void
}

// ---------------------------------------------------------------------------
// Environment + mock setup
// ---------------------------------------------------------------------------

let originalEnv: Record<string, string | undefined>

beforeEach(() => {
	originalEnv = {
		HERDR_ENV: process.env.HERDR_ENV,
		HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
		HERDR_PANE_ID: process.env.HERDR_PANE_ID,
		HERDR_BIN_PATH: process.env.HERDR_BIN_PATH,
	}
	recordedRequests.length = 0
	destroyOnConnect = false
})

afterEach(() => {
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) {
			delete process.env[key]
		} else {
			process.env[key] = value
		}
	}
})

// ---------------------------------------------------------------------------
// readHerdrEnv
// ---------------------------------------------------------------------------

describe("readHerdrEnv", () => {
	it("returns enabled=false when HERDR_ENV is unset", () => {
		delete process.env.HERDR_ENV
		delete process.env.HERDR_SOCKET_PATH
		delete process.env.HERDR_PANE_ID

		const view = readHerdrEnv()
		expect(view.enabled).toBe(false)
	})

	it("returns enabled=false when HERDR_ENV is not '1'", () => {
		process.env.HERDR_ENV = "yes"
		process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock"
		process.env.HERDR_PANE_ID = "pane-1"

		const view = readHerdrEnv()
		expect(view.enabled).toBe(false)
	})

	it("returns enabled=false when HERDR_ENV=1 but socket path is missing", () => {
		process.env.HERDR_ENV = "1"
		delete process.env.HERDR_SOCKET_PATH
		process.env.HERDR_PANE_ID = "pane-1"

		expect(readHerdrEnv().enabled).toBe(false)
	})

	it("returns enabled=false when HERDR_ENV=1 but pane id is missing", () => {
		process.env.HERDR_ENV = "1"
		process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock"
		delete process.env.HERDR_PANE_ID

		expect(readHerdrEnv().enabled).toBe(false)
	})

	it("returns enabled=true with all fields populated when fully configured", () => {
		process.env.HERDR_ENV = "1"
		process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock"
		process.env.HERDR_PANE_ID = "pane-42"
		process.env.HERDR_BIN_PATH = "/usr/local/bin/herdr"

		const view = readHerdrEnv()
		expect(view.enabled).toBe(true)
		expect(view.socketPath).toBe("/tmp/herdr.sock")
		expect(view.paneId).toBe("pane-42")
		expect(view.binPath).toBe("/usr/local/bin/herdr")
	})
})

// ---------------------------------------------------------------------------
// createHerdrReporter
// ---------------------------------------------------------------------------

function flushMicrotasks(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve))
}

describe("createHerdrReporter", () => {
	it("sends pane.report_agent with state, monotonic seq, and a session id", async () => {
		const reporter = createHerdrReporter({
			paneId: "pane-1",
			socketPath: "/tmp/herdr.sock",
			source: "herdr:kimchi",
			agent: "kimchi",
		})
		reporter.updateSessionRef({ id: "sess-42" })

		reporter.reportState("working")
		await reporter.drain()

		expect(recordedRequests).toHaveLength(1)
		const [req] = recordedRequests
		expect(req.method).toBe("pane.report_agent")
		expect(req.params.state).toBe("working")
		expect(req.params.pane_id).toBe("pane-1")
		expect(req.params.source).toBe("herdr:kimchi")
		expect(req.params.agent).toBe("kimchi")
		expect(req.params.agent_session_id).toBe("sess-42")
		expect(req.params.seq).toBe(Number(req.id))
		expect(typeof req.id).toBe("string")
	})

	it("prefers agent_session_path over agent_session_id when both are set", async () => {
		const reporter = createHerdrReporter({
			paneId: "pane-1",
			socketPath: "/tmp/herdr.sock",
			source: "herdr:kimchi",
			agent: "kimchi",
		})
		reporter.updateSessionRef({ id: "sess-id", path: "/tmp/sess.jsonl" })

		reporter.reportState("idle")
		await reporter.drain()

		expect(recordedRequests).toHaveLength(1)
		expect(recordedRequests[0].params.agent_session_path).toBe("/tmp/sess.jsonl")
		expect(recordedRequests[0].params.agent_session_id).toBeUndefined()
	})

	it("sends pane.report_agent_session with session_start_source", async () => {
		const reporter = createHerdrReporter({
			paneId: "pane-1",
			socketPath: "/tmp/herdr.sock",
			source: "herdr:kimchi",
			agent: "kimchi",
		})

		reporter.reportSession({ id: "sess-99" }, "startup")
		await reporter.drain()

		expect(recordedRequests).toHaveLength(1)
		const [req] = recordedRequests
		expect(req.method).toBe("pane.report_agent_session")
		expect(req.params.agent_session_id).toBe("sess-99")
		expect(req.params.session_start_source).toBe("startup")
		expect(req.params.pane_id).toBe("pane-1")
		expect(req.params.source).toBe("herdr:kimchi")
		expect(req.params.agent).toBe("kimchi")
	})

	it("omits session_start_source when not provided", async () => {
		const reporter = createHerdrReporter({
			paneId: "pane-1",
			socketPath: "/tmp/herdr.sock",
			source: "herdr:kimchi",
			agent: "kimchi",
		})

		reporter.reportSession({ id: "sess-99" })
		await reporter.drain()

		expect(recordedRequests[0].params.session_start_source).toBeUndefined()
	})

	it("reports queued reports in submission order with strictly increasing seq", async () => {
		const reporter = createHerdrReporter({
			paneId: "pane-1",
			socketPath: "/tmp/herdr.sock",
			source: "herdr:kimchi",
			agent: "kimchi",
		})
		reporter.updateSessionRef({ id: "sess-1" })

		reporter.reportState("working")
		reporter.reportState("idle")
		reporter.reportState("blocked", "Permission: bash")
		reporter.reportSession({ id: "sess-2" }, "resume")
		await reporter.drain()

		const seqs = recordedRequests.map((r) => Number(r.id))
		for (let i = 1; i < seqs.length; i++) {
			expect(seqs[i]).toBeGreaterThan(seqs[i - 1])
		}

		expect(recordedRequests.map((r) => r.method)).toEqual([
			"pane.report_agent",
			"pane.report_agent",
			"pane.report_agent",
			"pane.report_agent_session",
		])
		expect(recordedRequests[0].params.state).toBe("working")
		expect(recordedRequests[1].params.state).toBe("idle")
		expect(recordedRequests[2].params.state).toBe("blocked")
		expect(recordedRequests[2].params.message).toBe("Permission: bash")
		expect(recordedRequests[3].params.agent_session_id).toBe("sess-2")
		expect(recordedRequests[3].params.session_start_source).toBe("resume")
	})

	it("propagates the per-method seq into params.seq", async () => {
		const reporter = createHerdrReporter({
			paneId: "pane-1",
			socketPath: "/tmp/herdr.sock",
			source: "herdr:kimchi",
			agent: "kimchi",
		})

		reporter.reportState("working")
		reporter.reportState("idle")
		await reporter.drain()

		for (const req of recordedRequests) {
			expect(req.params.seq).toBe(Number(req.id))
		}
	})

	it("swallows socket errors without throwing", async () => {
		destroyOnConnect = true
		const reporter = createHerdrReporter({
			paneId: "pane-1",
			socketPath: "/tmp/herdr.sock",
			source: "herdr:kimchi",
			agent: "kimchi",
		})

		expect(() => reporter.reportState("working")).not.toThrow()
		// Drain must resolve even when every send fails; allow plenty of
		// microtask flushes for the retry path to complete.
		for (let i = 0; i < 5; i++) await flushMicrotasks()
		await expect(reporter.drain()).resolves.toBeUndefined()
		expect(recordedRequests).toHaveLength(0)
	})

	it("release() prevents new reports from being enqueued", async () => {
		const reporter = createHerdrReporter({
			paneId: "pane-1",
			socketPath: "/tmp/herdr.sock",
			source: "herdr:kimchi",
			agent: "kimchi",
		})

		reporter.reportState("working")
		await reporter.release()
		reporter.reportState("idle")

		expect(recordedRequests).toHaveLength(1)
		expect(recordedRequests[0].params.state).toBe("working")
	})

	it("updateSessionRef changes the agent_session stamp on subsequent state reports", async () => {
		const reporter = createHerdrReporter({
			paneId: "pane-1",
			socketPath: "/tmp/herdr.sock",
			source: "herdr:kimchi",
			agent: "kimchi",
		})

		reporter.updateSessionRef({ id: "sess-a" })
		reporter.reportState("working")
		reporter.updateSessionRef({ id: "sess-b" })
		reporter.reportState("idle")
		await reporter.drain()

		expect(recordedRequests[0].params.agent_session_id).toBe("sess-a")
		expect(recordedRequests[1].params.agent_session_id).toBe("sess-b")
	})
})

// ---------------------------------------------------------------------------
// herdrReporterExtension lifecycle
// ---------------------------------------------------------------------------

describe("herdrReporterExtension", () => {
	beforeEach(() => {
		process.env.HERDR_ENV = "1"
		process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock"
		process.env.HERDR_PANE_ID = "pane-1"
	})

	it("is a no-op when HERDR_ENV is unset", () => {
		delete process.env.HERDR_ENV
		const pi = makeFakePi()
		herdrReporterExtension(pi.api)
		expect(pi.handlers.size).toBe(0)
		expect(pi.api.herdrReporter).toBeUndefined()
	})

	it("registers handlers and exposes the reporter on pi", () => {
		const pi = makeFakePi()
		herdrReporterExtension(pi.api)

		expect(pi.handlers.has("session_start")).toBe(true)
		expect(pi.handlers.has("agent_start")).toBe(true)
		expect(pi.handlers.has("agent_settled")).toBe(true)
		expect(pi.handlers.has("session_shutdown")).toBe(true)
		expect(pi.api.herdrReporter).toBeDefined()
	})

	it("session_start in TUI mode reports session + initial idle state", async () => {
		const pi = makeFakePi()
		herdrReporterExtension(pi.api)

		const handler = getHandler(pi, "session_start")
		await handler({ reason: "startup" }, makeCtx({ isIdle: () => true }))

		const reporter = pi.api.herdrReporter as ReturnType<typeof createHerdrReporter>
		await reporter.drain()

		const methods = recordedRequests.map((r) => r.method)
		expect(methods).toContain("pane.report_agent_session")
		expect(methods).toContain("pane.report_agent")
		const initialState = recordedRequests.find((r) => r.method === "pane.report_agent")
		expect(initialState?.params.state).toBe("idle")
		const sessionReport = recordedRequests.find((r) => r.method === "pane.report_agent_session")
		expect(sessionReport?.params.session_start_source).toBe("startup")
	})

	it("session_start in TUI mode reports working when isIdle is false", async () => {
		const pi = makeFakePi()
		herdrReporterExtension(pi.api)

		const handler = getHandler(pi, "session_start")
		await handler({ reason: "resume" }, makeCtx({ isIdle: () => false }))

		const reporter = pi.api.herdrReporter as ReturnType<typeof createHerdrReporter>
		await reporter.drain()

		const stateReports = recordedRequests.filter((r) => r.method === "pane.report_agent")
		expect(stateReports[0].params.state).toBe("working")
	})

	it("session_start in non-TUI mode is ignored", async () => {
		const pi = makeFakePi()
		herdrReporterExtension(pi.api)

		const handler = getHandler(pi, "session_start")
		await handler({ reason: "startup" }, makeCtx({ mode: "rpc" }))

		expect(recordedRequests).toHaveLength(0)
	})

	it("agent_start switches the state machine to working", async () => {
		const pi = makeFakePi()
		herdrReporterExtension(pi.api)

		// Anchor the root session.
		await getHandler(pi, "session_start")({ reason: "startup" }, makeCtx({ isIdle: () => true }))

		recordedRequests.length = 0
		getHandler(pi, "agent_start")({}, makeCtx({ isIdle: () => false }))

		const reporter = pi.api.herdrReporter as ReturnType<typeof createHerdrReporter>
		await reporter.drain()

		const stateReports = recordedRequests.filter((r) => r.method === "pane.report_agent")
		expect(stateReports.some((r) => r.params.state === "working")).toBe(true)
	})

	it("agent_settled when isIdle=true switches the state machine to idle", async () => {
		const pi = makeFakePi()
		herdrReporterExtension(pi.api)

		await getHandler(pi, "session_start")({ reason: "startup" }, makeCtx({ isIdle: () => false }))

		recordedRequests.length = 0
		getHandler(pi, "agent_settled")({}, makeCtx({ isIdle: () => true }))

		const reporter = pi.api.herdrReporter as ReturnType<typeof createHerdrReporter>
		await reporter.drain()

		const stateReports = recordedRequests.filter((r) => r.method === "pane.report_agent")
		expect(stateReports[stateReports.length - 1].params.state).toBe("idle")
	})

	it("agent_settled when isIdle=false does not change the state", async () => {
		const pi = makeFakePi()
		herdrReporterExtension(pi.api)

		await getHandler(pi, "session_start")({ reason: "startup" }, makeCtx({ isIdle: () => true }))

		const reporter = pi.api.herdrReporter as ReturnType<typeof createHerdrReporter>
		await reporter.drain()

		recordedRequests.length = 0
		getHandler(pi, "agent_settled")({}, makeCtx({ isIdle: () => false }))
		await reporter.drain()

		const stateReports = recordedRequests.filter((r) => r.method === "pane.report_agent")
		expect(stateReports).toHaveLength(0)
	})

	it("herdr:blocked active:true switches to blocked and active:false returns to idle", async () => {
		const pi = makeFakePi()
		herdrReporterExtension(pi.api)

		await getHandler(pi, "session_start")({ reason: "startup" }, makeCtx({ isIdle: () => true }))

		recordedRequests.length = 0
		pi.events.emit("herdr:blocked", { active: true, label: "Permission: write" })

		const reporter = pi.api.herdrReporter as ReturnType<typeof createHerdrReporter>
		await reporter.drain()

		const blockedReports = recordedRequests.filter(
			(r) => r.method === "pane.report_agent" && r.params.state === "blocked",
		)
		expect(blockedReports.length).toBeGreaterThan(0)
		expect(blockedReports[0].params.message).toBe("Permission: write")

		recordedRequests.length = 0
		pi.events.emit("herdr:blocked", { active: false })
		await reporter.drain()

		const stateReports = recordedRequests.filter((r) => r.method === "pane.report_agent")
		expect(stateReports[stateReports.length - 1].params.state).toBe("idle")
	})

	it("refcounts nested herdr:blocked activations correctly", async () => {
		const pi = makeFakePi()
		herdrReporterExtension(pi.api)

		await getHandler(pi, "session_start")({ reason: "startup" }, makeCtx({ isIdle: () => true }))

		const reporter = pi.api.herdrReporter as ReturnType<typeof createHerdrReporter>
		await reporter.drain()

		// Two nested activations. Use the same label so the state-change
		// deduper doesn't republish on the inner activation.
		pi.events.emit("herdr:blocked", { active: true, label: "Permission" })
		pi.events.emit("herdr:blocked", { active: true, label: "Permission" })
		await reporter.drain()

		recordedRequests.length = 0

		// First deactivation: counter goes to 1 — still blocked, no idle emit.
		pi.events.emit("herdr:blocked", { active: false })
		await reporter.drain()
		const afterFirstDeactivate = recordedRequests.filter((r) => r.method === "pane.report_agent")
		expect(afterFirstDeactivate.some((r) => r.params.state === "idle")).toBe(false)

		// Second deactivation: counter reaches 0 — back to idle.
		recordedRequests.length = 0
		pi.events.emit("herdr:blocked", { active: false })
		await reporter.drain()
		const afterLastDeactivate = recordedRequests.filter((r) => r.method === "pane.report_agent")
		expect(afterLastDeactivate.some((r) => r.params.state === "idle")).toBe(true)
	})

	it("blocked state takes precedence over working state", async () => {
		const pi = makeFakePi()
		herdrReporterExtension(pi.api)

		await getHandler(pi, "session_start")({ reason: "startup" }, makeCtx({ isIdle: () => false }))

		recordedRequests.length = 0
		pi.events.emit("herdr:blocked", { active: true, label: "Permission: bash" })

		const reporter = pi.api.herdrReporter as ReturnType<typeof createHerdrReporter>
		await reporter.drain()

		const stateReports = recordedRequests.filter((r) => r.method === "pane.report_agent")
		expect(stateReports[stateReports.length - 1].params.state).toBe("blocked")
	})

	it("session_shutdown triggers release and enqueues a final idle state report", async () => {
		const pi = makeFakePi()
		herdrReporterExtension(pi.api)

		await getHandler(pi, "session_start")({ reason: "startup" }, makeCtx({ isIdle: () => false }))

		const reporter = pi.api.herdrReporter as ReturnType<typeof createHerdrReporter>
		await reporter.drain()

		const releaseSpy = vi.spyOn(reporter, "release")

		recordedRequests.length = 0
		getHandler(pi, "session_shutdown")({}, makeCtx())

		// release is fire-and-forget (voided), so flush microtasks before
		// inspecting the spy.
		await flushMicrotasks()
		await reporter.drain()

		expect(releaseSpy).toHaveBeenCalledTimes(1)

		// The shutdown MUST emit a final `idle` report so herdr does not
		// keep showing the last working/blocked state.
		const stateAfterShutdown = recordedRequests.filter((r) => r.method === "pane.report_agent")
		expect(stateAfterShutdown).toHaveLength(1)
		expect(stateAfterShutdown[0].params.state).toBe("idle")
		expect(stateAfterShutdown[0].params.message).toBeUndefined()

		// After release, further reports are dropped.
		reporter.reportState("working")
		await reporter.drain()
		const stateAfterRelease = recordedRequests.filter((r) => r.method === "pane.report_agent")
		expect(stateAfterRelease).toHaveLength(1) // still the idle we already saw
	})

	it("session_shutdown enqueues a final idle report even from a blocked state", async () => {
		const pi = makeFakePi()
		herdrReporterExtension(pi.api)

		await getHandler(pi, "session_start")({ reason: "startup" }, makeCtx({ isIdle: () => true }))

		const reporter = pi.api.herdrReporter as ReturnType<typeof createHerdrReporter>
		await reporter.drain()

		// Force the state machine into `blocked` so we can assert the
		// release overrides it.
		pi.events.emit("herdr:blocked", { active: true, label: "Permission: write" })
		await reporter.drain()

		recordedRequests.length = 0
		getHandler(pi, "session_shutdown")({}, makeCtx())
		await flushMicrotasks()
		await reporter.drain()

		const stateAfterShutdown = recordedRequests.filter((r) => r.method === "pane.report_agent")
		expect(stateAfterShutdown).toHaveLength(1)
		expect(stateAfterShutdown[0].params.state).toBe("idle")
		expect(stateAfterShutdown[0].params.message).toBeUndefined()
	})

	it("session_shutdown returns a promise that resolves after the final idle report has drained", async () => {
		const pi = makeFakePi()
		herdrReporterExtension(pi.api)

		await getHandler(pi, "session_start")({ reason: "startup" }, makeCtx({ isIdle: () => false }))

		const reporter = pi.api.herdrReporter as ReturnType<typeof createHerdrReporter>
		await reporter.drain()

		recordedRequests.length = 0
		const shutdownHandler = getHandler(pi, "session_shutdown")
		const ret = shutdownHandler({}, makeCtx())
		// The handler is synchronous-fire-and-forget but the underlying
		// release promise is exposed so callers (and the beforeExit
		// backstop) can await it. We don't await here — instead we drain
		// the reporter afterwards and confirm the idle report landed.
		expect(ret).toBeUndefined()

		await flushMicrotasks()
		await reporter.drain()

		const stateAfterShutdown = recordedRequests.filter((r) => r.method === "pane.report_agent")
		expect(stateAfterShutdown).toHaveLength(1)
		expect(stateAfterShutdown[0].params.state).toBe("idle")
	})

	it("non-TUI session_start keeps the extension inert until TUI session_start arrives", async () => {
		const pi = makeFakePi()
		herdrReporterExtension(pi.api)

		// First, a non-TUI session_start (e.g. an RPC heartbeat).
		await getHandler(pi, "session_start")({ reason: "startup" }, makeCtx({ mode: "rpc" }))

		const reporter = pi.api.herdrReporter as ReturnType<typeof createHerdrReporter>
		await reporter.drain()
		expect(recordedRequests).toHaveLength(0)

		// Now a TUI session_start anchors the root session.
		await getHandler(pi, "session_start")({ reason: "startup" }, makeCtx({ mode: "tui", isIdle: () => true }))
		await reporter.drain()

		expect(recordedRequests.length).toBeGreaterThan(0)
		const sessionReports = recordedRequests.filter((r) => r.method === "pane.report_agent_session")
		expect(sessionReports).toHaveLength(1)
	})

	it("publishes working then blocked then working when blocked arrives mid-turn", async () => {
		const pi = makeFakePi()
		herdrReporterExtension(pi.api)

		// Anchor root session in working state.
		await getHandler(pi, "session_start")({ reason: "startup" }, makeCtx({ isIdle: () => false }))

		const reporter = pi.api.herdrReporter as ReturnType<typeof createHerdrReporter>
		await reporter.drain()

		recordedRequests.length = 0

		// Block mid-turn.
		pi.events.emit("herdr:blocked", { active: true, label: "Permission: write" })
		// Unblock back to working.
		pi.events.emit("herdr:blocked", { active: false })

		await reporter.drain()

		const stateSequence = recordedRequests.filter((r) => r.method === "pane.report_agent").map((r) => r.params.state)
		expect(stateSequence).toEqual(["blocked", "working"])
	})
})

// ---------------------------------------------------------------------------
// process-level beforeExit listener regression
// ---------------------------------------------------------------------------
//
// Each extension instance registers its `releaseReporter` callback with the
// module-level `beforeExitReleasers` Set. On `release()` (or
// `session_shutdown`) the instance must remove itself so repeated
// instantiations cannot accumulate process-level `beforeExit` listeners and
// trip Node's MaxListenersExceededWarning.

describe("process-level beforeExit listener", () => {
	beforeEach(() => {
		process.env.HERDR_ENV = "1"
		process.env.HERDR_SOCKET_PATH = "/tmp/herdr.sock"
		process.env.HERDR_PANE_ID = "pane-regression"
	})

	it("does not leak process listeners or registry entries when multiple instances are created and released", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

		try {
			const initialListenerCount = process.listenerCount("beforeExit")
			const initialRegistrySize = beforeExitReleasers.size

			const pi = makeFakePi()
			herdrReporterExtension(pi.api)

			// Anchor a root session so the extension wires up its release
			// callback against the module-level registry.
			const sessionStart = getHandler(pi, "session_start")
			await sessionStart({ reason: "startup" }, makeCtx({ isIdle: () => true }))

			const reporter = pi.api.herdrReporter as ReturnType<typeof createHerdrReporter>
			await reporter.drain()

			// One extension instance is registered. The module-level
			// listener itself was registered once at import time; only
			// instance callbacks should grow.
			expect(beforeExitReleasers.size).toBe(initialRegistrySize + 1)

			// Release the first instance; the registry and process
			// listener count must be restored.
			const shutdown = getHandler(pi, "session_shutdown")
			shutdown({}, makeCtx())
			await flushMicrotasks()
			await reporter.drain()

			expect(beforeExitReleasers.size).toBe(initialRegistrySize)
			expect(process.listenerCount("beforeExit")).toBe(initialListenerCount)

			// Create several more instances and release each one. The
			// listener count must return to the original each time and
			// the registry must never grow above the baseline.
			const iterations = 5
			for (let i = 0; i < iterations; i++) {
				const baselineForIteration = new Set(beforeExitReleasers)
				const piN = makeFakePi()
				herdrReporterExtension(piN.api)
				await getHandler(piN, "session_start")({ reason: "startup" }, makeCtx({ isIdle: () => true }))
				const reporterN = piN.api.herdrReporter as ReturnType<typeof createHerdrReporter>
				await reporterN.drain()

				expect(beforeExitReleasers.size).toBe(initialRegistrySize + 1)

				// Capture only the freshly-added release callback for
				// this iteration. Prior tests in this file may have left
				// their own entries in the module-level set; we filter to
				// the delta so we can assert this instance's entry was
				// specifically removed.
				const newlyAdded = Array.from(beforeExitReleasers).filter((fn) => !baselineForIteration.has(fn))
				expect(newlyAdded).toHaveLength(1)

				getHandler(piN, "session_shutdown")({}, makeCtx())
				await flushMicrotasks()
				await reporterN.drain()

				expect(beforeExitReleasers.size).toBe(initialRegistrySize)
				expect(process.listenerCount("beforeExit")).toBe(initialListenerCount)

				// The specific callback this iteration registered must
				// no longer be in the set after release.
				for (const fn of newlyAdded) {
					expect(beforeExitReleasers.has(fn)).toBe(false)
				}
			}

			// Final guardrail: no warning was emitted.
			expect(warnSpy).not.toHaveBeenCalled()
		} finally {
			warnSpy.mockRestore()
		}
	})

	it("beforeExit awaits every registered release promise and clears the registry", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

		try {
			// Snapshot the registry so we can identify the entries THIS
			// test contributes. Earlier tests in this file may leave
			// dangling extension instances whose release callbacks are
			// still in the registry; that's fine — they're orthogonal to
			// what we want to assert here.
			const baseline = new Set(beforeExitReleasers)

			const piA = makeFakePi()
			herdrReporterExtension(piA.api)
			await getHandler(piA, "session_start")({ reason: "startup" }, makeCtx({ isIdle: () => false }))
			const reporterA = piA.api.herdrReporter as ReturnType<typeof createHerdrReporter>
			const releaseASpy = vi.spyOn(reporterA, "release")
			await reporterA.drain()

			const piB = makeFakePi()
			herdrReporterExtension(piB.api)
			await getHandler(piB, "session_start")({ reason: "startup" }, makeCtx({ isIdle: () => false }))
			const reporterB = piB.api.herdrReporter as ReturnType<typeof createHerdrReporter>
			const releaseBSpy = vi.spyOn(reporterB, "release")
			await reporterB.drain()

			const newlyAdded = Array.from(beforeExitReleasers).filter((fn) => !baseline.has(fn))
			expect(newlyAdded).toHaveLength(2)

			// Find the module-level async listener by inspecting its
			// source for the registry it iterates. We do not invoke it
			// for detection (invoking fires a real drain).
			const asyncListener = process
				.listeners("beforeExit")
				.find((fn) => fn.toString().includes("beforeExitReleasers")) as (() => Promise<void>) | undefined
			expect(asyncListener).toBeDefined()

			// Core invariant: the listener is async — it returns a Promise
			// that we can await. This is what keeps the event loop alive
			// long enough for the final idle reports to flush before the
			// process exits.
			const result = asyncListener?.()
			expect(result).toBeInstanceOf(Promise)

			await result

			// After the await, both reporters' release() must have been
			// called AND completed (because `releaseReporter` awaits
			// `reporter.release()` before resolving).
			expect(releaseASpy).toHaveBeenCalledTimes(1)
			expect(releaseBSpy).toHaveBeenCalledTimes(1)

			// The release callbacks this test registered must have
			// self-removed from the registry.
			for (const fn of newlyAdded) {
				expect(beforeExitReleasers.has(fn)).toBe(false)
			}
		} finally {
			warnSpy.mockRestore()
		}
	})

	it("beforeExit tolerates non-promise release callbacks (legacy sync releases)", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

		try {
			const initialRegistrySize = beforeExitReleasers.size

			// Inject a sync callback into the registry to confirm the
			// handler does not throw when a release does not return a
			// promise. Also inject a deliberately-throwing one to confirm
			// it does not break sibling releases.
			const syncRelease = vi.fn(() => {
				// returns undefined on purpose
			})
			const throwingRelease = vi.fn(() => {
				throw new Error("synthetic")
			})

			beforeExitReleasers.add(syncRelease)
			beforeExitReleasers.add(throwingRelease)
			expect(beforeExitReleasers.size).toBe(initialRegistrySize + 2)

			const asyncListener = process
				.listeners("beforeExit")
				.find((fn) => fn.toString().includes("beforeExitReleasers")) as (() => Promise<void>) | undefined
			expect(asyncListener).toBeDefined()

			const result = asyncListener?.()
			expect(result).toBeInstanceOf(Promise)

			await expect(result).resolves.toBeUndefined()

			expect(syncRelease).toHaveBeenCalledTimes(1)
			expect(throwingRelease).toHaveBeenCalledTimes(1)

			// We left these entries in the registry on purpose — clean up
			// so subsequent tests are unaffected.
			beforeExitReleasers.delete(syncRelease)
			beforeExitReleasers.delete(throwingRelease)
			expect(beforeExitReleasers.size).toBe(initialRegistrySize)
		} finally {
			warnSpy.mockRestore()
		}
	})
})
