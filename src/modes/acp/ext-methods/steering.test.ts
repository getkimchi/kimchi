import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk"
import type { AgentSession } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { AVAILABLE_EXT_METHODS } from "../capabilities.js"
import { type AcpSessionFactory, KimchiAcpAgent } from "../server.js"
import { AO_STEERING_METHOD } from "./steering.js"

class FakeAgentSession {
	sessionId: string
	disposed = false
	model = { provider: "test", id: "test-model" }
	modelRegistry = {
		getAvailable: () => [{ provider: "test", id: "test-model", name: "Test" }],
		find: (provider: string, id: string) =>
			this.modelRegistry.getAvailable().find((m) => m.provider === provider && m.id === id),
	}
	sessionManager = {
		getBranch: () => [],
		getSessionId: () => this.sessionId,
		getEntries: () => [],
		getSessionDir: () => "/tmp",
		getCwd: () => "/tmp",
		appendCustomEntry: () => "entry-id",
	}
	setSessionName = vi.fn()
	steer = vi.fn(async (_text: string) => {})
	extensionRunner = { emit: async () => {} }

	// Tests control when (or whether) the turn finishes to exercise the
	// active-turn / race paths.
	private promptResolve: (() => void) | undefined

	constructor(sessionId: string) {
		this.sessionId = sessionId
	}

	subscribe = () => () => {}
	async bindExtensions(): Promise<void> {}
	prompt(): Promise<void> {
		return new Promise<void>((resolve) => {
			this.promptResolve = resolve
		})
	}
	finishTurn(): void {
		this.promptResolve?.()
	}
	async abort(): Promise<void> {
		this.finishTurn()
	}
	dispose(): void {
		this.finishTurn()
		this.disposed = true
	}
}

function asSession(fake: FakeAgentSession): AgentSession {
	return fake as unknown as AgentSession
}

function makeConn(): AgentSideConnection {
	return {
		sessionUpdate: async (_p: SessionNotification) => {},
		extNotification: vi.fn(),
		extMethod: vi.fn(),
		requestPermission: vi.fn(),
		unstable_createElicitation: vi.fn(),
		closed: Promise.resolve(),
	} as unknown as AgentSideConnection
}

function makeAgent(session: FakeAgentSession) {
	const sessionFactory: AcpSessionFactory = async () => asSession(session)
	return new KimchiAcpAgent(makeConn(), {
		extensionFactories: [],
		agentDir: "/tmp/fake-agent-dir",
		sessionFactory,
	})
}

