import { describe, expect, it } from "vitest"
import { asSession, BaseFakeAgentSession, makeAcpConn, makeAcpSessionFactory } from "../__mocks__/fake-agent-session.js"
import { AVAILABLE_EXT_METHODS } from "../capabilities.js"
import { KimchiAcpAgent } from "../server.js"

class FakeAgentSession extends BaseFakeAgentSession {}

function makeAgent(session: FakeAgentSession) {
	return new KimchiAcpAgent(makeAcpConn(), {
		extensionFactories: [],
		agentDir: "/tmp/fake-agent-dir",
		sessionFactory: makeAcpSessionFactory(session),
	})
}

describe("KimchiAcpAgent extMethod set_session_title", () => {
	it("sets the session title for a known session", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		await agent.initialize({ protocolVersion: 1 })
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })

		const result = await agent.extMethod(AVAILABLE_EXT_METHODS.set_session_title, {
			sessionId: "sess-1",
			title: "My Session",
		})

		expect(result).toEqual({})
		expect(session.setSessionName).toHaveBeenCalledWith("My Session")
	})

	it("throws invalidParams when sessionId is missing", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		await agent.initialize({ protocolVersion: 1 })

		await expect(
			agent.extMethod(AVAILABLE_EXT_METHODS.set_session_title, { title: "My Session" }),
		).rejects.toMatchObject({
			code: -32602,
			message: "Invalid params: sessionId is required and must be a non-empty string",
		})
	})

	it("throws invalidParams when sessionId is empty", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		await agent.initialize({ protocolVersion: 1 })

		await expect(
			agent.extMethod(AVAILABLE_EXT_METHODS.set_session_title, { sessionId: "", title: "My Session" }),
		).rejects.toMatchObject({
			code: -32602,
			message: "Invalid params: sessionId is required and must be a non-empty string",
		})
	})

	it("throws invalidParams when title is missing", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		await agent.initialize({ protocolVersion: 1 })

		await expect(
			agent.extMethod(AVAILABLE_EXT_METHODS.set_session_title, { sessionId: "sess-1" }),
		).rejects.toMatchObject({
			code: -32602,
			message: "Invalid params: title is required and must be a string",
		})
	})

	it("throws invalidParams when title is not a string", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		await agent.initialize({ protocolVersion: 1 })

		await expect(
			agent.extMethod(AVAILABLE_EXT_METHODS.set_session_title, { sessionId: "sess-1", title: 123 }),
		).rejects.toMatchObject({ code: -32602, message: "Invalid params: title is required and must be a string" })
	})

	it("throws invalidParams for an unknown sessionId", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		await agent.initialize({ protocolVersion: 1 })

		await expect(
			agent.extMethod(AVAILABLE_EXT_METHODS.set_session_title, { sessionId: "sess-2", title: "My Session" }),
		).rejects.toMatchObject({ code: -32602, message: "Invalid params: unknown sessionId sess-2" })
	})

	it("throws invalidParams for a title that's too long", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		await agent.initialize({ protocolVersion: 1 })
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })

		await expect(
			agent.extMethod(AVAILABLE_EXT_METHODS.set_session_title, { sessionId: "sess-1", title: "a".repeat(300) }),
		).rejects.toMatchObject({
			code: -32602,
			message: "Invalid params: title must be no longer than 256 characters (received: 300)",
		})
	})

	it("advertises set_session_title in initialize response", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = makeAgent(session)
		const response = await agent.initialize({ protocolVersion: 1 })
		const meta = response.agentCapabilities?._meta?.["kimchi.dev"] as Record<string, boolean> | undefined
		expect(meta?.set_session_title).toBe(true)
	})
})
