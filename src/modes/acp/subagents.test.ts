import type { AgentContext, ClientCapabilities, SessionNotification } from "@agentclientprotocol/sdk/unstable"
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { asSession } from "./__mocks__/fake-agent-session.js"
import { RecordingFakeAgentSession as ProjectionFakeSession } from "./__mocks__/recording-agent-session.js"
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

function subagentRegistry(agent: KimchiAcpAgent): {
	getLive(childId: string): { record: { unsubscribe: () => void } } | undefined
	childForTool(parentSessionId: string, toolCallId: string, upstreamId: string): string | undefined
} {
	return Reflect.get(agent, "subagentRegistry")
}

function createChild(agent: KimchiAcpAgent, event: SubagentSessionCreatedEvent): void {
	const receiver = agent as unknown as { onSubagentSessionCreated(event: SubagentSessionCreatedEvent): void }
	receiver.onSubagentSessionCreated(event)
}

async function createRoot(
	id: string,
	capabilities: ClientCapabilities | undefined = { subagents: {} } as ClientCapabilities,
	next?: ProjectionFakeSession,
): Promise<{
	agent: KimchiAcpAgent
	root: ProjectionFakeSession
	updates: SessionNotification[]
	extensions: unknown[]
}> {
	const root = new ProjectionFakeSession(id, "/workspace/root")
	const roots = next ? [root, next] : [root]
	const { conn, updates, extensions } = recordingConnection()
	const agent = new KimchiAcpAgent(conn, {
		extensionFactories: [],
		agentDir: "/tmp/acp-subagent-tests",
		sessionFactory: async () => {
			const next = roots.shift()
			if (!next) throw new Error("unexpected root creation")
			return asSession(next)
		},
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
			const text = (update.content ?? []).flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
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
	it("treats only a subagents capability object as opt-in", () => {
		expect(clientSupportsSubagents({ subagents: {} } as ClientCapabilities)).toBe(true)
		expect(clientSupportsSubagents({ subagents: null } as unknown as ClientCapabilities)).toBe(false)
		expect(clientSupportsSubagents({ subagents: false } as unknown as ClientCapabilities)).toBe(false)
		expect(clientSupportsSubagents({ subagents: "" } as unknown as ClientCapabilities)).toBe(false)
		expect(clientSupportsSubagents({} as ClientCapabilities)).toBe(false)
		expect(clientSupportsSubagents(undefined)).toBe(false)
	})

	it("parses the partner payload defensively without dropping the native session", () => {
		const session = new ProjectionFakeSession("native")
		const event = childEvent("parent", session)
		expect(parseSubagentSessionCreated(event)).toEqual(event)
		expect(parseSubagentSessionCreated({ ...event, prompt: "" })?.prompt).toBe("")
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

		expect(updates).toHaveLength(5)
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
		expect(updates[1]?.sessionId).toBe("native-child")
		expect(update(updates[1] as SessionNotification)).toMatchObject({
			sessionUpdate: "config_option_update",
		})
		expect(update(updates[2] as SessionNotification)).toMatchObject({
			sessionUpdate: "session_message",
			senderSessionId: "parent",
			recipientSessionId: "native-child",
		})
		expect(updates[3]?.sessionId).toBe("native-child")
		expect(update(updates[4] as SessionNotification)).toMatchObject({
			sessionUpdate: "session_message_chunk",
			content: { type: "text", text: "Investigate the complete original prompt.\nKeep every line." },
		})
		const parentMessage = update(updates[2] as SessionNotification)
		const childMessage = update(updates[3] as SessionNotification)
		expect(parentMessage.recipientMessageId).toBe(childMessage.messageId)
		expect(childMessage.senderMessageId).toBe(parentMessage.messageId)
		expect(parentMessage.messageId).not.toBe(childMessage.messageId)
		const reconstructed = reconstructMessageText(updates)
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

	it("projects a consumed orchestrator steer as a session-directed message", async () => {
		const { agent, updates } = await createRoot("parent")
		agents.push(agent)
		const child = new ProjectionFakeSession("native-child")
		createChild(agent, childEvent("parent", child))
		updates.length = 0
		child.emit({ type: "queue_update", steering: ["Review the failed assertion"], followUp: [] } as AgentSessionEvent)
		child.emit({ type: "queue_update", steering: [], followUp: [] } as AgentSessionEvent)

		expect(updates).toHaveLength(3)
		expect(updates.every((entry) => update(entry).sessionUpdate !== "user_message_chunk")).toBe(true)
		const parentMessage = update(updates[0] as SessionNotification)
		const childMessage = update(updates[1] as SessionNotification)
		expect(parentMessage).toMatchObject({
			sessionUpdate: "session_message",
			senderSessionId: "parent",
			recipientSessionId: "native-child",
		})
		expect(updates[1]?.sessionId).toBe("native-child")
		expect(parentMessage.recipientMessageId).toBe(childMessage.messageId)
		expect(childMessage.senderMessageId).toBe(parentMessage.messageId)
		expect(reconstructMessageText(updates).get(String(childMessage.messageId))).toBe("Review the failed assertion")
	})

	it("projects a resumed prompt on the existing route without re-announcing", async () => {
		const { agent, updates } = await createRoot("parent")
		agents.push(agent)
		const child = new ProjectionFakeSession("native-child")
		createChild(agent, childEvent("parent", child))
		updates.length = 0

		createChild(
			agent,
			childEvent("parent", child, { prompt: "Continue with the original requirements.", phase: "resumed" }),
		)

		expect(updates).toHaveLength(3)
		expect(updates.every((entry) => update(entry).sessionUpdate !== "subagent_update")).toBe(true)
		const parentMessage = update(updates[0] as SessionNotification)
		const childMessage = update(updates[1] as SessionNotification)
		expect(parentMessage.recipientMessageId).toBe(childMessage.messageId)
		expect(childMessage.senderMessageId).toBe(parentMessage.messageId)
		expect(reconstructMessageText(updates).get(String(childMessage.messageId))).toBe(
			"Continue with the original requirements.",
		)
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

	it("releases child subscriptions and tool links when the parent closes", async () => {
		const { agent, updates } = await createRoot("parent")
		agents.push(agent)
		const child = new ProjectionFakeSession("native-child")
		createChild(agent, childEvent("parent", child))
		const registry = subagentRegistry(agent)
		const route = registry.getLive("native-child")
		if (!route) throw new Error("Expected registered child route")
		const unsubscribe = vi.spyOn(route.record, "unsubscribe")
		await agent.unstable_closeSession({ sessionId: "parent" })

		expect(unsubscribe).toHaveBeenCalledOnce()
		expect(registry.getLive("native-child")).toBeUndefined()
		expect(registry.childForTool("parent", "provider-agent-call", "provider-agent-call")).toBeUndefined()
		updates.length = 0
		streamChild(child, "detached child output")
		expect(updates).toEqual([])
	})

	it("retires a child tool link before the provider reuses its tool-call id", async () => {
		const { agent, root, updates } = await createRoot("parent")
		agents.push(agent)
		const child = new ProjectionFakeSession("native-child")
		root.emit({ type: "agent_start" } as AgentSessionEvent)
		const start = () => {
			root.emit({
				type: "tool_execution_start",
				toolCallId: "provider-agent-call",
				toolName: "Agent",
				args: { description: "Delegate", prompt: "Investigate" },
			} as AgentSessionEvent)
		}
		const finish = () => {
			root.emit({
				type: "tool_execution_end",
				toolCallId: "provider-agent-call",
				toolName: "Agent",
				result: { content: [{ type: "text", text: "done" }], details: {} },
				isError: false,
			} as unknown as AgentSessionEvent)
		}
		start()
		createChild(agent, childEvent("parent", child))
		finish()
		expect(JSON.stringify(updates.at(-1))).toContain('{"type":"session","sessionId":"native-child"}')

		updates.length = 0
		start()
		finish()
		expect(update(updates.at(-1) as SessionNotification).sessionUpdate).toBe("tool_call_update")
		expect(JSON.stringify(updates)).not.toContain('{"type":"session","sessionId":"native-child"}')
		expect(subagentRegistry(agent).childForTool("parent", "provider-agent-call", "provider-agent-call")).toBeUndefined()
	})

	it("lets a registered root replace a colliding child route", async () => {
		const child = new ProjectionFakeSession("colliding-child", "/workspace/root")
		const { agent, updates } = await createRoot("parent", { subagents: {} } as ClientCapabilities, child)
		agents.push(agent)
		createChild(agent, childEvent("parent", child))
		const registry = subagentRegistry(agent)
		const route = registry.getLive(child.sessionId)
		if (!route) throw new Error("Expected registered child route")
		const unsubscribe = vi.spyOn(route.record, "unsubscribe")
		await agent.newSession({ cwd: "/workspace/root", mcpServers: [] })

		expect(unsubscribe).toHaveBeenCalledOnce()
		expect(registry.getLive(child.sessionId)).toBeUndefined()
		expect(registry.childForTool("parent", "provider-agent-call", "provider-agent-call")).toBeUndefined()
		updates.length = 0
		child.emit({ type: "queue_update", steering: ["root input"], followUp: [] } as AgentSessionEvent)
		child.emit({ type: "queue_update", steering: [], followUp: [] } as AgentSessionEvent)
		expect(updates.some((entry) => update(entry).sessionUpdate === "user_message_chunk")).toBe(true)
		expect(updates.every((entry) => update(entry).sessionUpdate !== "session_message")).toBe(true)
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
		expect(withSubagentSessionLink(undefined, undefined)).toBeUndefined()
		const before = [{ type: "content", content: { type: "text", text: "working" } }] as never
		expect(withSubagentSessionLink(before, undefined)).toBe(before)
		const linked = withSubagentSessionLink(before, "child")
		expect(linked?.at(-1)).toEqual({ type: "session", sessionId: "child" })
		const replacement = withSubagentSessionLink(
			[{ type: "content", content: { type: "text", text: "done" } }] as never,
			"child",
		)
		expect(replacement?.length).toBe(2)
		expect(replacement?.at(-1)).toEqual({ type: "session", sessionId: "child" })
		expect(withSubagentSessionLink(replacement, "child")?.filter((item) => item.type === "session")).toHaveLength(1)
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

describe("subagent cancellation", () => {
	const agents: KimchiAcpAgent[] = []
	afterEach(async () => {
		for (const agent of agents.splice(0)) await agent.shutdown()
	})

	it("advertises a real abort path and emits idle/cancelled only when the native run settles", async () => {
		const { agent, updates } = await createRoot("parent")
		agents.push(agent)
		const child = new ProjectionFakeSession("child-cancel")
		let resolveStopped = () => {}
		const stopped = new Promise<void>((resolve) => {
			resolveStopped = resolve
		})
		const abort = vi.fn(() => ({ accepted: true, stopped }))
		createChild(agent, childEvent("parent", child, { abort }))
		expect(update(updates[0] as SessionNotification)).toMatchObject({ capabilities: { cancel: {} } })

		child.emit({ type: "agent_start" } as AgentSessionEvent)
		const cancelling = agent.cancel({ sessionId: child.sessionId })
		expect(abort).toHaveBeenCalledOnce()
		expect(updates.some((item) => (update(item).state as { state?: string } | undefined)?.state === "idle")).toBe(false)
		resolveStopped()
		await cancelling
		expect(updates.some((item) => (update(item).state as { state?: string } | undefined)?.state === "idle")).toBe(false)

		child.emit({ type: "agent_settled" } as AgentSessionEvent)
		expect(update(updates.at(-1) as SessionNotification)).toMatchObject({
			sessionUpdate: "subagent_update",
			sessionId: child.sessionId,
			state: { state: "idle", stopReason: "cancelled" },
		})
		expect(JSON.stringify(updates)).not.toContain('"status":"cancelled"')
		child.emit({ type: "agent_start" } as AgentSessionEvent)
		child.emit({ type: "agent_settled" } as AgentSessionEvent)
		expect(update(updates.at(-1) as SessionNotification)).toMatchObject({
			state: { state: "idle", stopReason: "end_turn" },
		})
	})

	it("awaits an in-flight stop on repeated cancel instead of treating accepted:false as stopped", async () => {
		const { agent, updates } = await createRoot("parent")
		agents.push(agent)
		const child = new ProjectionFakeSession("repeat-cancel")
		let finishStop = () => {}
		const stopped = new Promise<void>((resolve) => (finishStop = resolve))
		const abort = vi
			.fn()
			.mockReturnValueOnce({ accepted: true, stopped })
			.mockReturnValueOnce({ accepted: false, stopped })
		createChild(agent, childEvent("parent", child, { abort }))
		child.emit({ type: "agent_start" } as AgentSessionEvent)
		const first = agent.cancel({ sessionId: child.sessionId })
		const second = agent.cancel({ sessionId: child.sessionId })
		await vi.waitFor(() => expect(abort).toHaveBeenCalledTimes(2))
		expect(updates.some((item) => (update(item).state as { state?: string } | undefined)?.state === "idle")).toBe(false)
		finishStop()
		await Promise.all([first, second])
		child.emit({ type: "agent_settled" } as AgentSessionEvent)
		expect(update(updates.at(-1) as SessionNotification)).toMatchObject({
			state: { state: "idle", stopReason: "cancelled" },
		})
	})

	it("cancels a pending parent prompt before stopping slow descendants", async () => {
		const { agent, root, updates } = await createRoot("parent")
		agents.push(agent)
		const child = new ProjectionFakeSession("slow-close-child")
		let finishStop = () => {}
		const stopped = new Promise<void>((resolve) => (finishStop = resolve))
		const abort = vi.fn(() => ({ accepted: true, stopped }))
		createChild(agent, childEvent("parent", child, { abort }))
		const idle = new Promise<void>(() => {})
		Reflect.set(root, "waitForIdle", async () => await idle)
		root.emit({ type: "agent_start" } as AgentSessionEvent)
		const prompt = agent.prompt({ sessionId: "parent", prompt: [{ type: "text", text: "Wait for close." }] })
		const sessions = Reflect.get(agent, "sessions") as Map<string, { pendingPrompts?: Set<unknown> }>
		await vi.waitFor(() => expect(sessions.get("parent")?.pendingPrompts?.size).toBe(1))
		const closing = agent.closeSession({ sessionId: "parent" })
		await expect(prompt).resolves.toEqual({ stopReason: "cancelled" })
		expect(updates.some((item) => item.update.sessionUpdate === "agent_message_chunk")).toBe(false)
		finishStop()
		await closing
	})

	it("registers an adopted child once its cloned parent is registered", async () => {
		const child = new ProjectionFakeSession("adopted-child")
		const abort = vi.fn(() => ({ accepted: true, stopped: Promise.resolve() }))
		const event = childEvent("cloned-parent", child, { abort })
		const { agent, root, updates } = await createRoot(
			"cloned-parent-source",
			{ subagents: {} } as ClientCapabilities,
			new ProjectionFakeSession("cloned-parent"),
		)
		agents.push(agent)
		createChild(agent, event)
		Reflect.set(root, "sessionId", "cloned-parent")
		await agent.newSession({ cwd: "/workspace/root", mcpServers: [] })
		await vi.waitFor(() =>
			expect(
				updates.some((item) => update(item).sessionUpdate === "subagent_update" && item.sessionId === "cloned-parent"),
			).toBe(true),
		)
		expect(
			updates.filter((item) => update(item).sessionUpdate === "subagent_update" && item.sessionId === "cloned-parent"),
		).toHaveLength(1)
		await agent.cancel({ sessionId: child.sessionId })
		expect(abort).toHaveBeenCalledOnce()
	})

	it("ignores unavailable and unknown cancellation targets without changing state", async () => {
		const { agent, updates } = await createRoot("parent")
		agents.push(agent)
		const child = new ProjectionFakeSession("child-without-abort")
		createChild(agent, childEvent("parent", child))
		const before = structuredClone(updates)
		await agent.cancel({ sessionId: child.sessionId })
		await agent.cancel({ sessionId: "missing-child" })
		expect(updates).toEqual(before)
	})

	it("admits child cancellation only when recovery publishes a current cancellation capability", async () => {
		const { agent, updates } = await createRoot("parent")
		agents.push(agent)
		const child = new ProjectionFakeSession("child-during-recovery")
		const abort = vi.fn(() => ({ accepted: true, stopped: Promise.resolve() }))
		createChild(agent, childEvent("parent", child, { abort }))
		const registry = Reflect.get(agent, "subagentRegistry") as { replay(): Promise<void> }
		const replay = vi.spyOn(registry, "replay")
		const states = () =>
			updates.filter(({ update }) => update.sessionUpdate === "subagent_update" && update.sessionId === child.sessionId)
		let rejectReplay!: (error: Error) => void
		replay.mockImplementationOnce(async () => {
			await new Promise<void>((_, reject) => (rejectReplay = reject))
		})
		const pending = agent.loadSession({ sessionId: "parent", cwd: "/workspace/root", mcpServers: [] })
		expect(states().at(-1)?.update).toMatchObject({ state: { state: "unknown" }, capabilities: {} })
		await agent.cancel({ sessionId: child.sessionId })
		expect(abort).not.toHaveBeenCalled()

		rejectReplay(new Error("parent recovery failed"))
		await expect(pending).rejects.toThrow("parent recovery failed")
		expect(states().at(-1)?.update).toMatchObject({ state: { state: "unknown" }, capabilities: {} })
		await agent.cancel({ sessionId: child.sessionId })
		expect(abort).not.toHaveBeenCalled()

		// A successful retry alone cannot restore stale state: it needs a fresh
		// native state observation before cancellation becomes available again.
		replay.mockImplementationOnce(async () => child.emit({ type: "agent_start" } as AgentSessionEvent))
		await agent.loadSession({ sessionId: "parent", cwd: "/workspace/root", mcpServers: [] })
		await new Promise<void>((resolve) => setImmediate(resolve))
		expect(states().at(-1)?.update).toMatchObject({ state: { state: "running" }, capabilities: { cancel: {} } })
		await agent.cancel({ sessionId: child.sessionId })
		expect(abort).toHaveBeenCalledOnce()
	})

	it("cancels awaited children with the parent but leaves independent background children running", async () => {
		const { agent, root } = await createRoot("parent")
		agents.push(agent)
		const foregroundAbort = vi.fn(() => ({ accepted: true, stopped: Promise.resolve() }))
		const backgroundAbort = vi.fn(() => ({ accepted: true, stopped: Promise.resolve() }))
		const rootAbort = vi.spyOn(root, "abort")
		createChild(agent, childEvent("parent", new ProjectionFakeSession("child-fg"), { abort: foregroundAbort }))
		createChild(
			agent,
			childEvent("parent", new ProjectionFakeSession("child-bg"), {
				background: true,
				abort: backgroundAbort,
			}),
		)

		await agent.cancel({ sessionId: "parent" })
		expect(rootAbort).toHaveBeenCalledOnce()
		expect(foregroundAbort).toHaveBeenCalledOnce()
		expect(backgroundAbort).not.toHaveBeenCalled()
	})

	it("stops all children on parent close only for the closing root", async () => {
		const roots = [new ProjectionFakeSession("root-a"), new ProjectionFakeSession("root-b")]
		const { conn } = recordingConnection()
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
		for (const background of [false, true]) {
			createChild(
				agent,
				childEvent("root-a", new ProjectionFakeSession(`child-a-${background}`), {
					background,
					abort: vi.fn(() => ({ accepted: true, stopped: Promise.resolve() })),
				}),
			)
		}
		const otherAbort = vi.fn(() => ({ accepted: true, stopped: Promise.resolve() }))
		createChild(agent, childEvent("root-b", new ProjectionFakeSession("child-b"), { abort: otherAbort }))

		await agent.closeSession({ sessionId: "root-a" })
		const registry = Reflect.get(agent, "subagentRegistry") as { has(childId: string): boolean }
		expect(registry.has("child-b")).toBe(true)
		for (const background of [false, true]) {
			expect(registry.has(`child-a-${background}`)).toBe(false)
		}
		expect(otherAbort).not.toHaveBeenCalled()
		await agent.closeSession({ sessionId: "root-b" })
		expect(otherAbort).toHaveBeenCalledOnce()
	})
})
