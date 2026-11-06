/**
 * Regression coverage for `_kimchi.dev/side_chat_send_to_main` on a re-bound
 * ACP session (client restart → session/load): the user message the side chat
 * injects via pi.sendUserMessage must reach the client as a
 * `user_message_chunk`, and the assistant turn must stream the same
 * `agent_message_chunk`s a composer-typed prompt would produce. Before the
 * fix the injected message was never echoed (only prompt-owned turns, queue
 * reconciles and replays ever emitted user_message_chunk), so a client that
 * binds a fresh session saw nothing of the whole turn rendered.
 */

import type { SessionNotification } from "@agentclientprotocol/sdk"
import type { AgentSession, AgentSessionEvent, ExtensionContext, ResourceLoader } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SideChatAcpBridge } from "../../extensions/side-chat/acp-bridge.js"
import type { SideChatDeps } from "../../extensions/side-chat/controller.js"
import { registerSideChatBridge, resetSideChatBridges } from "../../extensions/side-chat/registry.js"
import type { SideChatSession } from "../../extensions/side-chat/session.js"
import type { SideThread } from "../../extensions/side-chat/store.js"

vi.mock("../../extensions/side-chat/session.js", () => ({
	SIDE_CHAT_TOOLS: ["read", "grep", "find", "ls"],
	createSideSession: vi.fn(),
	draftSteeringPrompt: vi.fn(),
	sideThreadMessages: (side: { contextLength: number; session: { messages: SideThread } }) =>
		side.session.messages.slice(side.contextLength),
}))

const resourceGate = vi.hoisted(() => ({ enabled: true }))

vi.mock("../../resources/store.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../resources/store.js")>()
	return {
		...actual,
		isResourceEnabled: vi.fn(() => resourceGate.enabled),
	}
})

import { createSideSession } from "../../extensions/side-chat/session.js"
import { handleSideChatSendToMain } from "./ext-methods/side-chat.js"
import { type AcpSessionLoader, KimchiAcpAgent } from "./server.js"

const createSideSessionMock = vi.mocked(createSideSession)

/** Main-session fake with a real event emitter, so the server's subscribe sees turns. */
class FakeMainSession {
	readonly sessionId: string
	disposed = false
	model = { provider: "test", id: "test-model" }
	modelRegistry = {
		getAvailable: () => [{ provider: "test", id: "test-model", name: "Test" }],
		find: (provider: string, id: string) =>
			this.modelRegistry.getAvailable().find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: (_model: { provider: string }) => true,
	}
	sessionManager = {
		getBranch: () => [],
		getSessionId: () => this.sessionId,
		getEntries: () => [],
		getSessionDir: () => "/tmp",
		getCwd: () => "/tmp",
		getLeafId: () => null,
		getSessionFile: () => undefined,
		appendCustomEntry: () => "entry-id",
	}
	resourceLoader = {
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getExtensions: () => ({ extensions: [], errors: [], runtime: undefined }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	} as unknown as ResourceLoader
	extensionRunner = { emit: async () => {} }
	private readonly listeners = new Set<(event: AgentSessionEvent) => void>()

	constructor(sessionId: string) {
		this.sessionId = sessionId
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}

	emit(event: AgentSessionEvent): void {
		for (const listener of [...this.listeners]) listener(event)
	}

	promptImpl: (text: string) => Promise<void> = async () => {}

	async prompt(text: string): Promise<void> {
		await this.promptImpl(text)
	}

	async abort(): Promise<void> {}
	async waitForIdle(): Promise<void> {}
	async bindExtensions(): Promise<void> {}
	async extendResourcesFromExtensions(): Promise<void> {}
	getToolDefinition(): undefined {
		return undefined
	}
	getActiveToolNames(): string[] {
		return ["read", "bash"]
	}
	setActiveToolsByName(): void {}
	getSteeringMessages(): readonly string[] {
		return []
	}
	getContextUsage(): undefined {
		return undefined
	}
	dispose(): void {
		this.disposed = true
		this.listeners.clear()
	}
}

function userMessage(text: string) {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() }
}

function assistantMessage(text: string) {
	return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }
}

/** Mirror pi-mono's event sequence for a sendUserMessage-driven turn on an idle session. */
function emitInjectedTurn(session: FakeMainSession, text: string, reply: string): void {
	session.emit({ type: "message_start", message: userMessage(text) } as unknown as AgentSessionEvent)
	session.emit({ type: "message_end", message: userMessage(text) } as unknown as AgentSessionEvent)
	session.emit({ type: "agent_start" } as unknown as AgentSessionEvent)
	session.emit({
		type: "message_start",
		message: { role: "assistant", content: [{ type: "text", text: "" }] },
	} as unknown as AgentSessionEvent)
	session.emit({
		type: "message_update",
		message: { role: "assistant", content: [{ type: "text", text: reply }] },
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: reply },
	} as unknown as AgentSessionEvent)
	session.emit({ type: "message_end", message: assistantMessage(reply) } as unknown as AgentSessionEvent)
	session.emit({ type: "agent_end", messages: [], willRetry: false } as unknown as AgentSessionEvent)
	session.emit({ type: "agent_settled" } as unknown as AgentSessionEvent)
}

