import type { AgentContext, ClientCapabilities, SessionNotification } from "@agentclientprotocol/sdk/unstable"
import type { AgentSessionEvent, AgentSessionEventListener } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { asSession, BaseFakeAgentSession } from "./__mocks__/fake-agent-session.js"
import { KimchiAcpAgent } from "./server.js"
import {
	absoluteSubagentCwd,
	clientSupportsSubagents,
	parseSubagentSessionCreated,
	presentAgentToolCall,
	type SubagentSessionCreatedEvent,
	subagentPromptMessages,
	subagentSessionCreatedExtension,
	withSubagentSessionLink,
} from "./subagents.js"
import { buildToolCall } from "./tool-calls/utils.js"

class ProjectionFakeSession extends BaseFakeAgentSession {
	private listeners = new Set<AgentSessionEventListener>()

	constructor(sessionId: string, cwd = "/tmp") {
		super(sessionId)
		this.sessionManager.getCwd = () => cwd
	}

	subscribe = (listener?: AgentSessionEventListener): (() => void) => {
		if (listener) this.listeners.add(listener)
		return () => {
			if (listener) this.listeners.delete(listener)
		}
	}

	getContextUsage = () => undefined
	clearQueue = () => ({ steering: [], followUp: [] })

	emit(event: AgentSessionEvent): void {
		for (const listener of [...this.listeners]) listener(event)
	}
}

const nativeSessions = new Map<string, ReturnType<typeof asSession>>()

function recordingConnection(): { conn: AgentContext; updates: SessionNotification[]; extensions: unknown[] } {
	const updates: SessionNotification[] = []
	const extensions: unknown[] = []
	return {
		conn: {
			notify: vi.fn(async (method: string, params: unknown) => {
				if (method === "session/update") updates.push(params as SessionNotification)
				else extensions.push({ method, params })
			}),
			request: vi.fn(),
		} as unknown as AgentContext,
		updates,
		extensions,
	}
}

function setCapabilities(agent: KimchiAcpAgent, capabilities: ClientCapabilities | undefined): void {
	Reflect.set(agent, "clientCapabilities", capabilities)
}

function createChild(agent: KimchiAcpAgent, event: SubagentSessionCreatedEvent): void {
	const receiver = agent as unknown as { onSubagentSessionCreated(event: SubagentSessionCreatedEvent): void }
	receiver.onSubagentSessionCreated(event)
}

async function createRoot(
	id: string,
	capabilities: ClientCapabilities | undefined = { subagents: {} } as ClientCapabilities,
): Promise<{
	agent: KimchiAcpAgent
	root: ProjectionFakeSession
	updates: SessionNotification[]
	extensions: unknown[]
}> {
	const root = new ProjectionFakeSession(id, "/workspace/root")
	const { conn, updates, extensions } = recordingConnection()
	const agent = new KimchiAcpAgent(conn, {
		extensionFactories: [],
		agentDir: "/tmp/acp-subagent-tests",
		sessionFactory: async () => asSession(root),
		subagentSessionResolver: (agentId) => nativeSessions.get(agentId),
	})
	setCapabilities(agent, capabilities)
	await agent.newSession({ cwd: "/workspace/root", mcpServers: [] })
	updates.length = 0
	extensions.length = 0
	return { agent, root, updates, extensions }
}

function childEvent(
	parentSessionId: string,
	session: ProjectionFakeSession,
	overrides: Partial<SubagentSessionCreatedEvent> = {},
): SubagentSessionCreatedEvent {
	const agentId = `run-${session.sessionId}`
	nativeSessions.set(agentId, asSession(session))
	return {
		agentId,
		sessionId: session.sessionId,
		parentSessionId,
		toolCallId: "provider-agent-call",
		prompt: "Investigate the complete original prompt.\nKeep every line.",
		description: "Investigate the delegated task",
		cwd: "/workspace/root/.worktrees/child",
		visibility: "user",
		remote: false,
		status: "running",
		background: false,
		...overrides,
	}
}

function update(notification: SessionNotification): Record<string, unknown> {
	return notification.update as unknown as Record<string, unknown>
}

/** Consumer-side reconstruction: upserts replace content and chunks append. */
function reconstructMessageText(
	updates: SessionNotification[],
	messages = new Map<string, string>(),
): Map<string, string> {
	for (const { update } of updates) {
		if (update.sessionUpdate === "session_message") {
			const text = (update.content ?? [])
				.flatMap((block) => (block.type === "text" ? [block.text] : []))
				.join("")
			messages.set(update.messageId, text)
		} else if (update.sessionUpdate === "session_message_chunk" && update.content.type === "text") {
			messages.set(update.messageId, `${messages.get(update.messageId) ?? ""}${update.content.text}`)
		}
	}
	return messages
}

function assistant(text: string): Record<string, unknown> {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test-model",
		usage: undefined,
		stopReason: "stop",
		timestamp: Date.now(),
	}
}

