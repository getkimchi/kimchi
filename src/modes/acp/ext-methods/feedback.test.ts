import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { RatingWindow } from "../../../extensions/feedback/rating-window.js"
import { armRatingWindow, clearRatingWindow, getRatingWindow } from "../../../extensions/feedback/rating-window.js"
import { BaseFakeAgentSession, makeAcpConn, makeAcpSessionFactory } from "../__mocks__/fake-agent-session.js"
import { AVAILABLE_EXT_METHODS } from "../capabilities.js"
import { KimchiAcpAgent } from "../server.js"

const feedbackMock = vi.hoisted(() => ({ trackFeedback: vi.fn() }))
vi.mock("../../../extensions/telemetry/index.js", () => ({
	trackFeedback: feedbackMock.trackFeedback,
}))

class FakeAgentSession extends BaseFakeAgentSession {
	appendCustomEntry = vi.fn((_customType?: string, _data?: unknown) => "entry-id")

	constructor(sessionId: string) {
		super(sessionId)
		this.sessionManager.appendCustomEntry = this.appendCustomEntry
	}

	clearQueue = vi.fn(() => ({ steering: [] as string[], followUp: [] as string[] }))
	getContextUsage = () => undefined

	private promptResolve: (() => void) | undefined
	private promptReject: ((err: unknown) => void) | undefined

	override prompt(): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			this.promptResolve = resolve
			this.promptReject = reject
		})
	}
	finishTurn(): void {
		this.promptResolve?.()
	}
	rejectTurn(err: unknown): void {
		this.promptReject?.(err)
	}
	override dispose(): void {
		this.finishTurn()
		super.dispose()
	}
}

const AUTO_WINDOW: RatingWindow = { autoModelUsed: true, routedModelId: "glm-5.3" }
const CONCRETE_WINDOW: RatingWindow = { autoModelUsed: false, routedModelId: undefined }

function makeAgent(session: FakeAgentSession) {
	return new KimchiAcpAgent(makeAcpConn(), {
		extensionFactories: [],
		agentDir: "/tmp/fake-agent-dir",
		sessionFactory: makeAcpSessionFactory(session),
	})
}

