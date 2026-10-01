import { afterEach, describe, expect, it } from "vitest"
import type { StatusSnapshot } from "../../../extensions/status/snapshot.js"
import { BaseFakeAgentSession, makeAcpConn, makeAcpSessionFactory } from "../__mocks__/fake-agent-session.js"
import { AVAILABLE_EXT_METHODS } from "../capabilities.js"
import { KimchiAcpAgent } from "../server.js"
import { registerStatusProvider, unregisterStatusProvider } from "../status-provider-registry.js"
import { handleSessionStatus } from "./session-status.js"

class FakeAgentSession extends BaseFakeAgentSession {}

function fakeSnapshot(): StatusSnapshot {
	return {
		version: "1.2.3",
		login: { method: "none" },
		session: { id: "sess-1", cwd: "/tmp" },
		model: { provider: "kimchi-dev", id: "kimi-k3", isAuto: false },
	}
}

describe("handleSessionStatus", () => {
	const providers = new Map<string, () => StatusSnapshot>()
	const getProvider = (sessionId: string) => providers.get(sessionId)

	afterEach(() => {
		providers.clear()
	})

	it("returns the snapshot gathered by the session's registered provider", () => {
		providers.set("sess-1", fakeSnapshot)

		expect(handleSessionStatus(getProvider, { sessionId: "sess-1" })).toEqual(fakeSnapshot())
	})

	it("evaluates the provider per call (pull-only freshness)", () => {
		const snapshot = fakeSnapshot()
		providers.set("sess-1", () => snapshot)

		expect(handleSessionStatus(getProvider, { sessionId: "sess-1" })).toMatchObject({
			login: { method: "none" },
		})

		snapshot.login = { method: "kimchi_account" }
		expect(handleSessionStatus(getProvider, { sessionId: "sess-1" })).toMatchObject({
			login: { method: "kimchi_account" },
		})
	})

	it.each([
		{},
		{ sessionId: "" },
		{ sessionId: 42 },
	])("throws invalidParams when sessionId is missing, empty, or not a string: %j", (params) => {
		expect(() => handleSessionStatus(getProvider, params)).toThrowError(
			expect.objectContaining({
				code: -32602,
				message: "Invalid params: sessionId is required and must be a non-empty string",
			}),
		)
	})

	it("throws invalidParams for an unknown or expired sessionId", () => {
		expect(() => handleSessionStatus(getProvider, { sessionId: "sess-9" })).toThrowError(
			expect.objectContaining({ code: -32602, message: "Invalid params: unknown sessionId sess-9" }),
		)
	})
})

describe("KimchiAcpAgent extMethod session_status dispatch", () => {
	afterEach(() => {
		unregisterStatusProvider("sess-1")
	})

	it("routes over extMethod to the registry gatherer and surfaces invalidParams", async () => {
		const session = new FakeAgentSession("sess-1")
		const agent = new KimchiAcpAgent(makeAcpConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: makeAcpSessionFactory(session),
		})
		await agent.initialize({ protocolVersion: 1 })
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		registerStatusProvider("sess-1", fakeSnapshot)

		const result = await agent.extMethod(AVAILABLE_EXT_METHODS.session_status, { sessionId: "sess-1" })
		expect(result).toEqual(fakeSnapshot())

		await expect(agent.extMethod(AVAILABLE_EXT_METHODS.session_status, { sessionId: "sess-2" })).rejects.toMatchObject({
			code: -32602,
			message: "Invalid params: unknown sessionId sess-2",
		})
	})
})