function streamChild(session: ProjectionFakeSession, text: string): void {
	const message = assistant(text)
	session.emit({ type: "agent_start" } as AgentSessionEvent)
	session.emit({ type: "message_start", message } as unknown as AgentSessionEvent)
	session.emit({
		type: "message_update",
		message,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: message },
	} as unknown as AgentSessionEvent)
	session.emit({ type: "message_end", message } as unknown as AgentSessionEvent)
	session.emit({ type: "agent_settled" } as AgentSessionEvent)
}

describe("subagent event parsing and capability gate", () => {
	it("treats a non-null subagents capability as opt-in and null or absence as opt-out", () => {
		expect(clientSupportsSubagents({ subagents: {} } as ClientCapabilities)).toBe(true)
		expect(clientSupportsSubagents({ subagents: null } as unknown as ClientCapabilities)).toBe(false)
		expect(clientSupportsSubagents({} as ClientCapabilities)).toBe(false)
		expect(clientSupportsSubagents(undefined)).toBe(false)
	})

	it("parses the partner payload defensively without dropping the native session", () => {
		const session = new ProjectionFakeSession("native")
		const event = childEvent("parent", session)
		expect(parseSubagentSessionCreated(event)).toEqual(event)
		expect(parseSubagentSessionCreated(undefined)).toBeUndefined()
		expect(parseSubagentSessionCreated({ ...event, sessionId: 42 })).toBeUndefined()
		expect(parseSubagentSessionCreated({ ...event, remote: "no" })).toBeUndefined()
	})

	it("registers on the existing inline event bus and forwards only valid events", () => {
		let listener: ((payload: unknown) => void) | undefined
		const on = vi.fn((name: string, callback: (payload: unknown) => void) => {
			expect(name).toBe("subagents:session_created")
			listener = callback
		})
		const received: SubagentSessionCreatedEvent[] = []
		const extension = subagentSessionCreatedExtension((event) => received.push(event))
		if (typeof extension !== "function") throw new Error("expected an inline extension function")
		extension({ events: { on } } as never)
		const event = childEvent("parent", new ProjectionFakeSession("native"))
		listener?.({ invalid: true })
		listener?.(event)
		expect(received).toEqual([event])
	})
})

describe("subagent registry and child projection", () => {
	const agents: KimchiAcpAgent[] = []
	afterEach(async () => {
		for (const agent of agents.splice(0)) await agent.shutdown()
	})

	it("announces before messages and child events, uses native child identity, and keeps routes unreadable directly", async () => {
		const { agent, updates } = await createRoot("parent")
		agents.push(agent)
		const child = new ProjectionFakeSession("native-child")
		const event = childEvent("parent", child)
		createChild(agent, event)

		expect(updates).toHaveLength(4)
		expect(updates[0]?.sessionId).toBe("parent")
		expect(update(updates[0] as SessionNotification)).toMatchObject({
			sessionUpdate: "subagent_update",
			sessionId: "native-child",
			cwd: "/workspace/root/.worktrees/child",
			additionalDirectories: [],
			capabilities: {},
			state: { state: "running" },
		})
		expect(update(updates[0] as SessionNotification).capabilities).not.toHaveProperty("cancel")
		expect(update(updates[1] as SessionNotification)).toMatchObject({
			sessionUpdate: "session_message",
			senderSessionId: "parent",
			recipientSessionId: "native-child",
		})
		expect(updates[2]?.sessionId).toBe("native-child")
		expect(update(updates[3] as SessionNotification)).toMatchObject({
			sessionUpdate: "session_message_chunk",
			content: { type: "text", text: "Investigate the complete original prompt.\nKeep every line." },
		})
		const parentMessage = update(updates[1] as SessionNotification)
		const childMessage = update(updates[2] as SessionNotification)
		expect(parentMessage.recipientMessageId).toBe(childMessage.messageId)
		expect(childMessage.senderMessageId).toBe(parentMessage.messageId)
		expect(parentMessage.messageId).not.toBe(childMessage.messageId)
		const reconstructed = reconstructMessageText(updates.slice(0, 4))
		expect(reconstructed.get(String(parentMessage.messageId))).toBe(event.prompt)
		expect(reconstructed.get(String(childMessage.messageId))).toBe(event.prompt)
		expect(childMessage.content).toEqual([])

		streamChild(child, "child answer")
		expect(
			updates.some((item) => update(item).sessionUpdate === "agent_message_chunk" && item.sessionId === "native-child"),
		).toBe(true)
		expect(update(updates.at(-1) as SessionNotification)).toMatchObject({
			sessionUpdate: "subagent_update",
			sessionId: "native-child",
			state: { state: "idle", stopReason: "end_turn" },
		})
		await expect(agent.prompt({ sessionId: "native-child", prompt: [] })).rejects.toThrow()
	})

	it("emits no child behavior for absent or null client capabilities", async () => {
		for (const [label, capabilities] of [
			["absent", {} as ClientCapabilities],
			["null", { subagents: null } as unknown as ClientCapabilities],
		] as const) {
			const parentId = `parent-${label}`
			const { agent, updates } = await createRoot(parentId, capabilities)
			agents.push(agent)
			createChild(agent, childEvent(parentId, new ProjectionFakeSession(`${label}-child`)))
			expect(updates).toEqual([])
		}
	})

	it("skips system and remote children even for an opted-in client", async () => {
		const { agent, updates } = await createRoot("parent")
		agents.push(agent)
		createChild(agent, childEvent("parent", new ProjectionFakeSession("system-child"), { visibility: "system" }))
		createChild(agent, childEvent("parent", new ProjectionFakeSession("remote-child"), { remote: true }))
		createChild(
			agent,
			childEvent("parent", new ProjectionFakeSession("same-id"), { agentId: "same-id", sessionId: "same-id" }),
		)
		expect(updates).toEqual([])
	})

	it("keeps two roots and interleaved child streams isolated", async () => {
		const roots = [new ProjectionFakeSession("root-a"), new ProjectionFakeSession("root-b")]
		const { conn, updates } = recordingConnection()
		const agent = new KimchiAcpAgent(conn, {
			extensionFactories: [],
			agentDir: "/tmp/acp-subagent-tests",
			sessionFactory: async () => asSession(roots.shift() as ProjectionFakeSession),
			subagentSessionResolver: (agentId) => nativeSessions.get(agentId),
		})
		agents.push(agent)
		setCapabilities(agent, { subagents: {} } as ClientCapabilities)
		await agent.newSession({ cwd: "/workspace/a", mcpServers: [] })
		await agent.newSession({ cwd: "/workspace/b", mcpServers: [] })
		updates.length = 0
		const childA = new ProjectionFakeSession("child-a")
		const childB = new ProjectionFakeSession("child-b")
		createChild(agent, childEvent("root-a", childA, { toolCallId: "a-launch" }))
		createChild(agent, childEvent("root-b", childB, { toolCallId: "b-launch" }))
		streamChild(childA, "A")
		streamChild(childB, "B")
		const childText = updates.filter((item) => update(item).sessionUpdate === "agent_message_chunk")
		expect(childText.map((item) => [item.sessionId, (update(item).content as { text: string }).text])).toEqual([
			["child-a", "A"],
			["child-b", "B"],
		])
		const idle = updates.filter(
			(item) =>
				(update(item).state as { state?: string } | undefined)?.state === "idle" && item.sessionId.startsWith("root-"),
		)
		expect(idle.map((item) => [item.sessionId, update(item).sessionId])).toEqual([
			["root-a", "child-a"],
			["root-b", "child-b"],
		])
	})
})

