import {
	agent,
	type ClientConnection,
	client,
	methods,
	PROTOCOL_VERSION,
	type SessionNotification,
	type SessionUpdate,
} from "@agentclientprotocol/sdk/unstable"
import { afterEach, describe, expect, it } from "vitest"

// These checks validate the native unstable v1 shapes only. They deliberately
// advertise no subagent capability and do not start or enable subagent runtime.
describe("ACP v1 unstable subagent protocol shapes", () => {
	let connection: ClientConnection | undefined

	afterEach(() => {
		connection?.close()
		connection = undefined
	})

	it("round-trips child directories, session tool content, and directed messages without advertising subagents", async () => {
		const received: SessionNotification[] = []
		let newSessionParams: unknown
		const agentApp = agent()
			.onRequest(methods.agent.initialize, (request) => ({
				protocolVersion: request.params.protocolVersion,
				agentCapabilities: {},
			}))
			.onRequest(methods.agent.session.new, async ({ params, client: peer }) => {
				newSessionParams = params
				const updates: SessionUpdate[] = [
					{
						sessionUpdate: "subagent_update",
						sessionId: "child-session",
						cwd: "/tmp/child-session",
						additionalDirectories: [],
					},
					{
						sessionUpdate: "tool_call",
						toolCallId: "call-child",
						title: "Run child session",
						status: "completed",
						content: [{ type: "session", sessionId: "child-session" }],
					},
					{
						sessionUpdate: "session_message",
						messageId: "directed-message",
						senderSessionId: "parent-session",
						recipientSessionId: "child-session",
					},
					{
						sessionUpdate: "session_message_chunk",
						messageId: "directed-message",
						content: { type: "text", text: "investigate the failing test" },
					},
				]
				for (const update of updates) {
					await peer.notify(methods.client.session.update, { sessionId: "parent-session", update })
				}
				return { sessionId: "parent-session" }
			})
		const clientApp = client().onNotification(methods.client.session.update, ({ params }) => {
			received.push(params)
		})
		connection = clientApp.connect(agentApp)
		const peer = connection.agent

		const initialized = await peer.request(methods.agent.initialize, {
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: {},
		})
		expect(initialized.protocolVersion).toBe(PROTOCOL_VERSION)
		expect(initialized.agentCapabilities).toEqual({})
		expect(initialized.agentCapabilities).not.toHaveProperty("subagents")

		const created = await peer.request(methods.agent.session.new, {
			cwd: "/tmp/parent-session",
			additionalDirectories: [],
			mcpServers: [],
		})
		expect(created.sessionId).toBe("parent-session")
		expect(newSessionParams).toMatchObject({ cwd: "/tmp/parent-session", additionalDirectories: [] })
		expect(received.map(({ update }) => update)).toEqual([
			{
				sessionUpdate: "subagent_update",
				sessionId: "child-session",
				cwd: "/tmp/child-session",
				additionalDirectories: [],
			},
			{
				sessionUpdate: "tool_call",
				toolCallId: "call-child",
				title: "Run child session",
				status: "completed",
				content: [{ type: "session", sessionId: "child-session" }],
			},
			{
				sessionUpdate: "session_message",
				messageId: "directed-message",
				senderSessionId: "parent-session",
				recipientSessionId: "child-session",
			},
			{
				sessionUpdate: "session_message_chunk",
				messageId: "directed-message",
				content: { type: "text", text: "investigate the failing test" },
			},
		])
	})
})