describe("KimchiAcpAgent extMethod feedback", () => {
	beforeEach(() => {
		feedbackMock.trackFeedback.mockReset()
		clearRatingWindow("sess-1")
	})

	afterEach(() => {
		clearRatingWindow("sess-1")
		clearRatingWindow("sess-2")
	})

	it("records a rating after a turn settles end_turn: entry, telemetry, { status: 'recorded' }", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		await agent.initialize({ protocolVersion: 1 })
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })

		// Real ordering (docs/acp-feedback.md): agent_settled arms the
		// window while prompt() is still draining; prompt() then resolves into
		// finalizeTurn("end_turn"), which must NOT clear it.
		const promptPromise = agent.prompt({
			sessionId: "sess-1",
			prompt: [{ type: "text", text: "do work" }],
		})
		await Promise.resolve()
		armRatingWindow("sess-1", AUTO_WINDOW)
		session.finishTurn()
		expect(await promptPromise).toEqual({ stopReason: "end_turn" })

		const result = await agent.extMethod(AVAILABLE_EXT_METHODS.feedback, {
			sessionId: "sess-1",
			action: "rate_response",
			sentiment: "positive",
			reason: "Auto picked the right model",
		})

		expect(result).toEqual({ status: "recorded" })
		expect(session.appendCustomEntry).toHaveBeenCalledWith("feedback-summary", {
			sentiment: "positive",
			reason: "Auto picked the right model",
		})
		expect(feedbackMock.trackFeedback).toHaveBeenCalledWith({
			sentiment: "positive",
			reason: "Auto picked the right model",
			reasonType: "predefined",
			routingModelId: "glm-5.3",
		})
	})

	it("one rating per settled response: the first submission consumes the window", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		await agent.initialize({ protocolVersion: 1 })
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		armRatingWindow("sess-1", CONCRETE_WINDOW)

		const first = await agent.extMethod(AVAILABLE_EXT_METHODS.feedback, {
			sessionId: "sess-1",
			action: "rate_response",
			sentiment: "negative",
			reason: "Too slow",
		})
		expect(first).toEqual({ status: "recorded" })
		expect(getRatingWindow("sess-1")).toBeUndefined()

		await expect(
			agent.extMethod(AVAILABLE_EXT_METHODS.feedback, {
				sessionId: "sess-1",
				action: "rate_response",
				sentiment: "negative",
			}),
		).rejects.toMatchObject({ code: -32600, message: "Invalid request: no settled response to rate" })
		expect(feedbackMock.trackFeedback).toHaveBeenCalledTimes(1)
	})

	it("accepts a rating without a reason and clamps reasons to 300 chars", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		await agent.initialize({ protocolVersion: 1 })
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		armRatingWindow("sess-1", CONCRETE_WINDOW)

		await agent.extMethod(AVAILABLE_EXT_METHODS.feedback, {
			sessionId: "sess-1",
			action: "rate_response",
			sentiment: "positive",
		})
		expect(session.appendCustomEntry).toHaveBeenCalledWith("feedback-summary", {
			sentiment: "positive",
			reason: "",
		})

		armRatingWindow("sess-1", CONCRETE_WINDOW)
		const longReason = "y".repeat(400)
		await agent.extMethod(AVAILABLE_EXT_METHODS.feedback, {
			sessionId: "sess-1",
			action: "rate_response",
			sentiment: "positive",
			reason: longReason,
		})
		const clamped = "y".repeat(300)
		expect(session.appendCustomEntry).toHaveBeenLastCalledWith("feedback-summary", {
			sentiment: "positive",
			reason: clamped,
		})
		expect(feedbackMock.trackFeedback).toHaveBeenLastCalledWith(expect.objectContaining({ reason: clamped }))
	})

	it("rejects while a prompt is in progress, even when a window is armed", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		await agent.initialize({ protocolVersion: 1 })
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		armRatingWindow("sess-1", AUTO_WINDOW)

		const promptPromise = agent.prompt({
			sessionId: "sess-1",
			prompt: [{ type: "text", text: "do work" }],
		})
		await Promise.resolve()

		await expect(
			agent.extMethod(AVAILABLE_EXT_METHODS.feedback, {
				sessionId: "sess-1",
				action: "rate_response",
				sentiment: "positive",
			}),
		).rejects.toMatchObject({
			code: -32600,
			message: "Invalid request: a prompt is already in progress for this session",
		})
		expect(feedbackMock.trackFeedback).not.toHaveBeenCalled()

		session.finishTurn()
		await promptPromise
	})

	it("a cancelled turn clears the armed window — there was no settled response to rate", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		await agent.initialize({ protocolVersion: 1 })
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })

		const promptPromise = agent.prompt({
			sessionId: "sess-1",
			prompt: [{ type: "text", text: "do work" }],
		})
		await Promise.resolve()
		armRatingWindow("sess-1", AUTO_WINDOW)

		await agent.cancel({ sessionId: "sess-1" })
		session.finishTurn()
		expect(await promptPromise).toEqual({ stopReason: "cancelled" })

		await expect(
			agent.extMethod(AVAILABLE_EXT_METHODS.feedback, {
				sessionId: "sess-1",
				action: "rate_response",
				sentiment: "positive",
			}),
		).rejects.toMatchObject({ code: -32600, message: "Invalid request: no settled response to rate" })
	})

	it("a terminally errored turn clears the armed window — there was no settled response to rate", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		await agent.initialize({ protocolVersion: 1 })
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })

		const promptPromise = agent.prompt({
			sessionId: "sess-1",
			prompt: [{ type: "text", text: "do work" }],
		})
		await Promise.resolve()
		armRatingWindow("sess-1", AUTO_WINDOW)

		session.rejectTurn(new Error("provider exploded"))
		await expect(promptPromise).rejects.toThrow("provider exploded")

		await expect(
			agent.extMethod(AVAILABLE_EXT_METHODS.feedback, {
				sessionId: "sess-1",
				action: "rate_response",
				sentiment: "positive",
			}),
		).rejects.toMatchObject({ code: -32600, message: "Invalid request: no settled response to rate" })
	})

	it("rejects when nothing settled yet (no window was ever armed)", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		await agent.initialize({ protocolVersion: 1 })
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })

		await expect(
			agent.extMethod(AVAILABLE_EXT_METHODS.feedback, {
				sessionId: "sess-1",
				action: "rate_response",
				sentiment: "positive",
			}),
		).rejects.toMatchObject({ code: -32600, message: "Invalid request: no settled response to rate" })
		expect(session.appendCustomEntry).not.toHaveBeenCalled()
	})

	it("maps a failing transcript write to internalError and keeps the window armed for retry", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		await agent.initialize({ protocolVersion: 1 })
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		armRatingWindow("sess-1", CONCRETE_WINDOW)
		session.appendCustomEntry.mockImplementation(() => {
			throw new Error("disk full")
		})

		await expect(
			agent.extMethod(AVAILABLE_EXT_METHODS.feedback, {
				sessionId: "sess-1",
				action: "rate_response",
				sentiment: "positive",
				reason: "Solved my task",
			}),
		).rejects.toMatchObject({ code: -32603, message: expect.stringContaining("failed to record rating") })

		// Nothing recorded, nothing consumed — the client retry is safe.
		expect(getRatingWindow("sess-1")).toEqual(CONCRETE_WINDOW)
		expect(feedbackMock.trackFeedback).not.toHaveBeenCalled()
	})

	it("a telemetry failure after the transcript write cannot double-record on retry", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		await agent.initialize({ protocolVersion: 1 })
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		armRatingWindow("sess-1", CONCRETE_WINDOW)
		feedbackMock.trackFeedback.mockImplementationOnce(() => {
			throw new Error("telemetry down")
		})

		// The transcript entry IS the record — telemetry failing afterwards
		// must not fail the submission, or a retry writes a second entry.
		await expect(
			agent.extMethod(AVAILABLE_EXT_METHODS.feedback, {
				sessionId: "sess-1",
				action: "rate_response",
				sentiment: "negative",
				reason: "Too slow",
			}),
		).resolves.toEqual({ status: "recorded" })
		expect(session.appendCustomEntry).toHaveBeenCalledWith("feedback-summary", {
			sentiment: "negative",
			reason: "Too slow",
		})
		expect(getRatingWindow("sess-1")).toBeUndefined()

		// The retry gets the one-rating-per-window rejection, not a second entry.
		await expect(
			agent.extMethod(AVAILABLE_EXT_METHODS.feedback, {
				sessionId: "sess-1",
				action: "rate_response",
				sentiment: "negative",
				reason: "Too slow",
			}),
		).rejects.toMatchObject({ code: -32600, message: "Invalid request: no settled response to rate" })
		expect(session.appendCustomEntry).toHaveBeenCalledTimes(1)
	})

	it("rejects invalid params: missing sessionId, unknown action, bad sentiment, non-string reason", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		await agent.initialize({ protocolVersion: 1 })
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		armRatingWindow("sess-1", CONCRETE_WINDOW)

		await expect(
			agent.extMethod(AVAILABLE_EXT_METHODS.feedback, { action: "rate_response", sentiment: "positive" }),
		).rejects.toMatchObject({ code: -32602 })

		await expect(
			agent.extMethod(AVAILABLE_EXT_METHODS.feedback, {
				sessionId: "sess-1",
				action: "model_switch",
				sentiment: "positive",
			}),
		).rejects.toMatchObject({ code: -32602 })

		await expect(
			agent.extMethod(AVAILABLE_EXT_METHODS.feedback, {
				sessionId: "sess-1",
				action: "rate_response",
				sentiment: "meh",
			}),
		).rejects.toMatchObject({ code: -32602 })

		await expect(
			agent.extMethod(AVAILABLE_EXT_METHODS.feedback, {
				sessionId: "sess-1",
				action: "rate_response",
				sentiment: "positive",
				reason: 42,
			}),
		).rejects.toMatchObject({ code: -32602 })

		// Every rejected call must leave the window armed and nothing recorded.
		expect(getRatingWindow("sess-1")).toEqual(CONCRETE_WINDOW)
		expect(session.appendCustomEntry).not.toHaveBeenCalled()
		expect(feedbackMock.trackFeedback).not.toHaveBeenCalled()
	})

	it("rejects rating an unknown session", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		await agent.initialize({ protocolVersion: 1 })
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })

		await expect(
			agent.extMethod(AVAILABLE_EXT_METHODS.feedback, {
				sessionId: "sess-2",
				action: "rate_response",
				sentiment: "positive",
			}),
		).rejects.toMatchObject({ code: -32602, message: "Invalid params: unknown sessionId sess-2" })
	})

	it("advertises feedback in the vendor-namespaced initialize response _meta", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		const response = await agent.initialize({ protocolVersion: 1 })
		const meta = response.agentCapabilities?._meta as Record<string, unknown> | undefined
		const vendor = meta?.["kimchi.dev"] as Record<string, boolean> | undefined
		expect(vendor?.feedback).toBe(true)
		expect(meta?.feedback).toBeUndefined()
	})
})