/** Inert side session: send_to_main never touches it, but open() requires one. */
function fakeSideSession(): SideChatSession {
	const session = {
		messages: [] as SideThread,
		isStreaming: false,
		subscribe: () => () => {},
		abort: async () => {},
		dispose: () => {},
	}
	return { session: session as unknown, contextLength: 0 } as SideChatSession
}

function makeBridgeCtx(session: FakeMainSession): ExtensionContext {
	return {
		cwd: "/tmp",
		isIdle: () => true,
		sessionManager: {
			...session.sessionManager,
			getLeafId: () => null,
			getSessionFile: () => undefined,
		},
	} as unknown as ExtensionContext
}

function updateNames(updates: SessionNotification[]): string[] {
	return updates.map((u) => u.update.sessionUpdate)
}

function userChunkTexts(updates: SessionNotification[]): string[] {
	return updates.flatMap((u) =>
		u.update.sessionUpdate === "user_message_chunk" && u.update.content.type === "text" ? [u.update.content.text] : [],
	)
}

function agentChunkTexts(updates: SessionNotification[]): string[] {
	return updates.flatMap((u) =>
		u.update.sessionUpdate === "agent_message_chunk" && u.update.content.type === "text" ? [u.update.content.text] : [],
	)
}

describe("side_chat send_to_main on a re-bound ACP session", () => {
	let session: FakeMainSession
	let agent: KimchiAcpAgent
	let updates: SessionNotification[]
	let sessionId: string
	let bridge: SideChatAcpBridge
	// Side-chat updates the server relays as ext notifications; kept to prove
	// the side chat itself opened and closed on the new binding.
	let extNotifications: Array<{ method: string; params: unknown }>

	beforeEach(async () => {
		vi.clearAllMocks()
		resourceGate.enabled = true
		createSideSessionMock.mockResolvedValue(fakeSideSession())

		sessionId = "rebound-1"
		session = new FakeMainSession(sessionId)
		const sessionLoader: AcpSessionLoader = async () => session as unknown as AgentSession
		updates = []
		extNotifications = []
		const conn = {
			sessionUpdate: async (p: SessionNotification) => {
				updates.push(p)
			},
			extNotification: async (method: string, params: unknown) => {
				extNotifications.push({ method, params })
			},
			requestPermission: vi.fn().mockResolvedValue({ outcome: "cancelled" }),
		}
		agent = new KimchiAcpAgent(conn as never, {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionLoader,
		})
		// The re-bound path: a freshly booted server attaches to the persisted session.
		await agent.loadSession({ sessionId, cwd: "/tmp", mcpServers: [] })

		const deps: SideChatDeps = {
			appendEntry: () => {},
			sendUserMessage: (text) => emitInjectedTurn(session, text, "wrapped answer"),
			getThinkingLevel: () => "off",
			notify: () => {},
		}
		bridge = new SideChatAcpBridge(makeBridgeCtx(session), deps)
		// The extension's session_start registers the bridge on the new binding.
		registerSideChatBridge(sessionId, bridge)
	})

	afterEach(() => {
		resetSideChatBridges()
	})

	it("streams the injected message and the reply to the new client", async () => {
		await bridge.open({})
		await handleSideChatSendToMain({ sessionId, text: "ship the wrap draft" })

		expect(userChunkTexts(updates)).toEqual(["ship the wrap draft"])
		expect(agentChunkTexts(updates)).toContain("wrapped answer")
	})

	it("emits the user_message_chunk before the assistant turn's chunks", async () => {
		await bridge.open({})
		await handleSideChatSendToMain({ sessionId, text: "ordering matters" })

		const names = updateNames(updates)
		expect(names.indexOf("user_message_chunk")).toBeGreaterThanOrEqual(0)
		expect(names.indexOf("user_message_chunk")).toBeLessThan(names.indexOf("agent_message_chunk"))
	})

	it("does not double-echo a steer that the queue reconcile already announced", async () => {
		// An unsolicited run is streaming; the steer is queued, then consumed —
		// pi-mono emits queue_update (consumption) immediately before the
		// delivered message's message_start.
		session.emit({ type: "agent_start" } as unknown as AgentSessionEvent)
		session.emit({ type: "queue_update", steering: ["steer now"], followUp: [] } as unknown as AgentSessionEvent)
		session.emit({ type: "queue_update", steering: [], followUp: [] } as unknown as AgentSessionEvent)
		session.emit({ type: "message_start", message: userMessage("steer now") } as unknown as AgentSessionEvent)

		expect(userChunkTexts(updates).filter((text) => text === "steer now")).toHaveLength(1)
	})

	it("never echoes the user text of a composer-typed prompt", async () => {
		session.promptImpl = async (text) => {
			emitInjectedTurn(session, text, "composer reply")
		}
		await agent.prompt({ sessionId, prompt: [{ type: "text", text: "typed in the composer" }] })

		expect(userChunkTexts(updates)).toEqual([])
		expect(agentChunkTexts(updates)).toContain("composer reply")
	})
})