describe("KimchiAcpAgent extMethod steering", () => {
	it("queues the steering message via session.steer and returns injected when a turn is active", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		await agent.initialize({ protocolVersion: 1 })
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })

		const promptPromise = agent.prompt({
			sessionId: "sess-1",
			prompt: [{ type: "text", text: "do work" }],
		})
		// entry.turn is set synchronously in prompt(), but the call above is async
		// — flush the queue so the turn context exists before steering arrives.
		await Promise.resolve()

		const result = await agent.extMethod(AVAILABLE_EXT_METHODS.steering, {
			sessionId: "sess-1",
			prompt: "actually, do it differently",
		})

		expect(result).toEqual({ outcome: "injected", status: "injected" })
		expect(session.steer).toHaveBeenCalledTimes(1)
		expect(session.steer).toHaveBeenCalledWith("actually, do it differently")

		session.finishTurn()
		expect(await promptPromise).toEqual({ stopReason: "end_turn" })
	})

	it("returns promptRequired instead of throwing when no turn is in progress", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		await agent.initialize({ protocolVersion: 1 })
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })

		const result = await agent.extMethod(AVAILABLE_EXT_METHODS.steering, {
			sessionId: "sess-1",
			prompt: "hello",
		})

		expect(result).toEqual({ outcome: "promptRequired", status: "promptRequired" })
		expect(session.steer).not.toHaveBeenCalled()
	})

	it("routes AO's cross-agent _session/steering method to the same handler", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		await agent.initialize({ protocolVersion: 1 })
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })

		const promptPromise = agent.prompt({
			sessionId: "sess-1",
			prompt: [{ type: "text", text: "do work" }],
		})
		await Promise.resolve()

		const result = await agent.extMethod(AO_STEERING_METHOD, {
			sessionId: "sess-1",
			prompt: "nudge",
			// AO passes idleBehavior guidance — the handler must not start a turn.
			_meta: { steering: { idleBehavior: "promptRequired" } },
		})

		expect(result).toEqual({ outcome: "injected", status: "injected" })
		expect(session.steer).toHaveBeenCalledWith("nudge")

		session.finishTurn()
		await promptPromise
	})

	it("maps pi's extension-command steer() error to invalidParams instead of swallowing it", async () => {
		const session = new FakeAgentSession("sess-1")
		session.steer.mockRejectedValueOnce(
			new Error('Extension command "/plan" cannot be queued. Use prompt() or execute the command when not streaming.'),
		)
		const agent = makeAgent(session)
		await agent.initialize({ protocolVersion: 1 })
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })

		const promptPromise = agent.prompt({
			sessionId: "sess-1",
			prompt: [{ type: "text", text: "do work" }],
		})
		await Promise.resolve()

		await expect(
			agent.extMethod(AVAILABLE_EXT_METHODS.steering, { sessionId: "sess-1", prompt: "/plan refine" }),
		).rejects.toMatchObject({ code: -32602 })

		session.finishTurn()
		await promptPromise
	})

	it("does not relabel unexpected steer() errors as promptRequired", async () => {
		const session = new FakeAgentSession("sess-1")
		session.steer.mockRejectedValueOnce(new Error("boom"))
		const agent = makeAgent(session)
		await agent.initialize({ protocolVersion: 1 })
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })

		const promptPromise = agent.prompt({
			sessionId: "sess-1",
			prompt: [{ type: "text", text: "do work" }],
		})
		await Promise.resolve()

		await expect(
			agent.extMethod(AVAILABLE_EXT_METHODS.steering, { sessionId: "sess-1", prompt: "nudge" }),
		).rejects.toThrow("boom")

		session.finishTurn()
		await promptPromise
	})

	it("throws methodNotFound for unknown extension methods", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		await agent.initialize({ protocolVersion: 1 })

		await expect(agent.extMethod("_kimchi.dev/unknown", {})).rejects.toMatchObject({ code: -32601 })
	})

	it("throws invalidParams when sessionId is missing", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		await agent.initialize({ protocolVersion: 1 })

		await expect(agent.extMethod(AVAILABLE_EXT_METHODS.steering, { prompt: "hello" })).rejects.toMatchObject({
			code: -32602,
			message: "Invalid params: sessionId is required and must be a non-empty string",
		})
	})

	it("throws invalidParams when prompt is missing or empty", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		await agent.initialize({ protocolVersion: 1 })
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })

		await expect(agent.extMethod(AVAILABLE_EXT_METHODS.steering, { sessionId: "sess-1" })).rejects.toMatchObject({
			code: -32602,
			message: "Invalid params: prompt is required and must be a non-empty string",
		})
		await expect(
			agent.extMethod(AVAILABLE_EXT_METHODS.steering, { sessionId: "sess-1", prompt: "" }),
		).rejects.toMatchObject({
			code: -32602,
			message: "Invalid params: prompt is required and must be a non-empty string",
		})
	})

	it("throws invalidParams for an unknown sessionId", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		await agent.initialize({ protocolVersion: 1 })

		await expect(
			agent.extMethod(AVAILABLE_EXT_METHODS.steering, { sessionId: "sess-2", prompt: "hello" }),
		).rejects.toMatchObject({ code: -32602, message: "Invalid params: unknown sessionId sess-2" })
		expect(session.steer).not.toHaveBeenCalled()
	})

	it("advertises steering in initialize response (vendor namespace and AO's top-level form)", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		const response = await agent.initialize({ protocolVersion: 1 })
		const meta = response.agentCapabilities?._meta as Record<string, unknown> | undefined
		const vendor = meta?.["kimchi.dev"] as Record<string, boolean> | undefined
		expect(vendor?.steering).toBe(true)
		// AO's extensionSupported() check — steer.go reads this exact shape.
		const ao = meta?.steering as Record<string, boolean> | undefined
		expect(ao?.supported).toBe(true)
	})
})
