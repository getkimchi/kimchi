// Regression tests for the 0.19.2 → 1.9.0 SDK migration.
//
// Upstream removed model selectors from the schema (the `session/set_model`
// wire method and the `models` field on session/new + session/load responses)
// in favor of configOptions. Clients built against the 0.19-era surface
// (Zed, Kimchi Studio, the VS Code extension) still depend on them, so this
// suite pins the compat surface at two levels:
//
//   1. extMethod dispatch — raw `session/set_model` requests reach the same
//      implementation as session/set_config_option.
//   2. Wire level — a real AgentSideConnection/ClientSideConnection loopback
//      proves session responses stay on the schema surface (no legacy
//      `models` key; the spec forbids custom root fields), and that
//      `session/set_model` succeeds over the wire.

import { PassThrough, Readable, Writable } from "node:stream"
import {
	AgentSideConnection,
	ClientSideConnection,
	ndJsonStream,
	PROTOCOL_VERSION,
	type Stream,
} from "@agentclientprotocol/sdk"
import type { AgentSession } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it } from "vitest"
import { BaseFakeAgentSession } from "./__mocks__/fake-agent-session.js"
import { KimchiAcpAgent } from "./server.js"

// BaseFakeAgentSession deliberately omits setModel/clearQueue (suites extend
// it for their own needs); the set-model and close-session compat paths
// exercise both.
class CompatFakeSession extends BaseFakeAgentSession {
	setModel = async (model: { provider: string; id: string }) => {
		this.model = model
	}
	clearQueue = () => ({ steering: [] as string[], followUp: [] as string[] })
}

function asSession(fake: BaseFakeAgentSession): AgentSession {
	return fake as unknown as AgentSession
}

function makeAgent(fake: BaseFakeAgentSession, conn: AgentSideConnection): KimchiAcpAgent {
	return new KimchiAcpAgent(conn, {
		extensionFactories: [],
		agentDir: "/tmp/fake-agent-dir",
		sessionFactory: async () => asSession(fake),
	})
}

function stubConn(): AgentSideConnection {
	return {
		sessionUpdate: async (_p: unknown) => {},
		extNotification: async (_m: string, _p: unknown) => {},
		requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
	} as unknown as AgentSideConnection
}

describe("session/set_model compat", () => {
	it("routes raw session/set_model requests through extMethod into the set-model implementation", async () => {
		const fake = new CompatFakeSession("switch-session")
		fake.modelRegistry = {
			...fake.modelRegistry,
			getAvailable: () => [
				{ provider: "provider-a", id: "model-a", name: "Model A" },
				{ provider: "provider-b", id: "model-b", name: "Model B" },
			],
		}
		fake.model = { provider: "provider-a", id: "model-a" }
		const agent = makeAgent(fake, stubConn())
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })

		const res = await agent.extMethod("session/set_model", {
			sessionId: "switch-session",
			modelId: "provider-b/model-b",
		})
		expect(res).toEqual({})
		expect(fake.model).toMatchObject({ provider: "provider-b", id: "model-b" })
	})

	it("rejects raw session/set_model requests missing sessionId", async () => {
		const agent = makeAgent(new CompatFakeSession("s"), stubConn())
		await expect(agent.extMethod("session/set_model", { modelId: "test/test-model" })).rejects.toThrow(
			/sessionId is required/,
		)
	})

	it("rejects raw session/set_model requests missing modelId", async () => {
		const agent = makeAgent(new CompatFakeSession("s"), stubConn())
		await expect(agent.extMethod("session/set_model", { sessionId: "s" })).rejects.toThrow(/modelId is required/)
	})

	it("unstable_closeSession alias delegates to closeSession", async () => {
		const fake = new CompatFakeSession("close-session")
		const agent = makeAgent(fake, stubConn())
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		await expect(agent.unstable_closeSession({ sessionId: "close-session" })).resolves.toEqual({})
	})
})

describe("wire compat", () => {
	let client: ClientSideConnection | undefined

	afterEach(async () => {
		// ClientSideConnection has no close(); dropping the reference lets the
		// in-process streams be GC'd after each test.
		client = undefined
	})

	function wireUp(fake: BaseFakeAgentSession): ClientSideConnection {
		const agentToClient = new PassThrough()
		const clientToAgent = new PassThrough()
		const agentStream: Stream = ndJsonStream(
			Writable.toWeb(agentToClient) as WritableStream<Uint8Array>,
			Readable.toWeb(clientToAgent) as ReadableStream<Uint8Array>,
		)
		const clientStream: Stream = ndJsonStream(
			Writable.toWeb(clientToAgent) as WritableStream<Uint8Array>,
			Readable.toWeb(agentToClient) as ReadableStream<Uint8Array>,
		)
		new AgentSideConnection(
			(conn) =>
				new KimchiAcpAgent(conn, {
					extensionFactories: [],
					agentDir: "/tmp/fake-agent-dir",
					sessionFactory: async () => asSession(fake),
				}),
			agentStream,
		)
		return new ClientSideConnection(
			() => ({
				sessionUpdate: async () => {},
				requestPermission: async () => ({ outcome: { outcome: "cancelled" as const } }),
			}),
			clientStream,
		)
	}

	it("session/new response stays on the schema surface (no legacy `models` key)", async () => {
		// Protocol compatibility: custom root fields on spec types are forbidden,
		// `_meta` is the extensibility channel. The legacy top-level `models`
		// field was dropped; both Studio and the VS Code extension read the
		// model catalogue from the `model` config option instead.
		const fake = new CompatFakeSession("wire-session")
		client = wireUp(fake)

		const init = await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
		expect(init.agentInfo?.name).toBe("kimchi")

		const response = (await client.newSession({ cwd: "/tmp", mcpServers: [] })) as unknown as Record<string, unknown>
		expect(response.sessionId).toBe("wire-session")
		expect(response).not.toHaveProperty("models")
		expect(response.configOptions).toBeDefined()
	})

	it("session/set_model succeeds over the wire for old clients", async () => {
		const fake = new CompatFakeSession("wire-set-model-session")
		client = wireUp(fake)

		await client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
		const { sessionId } = await client.newSession({ cwd: "/tmp", mcpServers: [] })
		expect(sessionId).toBe("wire-set-model-session")

		const result = await client.extMethod("session/set_model", {
			sessionId,
			modelId: "test/test-model",
		})
		expect(result).toEqual({})
	})
})