describe("Agent invocation presentation and native links", () => {
	it("opts Agent into subagent/other without changing its title, ids, or rawInput", () => {
		const rawInput = { description: "x".repeat(100), prompt: "original" }
		const original = buildToolCall({
			toolName: "Agent",
			toolCallId: "kt.Agent.0",
			piToolCallId: "provider-agent-call",
			rawInput,
			status: "in_progress",
		})
		const optedIn = presentAgentToolCall(original, "Agent", true)
		expect(optedIn).toMatchObject({
			name: "subagent",
			kind: "other",
			toolCallId: "kt.Agent.0",
			rawInput,
			title: `${"x".repeat(80)}…`,
		})
		const optedOut = presentAgentToolCall(original, "Agent", false)
		expect(optedOut).not.toHaveProperty("name")
		expect(optedOut).toMatchObject({ kind: "think", rawInput })
		expect(presentAgentToolCall(original, "read", true)).toBe(original)
	})

	it("adds no link before announcement and preserves one native link on every later replacement", () => {
		const before = [{ type: "content", content: { type: "text", text: "working" } }] as never
		expect(withSubagentSessionLink(before, undefined)).toBe(before)
		const linked = withSubagentSessionLink(before, "child")
		expect(linked.at(-1)).toEqual({ type: "session", sessionId: "child" })
		const replacement = withSubagentSessionLink(
			[{ type: "content", content: { type: "text", text: "done" } }] as never,
			"child",
		)
		expect(replacement).toHaveLength(2)
		expect(replacement.at(-1)).toEqual({ type: "session", sessionId: "child" })
		expect(withSubagentSessionLink(replacement, "child").filter((item) => item.type === "session")).toHaveLength(1)
	})

	it("allocates distinct message ids per prompt projection", () => {
		const session = new ProjectionFakeSession("child")
		const event = childEvent("parent", session)
		const first = subagentPromptMessages("parent", event)
		const second = subagentPromptMessages("parent", event)
		expect(update(first[0] as SessionNotification).messageId).not.toBe(
			update(second[0] as SessionNotification).messageId,
		)
	})

	it("resolves both relative and worktree-absolute child directories absolutely", () => {
		expect(absoluteSubagentCwd(".worktrees/child", "/workspace/root")).toBe("/workspace/root/.worktrees/child")
		expect(absoluteSubagentCwd("/outside/worktree", "/workspace/root")).toBe("/outside/worktree")
	})
})
