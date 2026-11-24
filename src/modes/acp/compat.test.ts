// Regression tests for the legacy Kimchi compatibility surface on ACP v1.
//
// Upstream removed model selectors from the schema (the `session/set_model`
// wire method and the `models` field on session/new + session/load responses)
// in favor of configOptions. Clients built against the 0.19-era surface
// (Zed, Kimchi Studio, the VS Code extension) still depend on them, so this
// suite pins the compat surface at two levels:
//
//   1. extMethod dispatch — raw `session/set_model` requests reach the same
//      implementation as session/set_config_option.
//   2. Wire level — a real agent()/client() loopback proves session responses
//      stay on the schema surface (no legacy `models` key; the spec forbids
//      custom root fields), and that `session/set_model` succeeds over the wire.

import { PassThrough, Readable, Writable } from "node:stream"
import {
	AGENT_METHODS,
	type AgentContext,
	agent,
	type ClientConnection,
	type ClientContext,
	client as createClient,
	methods,
	ndJsonStream,
	PROTOCOL_VERSION,
	RequestError,
	type Stream,
} from "@agentclientprotocol/sdk/unstable"
import type { AgentSession } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { BaseFakeAgentSession } from "./__mocks__/fake-agent-session.js"
import { KimchiAcpAgent, registerAcpAgentHandlers } from "./server.js"

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

function makeAgent(fake: BaseFakeAgentSession, conn: AgentContext): KimchiAcpAgent {
	return new KimchiAcpAgent(conn, {
		extensionFactories: [],
		agentDir: "/tmp/fake-agent-dir",
		sessionFactory: async () => asSession(fake),
	})
}

function stubConn(): AgentContext {
	return {
		notify: async (_method: string, _params: unknown) => {},
		request: async (method: string) => {
			if (method === methods.client.session.requestPermission) {
				return { outcome: { outcome: "cancelled" } }
			}
			throw new Error(`Unexpected client request: ${method}`)
		},
	} as unknown as AgentContext
}

describe("ACP handler registration", () => {
	it("tracks supported methods and deliberately unsupported SDK methods", () => {
		const supportedRequests: string[] = [
			AGENT_METHODS.initialize,
			AGENT_METHODS.authenticate,
			AGENT_METHODS.logout,
			AGENT_METHODS.session_new,
			AGENT_METHODS.session_load,
			AGENT_METHODS.session_list,
			AGENT_METHODS.session_resume,
			AGENT_METHODS.session_close,
			AGENT_METHODS.session_set_config_option,
			AGENT_METHODS.session_prompt,
		]
		const supportedNotifications: string[] = [AGENT_METHODS.session_cancel]
		const unsupportedRequests: string[] = [
			AGENT_METHODS.providers_list,
			AGENT_METHODS.providers_set,
			AGENT_METHODS.providers_disable,
			AGENT_METHODS.session_set_mode,
			AGENT_METHODS.session_delete,
			AGENT_METHODS.session_fork,
			AGENT_METHODS.session_archive,
			AGENT_METHODS.session_unarchive,
			AGENT_METHODS.session_status,
			AGENT_METHODS.session_options,
			AGENT_METHODS.session_set_title,
			AGENT_METHODS.auth_status,
		]
		const unsupportedNotifications: string[] = [AGENT_METHODS.mcp_message]
		const classified = [
			...supportedRequests,
			...unsupportedRequests,
			...supportedNotifications,
			...unsupportedNotifications,
		]
		const registry = Object.values(AGENT_METHODS)
		const unclassified = registry.filter((method) => !classified.includes(method))
		expect(unclassified).toEqual([])
		expect(classified).toHaveLength(registry.length)
		expect(new Set(classified).size).toBe(classified.length)

		const app = agent()
		const requests = vi.spyOn(app, "onRequest").mockReturnThis()
		const notifications = vi.spyOn(app, "onNotification").mockReturnThis()
		const getAgent = vi.fn(() => {
			throw new Error("Agent lookup must remain lazy during registration")
		})
		registerAcpAgentHandlers(app, getAgent)

		expect(getAgent).not.toHaveBeenCalled()
		expect(requests.mock.calls.map(([method]) => method)).toEqual([...supportedRequests, "*"])
		expect(notifications.mock.calls.map(([method]) => method)).toEqual([...supportedNotifications, "*"])
	})
})

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
	let connection: ClientConnection | undefined

	afterEach(() => {
		connection?.close()
		connection = undefined
	})

	function wireUp(fake: BaseFakeAgentSession): ClientContext {
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
		let kimchi: KimchiAcpAgent
		const agentApp = agent()
			.onConnect(({ client }) => {
				kimchi = makeAgent(fake, client)
			})
			.onRequest(methods.agent.initialize, ({ params }) => kimchi.initialize(params))
			.onRequest(methods.agent.session.new, ({ params }) => kimchi.newSession(params))
			.onRequest(
				"session/set_model",
				(params) => params,
				({ params }) => {
					if (!params || typeof params !== "object" || Array.isArray(params)) {
						throw RequestError.invalidParams("expected an object")
					}
					return kimchi.extMethod("session/set_model", params as Record<string, unknown>)
				},
			)
		agentApp.connect(agentStream)
		const clientApp = createClient()
			.onNotification(methods.client.session.update, () => {})
			.onRequest(methods.client.session.requestPermission, () => ({
				outcome: { outcome: "cancelled" as const },
			}))
		connection = clientApp.connect(clientStream)
		return connection.agent
	}

	it("session/new response stays on the schema surface (no legacy `models` key)", async () => {
		// Protocol compatibility: custom root fields on spec types are forbidden,
		// `_meta` is the extensibility channel. The legacy top-level `models`
		// field was dropped; both Studio and the VS Code extension read the
		// model catalogue from the `model` config option instead.
		const fake = new CompatFakeSession("wire-session")
		const client = wireUp(fake)

		const init = await client.request(methods.agent.initialize, {
			protocolVersion: PROTOCOL_VERSION,
			clientCapabilities: {},
		})
		expect(init.agentInfo?.name).toBe("kimchi")

		const response = (await client.request(methods.agent.session.new, {
			cwd: "/tmp",
			mcpServers: [],
		})) as unknown as Record<string, unknown>
		expect(response.sessionId).toBe("wire-session")
		expect(response).not.toHaveProperty("models")
		expect(response.configOptions).toBeDefined()
	})

	it("session/set_model succeeds over the wire for old clients", async () => {
		const fake = new CompatFakeSession("wire-set-model-session")
		const client = wireUp(fake)

		await client.request(methods.agent.initialize, { protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
		const { sessionId } = await client.request(methods.agent.session.new, { cwd: "/tmp", mcpServers: [] })
		expect(sessionId).toBe("wire-set-model-session")

		const result = await client.request("session/set_model", {
			sessionId,
			modelId: "test/test-model",
		})
		expect(result).toEqual({})
	})
})
