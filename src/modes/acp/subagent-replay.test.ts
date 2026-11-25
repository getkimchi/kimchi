import type { AgentContext, ClientCapabilities, SessionNotification } from "@agentclientprotocol/sdk/unstable"
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it, vi } from "vitest"
import { asSession } from "./__mocks__/fake-agent-session.js"
import { RecordingFakeAgentSession } from "./__mocks__/recording-agent-session.js"
import { KimchiAcpAgent } from "./server.js"
import { SubagentConfigReporter } from "./subagent-config.js"

class ReplayFakeSession extends RecordingFakeAgentSession {
	entries: unknown[] = []
	failBranch = false

	constructor(sessionId: string, cwd = "/workspace", parentSessionFile?: string) {
		super(sessionId)
		this.sessionManager.getCwd = () => cwd
		Object.assign(this.sessionManager, {
			getBranch: () => {
				if (this.failBranch) throw new Error("parent recovery failed")
				return this.entries
			},
			getEntries: () => this.entries,
			getSessionFile: () => `/sessions/${sessionId}.jsonl`,
			getHeader: () => ({ cwd, parentSession: parentSessionFile }),
		})
	}
}

function capabilities(agent: KimchiAcpAgent, value: ClientCapabilities | undefined): void {
	Reflect.set(agent, "clientCapabilities", value)
}

function association(parentId: string, childId: string, status = "completed"): unknown {
	return {
		type: "custom",
		customType: "subagents:record",
		data: {
			id: `run-${childId}`,
			agentId: `run-${childId}`,
			sessionId: childId,
			parentSessionId: parentId,
			parentSessionFile: `/sessions/${parentId}.jsonl`,
			toolCallId: `provider-spawn-${childId}`,
			prompt: `Original delegated task for ${childId}`,
			description: `Description for ${childId}`,
			cwd: "/workspace/child",
			visibility: "user",
			remote: false,
			background: false,
			status,
			sessionFile: `/sessions/${childId}.jsonl`,
		},
	}
}

function toolTurn(): unknown[] {
	return [
		{
			type: "message",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "Child observation." },
					{ type: "toolCall", id: "child-bash", name: "bash", arguments: { command: "printf child" } },
				],
			},
		},
		{
			type: "message",
			message: {
				role: "toolResult",
				toolCallId: "child-bash",
				toolName: "bash",
				content: [{ type: "text", text: "child result" }],
				isError: false,
				timestamp: 1,
			},
		},
	]
}

function setModel(session: ReplayFakeSession, id: string): void {
	const selected = { provider: "test", id, name: id, reasoning: true }
	session.model = selected
	session.modelRegistry = {
		getAvailable: () => [selected],
		find: () => selected,
		hasConfiguredAuth: () => true,
	}
	Reflect.set(session, "thinkingLevel", "high")
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

async function flush(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve))
}

interface Harness {
	agent: KimchiAcpAgent
	root: ReplayFakeSession
	updates: SessionNotification[]
	loader: ReturnType<typeof vi.fn>
}

describe("ACP parent-driven subagent replay", () => {
	const agents: KimchiAcpAgent[] = []
	afterEach(async () => {
		for (const agent of agents.splice(0)) await agent.shutdown()
	})

	function harness(
		root: ReplayFakeSession,
		loadChild: (sessionId: string) => ReplayFakeSession,
		clientCapabilities: ClientCapabilities | undefined = { subagents: {} } as ClientCapabilities,
	): Harness {
		const updates: SessionNotification[] = []
		const conn = {
			notify: vi.fn(async (method: string, params: unknown) => {
				if (method === "session/update") updates.push(params as SessionNotification)
			}),
			request: vi.fn(async () => {
				throw new Error("Unexpected outgoing request")
			}),
		} as unknown as AgentContext
		const loader = vi.fn(async (association: { sessionId: string }) => {
			const session = asSession(loadChild(association.sessionId))
			const fallback = Reflect.get(session, "modelFallbackMessage")
			return typeof fallback === "string" ? { session, modelFallbackMessage: fallback } : session
		})
		const agent = new KimchiAcpAgent(conn, {
			extensionFactories: [],
			agentDir: "/tmp/acp-replay-tests",
			sessionLoader: async () => asSession(root),
			sessionFactory: async () => asSession(root),
			subagentReplayLoader: loader,
		})
		capabilities(agent, clientCapabilities)
		agents.push(agent)
		return { agent, root, updates, loader }
	}

	it("replays stable directed messages/tools and publishes durable config only after the parent succeeds", async () => {
		const root = new ReplayFakeSession("parent")
		const child = new ReplayFakeSession("child", "/workspace/child", "/sessions/parent.jsonl")
		setModel(child, "offline-child-model")
		child.entries = [{ type: "model_change", provider: "test", modelId: "offline-child-model" }, ...toolTurn()]
		root.entries = [association("parent", "child")]
		const { agent, updates } = harness(root, () => child)

		await agent.loadSession({ sessionId: "parent", cwd: "/workspace", mcpServers: [] })
		expect(updates.some((item) => item.update.sessionUpdate === "agent_message_chunk")).toBe(true)
		expect(updates.some((item) => item.update.sessionUpdate === "config_option_update")).toBe(false)
		expect(updates.filter((item) => item.update.sessionUpdate === "subagent_update").at(-1)?.update).toMatchObject({
			capabilities: {},
			state: { state: "unknown" },
		})
		await flush()

		const states = updates.filter((item) => item.update.sessionUpdate === "subagent_update")
		expect(states.at(-1)?.update).toMatchObject({ state: { state: "idle", stopReason: "end_turn" }, capabilities: {} })
		const config = updates.at(-1)
		if (config?.update.sessionUpdate !== "config_option_update") throw new Error("Missing replay configuration")
		expect(config.update.configOptions.find((option) => option.id === "model")?.currentValue).toBe(
			"test/offline-child-model",
		)
		const finalConfigIndex = updates.indexOf(config)
		expect(finalConfigIndex).toBeGreaterThan(
			updates.findIndex((item) => item.update.sessionUpdate === "agent_message_chunk"),
		)
		expect(updates).toHaveLength(finalConfigIndex + 1)

		const firstIds = updates.flatMap(({ update }) =>
			update.sessionUpdate === "session_message" ? [update.messageId] : [],
		)
		const firstTool = updates.find(
			({ sessionId, update }) => sessionId === "child" && update.sessionUpdate === "tool_call",
		)
		if (firstTool?.update.sessionUpdate !== "tool_call") throw new Error("Missing replayed child tool")
		const firstChildMessage = updates.find(
			({ sessionId, update }) => sessionId === "child" && update.sessionUpdate === "session_message",
		)
		if (firstChildMessage?.update.sessionUpdate !== "session_message") throw new Error("Missing replayed child prompt")
		expect(firstChildMessage.update.content).toEqual([])
		const childMessageId = firstChildMessage.update.messageId
		const reconstructed = reconstructMessageText(updates, new Map([[childMessageId, "Previous initial content"]]))
		expect(reconstructed.get(childMessageId)).toBe("Original delegated task for child")
		const afterFirstReplay = updates.length
		await agent.loadSession({ sessionId: "parent", cwd: "/workspace", mcpServers: [] })
		await flush()
		const secondIds = updates
			.slice(afterFirstReplay)
			.flatMap(({ update }) => (update.sessionUpdate === "session_message" ? [update.messageId] : []))
		expect(secondIds).toEqual(firstIds)
		const secondTool = updates
			.slice(afterFirstReplay)
			.find(({ sessionId, update }) => sessionId === "child" && update.sessionUpdate === "tool_call")
		if (secondTool?.update.sessionUpdate !== "tool_call") throw new Error("Missing second child tool")
		expect(secondTool.update.toolCallId).toBe(firstTool.update.toolCallId)
		const secondChildMessage = updates
			.slice(afterFirstReplay)
			.find(({ sessionId, update }) => sessionId === "child" && update.sessionUpdate === "session_message")
		if (secondChildMessage?.update.sessionUpdate !== "session_message") {
			throw new Error("Missing second replayed child prompt")
		}
		expect(secondChildMessage.update.content).toEqual([])
		expect(secondChildMessage.update.messageId).toBe(childMessageId)
		const afterSecondReplay = reconstructMessageText(updates.slice(afterFirstReplay), reconstructed)
		expect(afterSecondReplay.get(childMessageId)).toBe("Original delegated task for child")
		const directed = updates.find(
			(item) => item.update.sessionUpdate === "session_message" && item.sessionId === "parent",
		)
		expect(directed?.update).toMatchObject({ senderSessionId: "parent", recipientSessionId: "child" })

		const beforeResume = updates.length
		await agent.resumeSession({ sessionId: "parent", cwd: "/workspace" })
		await flush()
		expect(updates.slice(beforeResume).some((item) => item.update.sessionUpdate === "session_message_chunk")).toBe(
			false,
		)
		expect(updates.slice(beforeResume).some((item) => item.update.sessionUpdate === "agent_message_chunk")).toBe(false)
	})

	it("replays existing live children from their native session without reopening or replacing it", async () => {
		const root = new ReplayFakeSession("parent")
		root.entries = [association("parent", "child")]
		const child = new ReplayFakeSession("child", "/workspace/child", "/sessions/parent.jsonl")
		child.entries = toolTurn()
		const { agent, updates, loader } = harness(root, () => {
			throw new Error("Live replay must not open a second child session")
		})
		await agent.newSession({ cwd: "/workspace", mcpServers: [] })
		const receiver = agent as unknown as { onSubagentSessionCreated(event: Record<string, unknown>): void }
		receiver.onSubagentSessionCreated({
			agentId: "run-child",
			sessionId: child.sessionId,
			parentSessionId: "parent",
			toolCallId: "provider-spawn-child",
			prompt: "Original delegated task for child",
			description: "Live child",
			cwd: "/workspace/child",
			visibility: "user",
			remote: false,
			status: "running",
			background: false,
			agentSession: asSession(child),
		})
		child.emit({ type: "agent_start" } as AgentSessionEvent)
		child.emit({
			type: "tool_execution_start",
			toolCallId: "child-bash",
			toolName: "bash",
			args: { command: "printf child" },
		} as AgentSessionEvent)
		const liveTool = updates.find(
			({ sessionId, update }) => sessionId === child.sessionId && update.sessionUpdate === "tool_call",
		)
		if (liveTool?.update.sessionUpdate !== "tool_call") throw new Error("Missing live tool")
		const before = updates.length
		await agent.loadSession({ sessionId: "parent", cwd: "/workspace", mcpServers: [] })
		await flush()
		const replayed = updates.slice(before)
		expect(replayed.some((item) => item.update.sessionUpdate === "session_message" && item.sessionId === "child")).toBe(
			true,
		)
		expect(
			replayed.some((item) => item.update.sessionUpdate === "agent_message_chunk" && item.sessionId === "child"),
		).toBe(true)
		const replayedTool = replayed.find(
			({ sessionId, update }) => sessionId === child.sessionId && update.sessionUpdate === "tool_call",
		)
		if (replayedTool?.update.sessionUpdate !== "tool_call") throw new Error("Missing live tool on reattach")
		expect(replayedTool.update.toolCallId).toBe(liveTool.update.toolCallId)
		expect(loader).not.toHaveBeenCalled()
		const beforeResume = updates.length
		await agent.resumeSession({ sessionId: "parent", cwd: "/workspace" })
		await flush()
		expect(
			updates
				.slice(beforeResume)
				.some(
					(item) =>
						item.update.sessionUpdate === "session_message_chunk" ||
						item.update.sessionUpdate === "agent_message_chunk",
				),
		).toBe(false)
	})

	it("discards pending state and configuration on failed recovery without deleting prior history or aborting another root", async () => {
		const root = new ReplayFakeSession("parent")
		const live = new ReplayFakeSession("live-child", "/workspace/child", "/sessions/parent.jsonl")
		const historical = new ReplayFakeSession("historical-child", "/workspace/history", "/sessions/parent.jsonl")
		root.entries = [association("parent", "historical-child")]
		const { agent, updates, loader } = harness(root, (id) => {
			if (id === "historical-child") return historical
			throw new Error(`Unexpected child ${id}`)
		})
		await agent.newSession({ cwd: "/workspace", mcpServers: [] })
		await agent.loadSession({ sessionId: "parent", cwd: "/workspace", mcpServers: [] })
		await flush()
		const history = updates.filter(
			(item) =>
				item.update.sessionUpdate === "agent_message_chunk" || item.update.sessionUpdate === "config_option_update",
		)
		const stopped = vi.fn(() => ({ accepted: true, stopped: Promise.resolve() }))
		const receiver = agent as unknown as { onSubagentSessionCreated(event: Record<string, unknown>): void }
		receiver.onSubagentSessionCreated({
			agentId: "run-live-child",
			sessionId: live.sessionId,
			parentSessionId: "parent",
			toolCallId: "provider-live-child",
			prompt: "Live task",
			description: "Live child",
			cwd: "/workspace/child",
			visibility: "user",
			remote: false,
			status: "running",
			background: false,
			abort: stopped,
			agentSession: asSession(live),
		})
		const loadersBeforeFailure = loader.mock.calls.length
		root.failBranch = true
		const pendingLoad = agent.loadSession({ sessionId: "parent", cwd: "/workspace", mcpServers: [] })
		live.emit({ type: "agent_start" } as AgentSessionEvent)
		live.emit({ type: "agent_settled" } as AgentSessionEvent)
		await expect(pendingLoad).rejects.toThrow("parent recovery failed")
		const atFailure = updates.length
		await flush()
		expect(loader).toHaveBeenCalledTimes(loadersBeforeFailure)
		expect(updates).toHaveLength(atFailure)
		expect(stopped).not.toHaveBeenCalled()
		const registry = Reflect.get(agent, "subagentRegistry") as { has(id: string): boolean }
		expect(registry.has(live.sessionId)).toBe(true)
		expect(registry.has(historical.sessionId)).toBe(true)
		expect(history.length).toBeGreaterThan(0)
		root.failBranch = false
		await agent.loadSession({ sessionId: "parent", cwd: "/workspace", mcpServers: [] })
		await flush()
		expect(updates.at(-1)?.update.sessionUpdate).toBe("config_option_update")
	})

	it("keeps unrecoverable configuration unconfirmed rather than borrowing root state", async () => {
		const root = new ReplayFakeSession("parent")
		root.entries = [association("parent", "child")]
		const { agent, updates } = harness(root, () => {
			throw new Error("child history is missing")
		})
		await agent.loadSession({ sessionId: "parent", cwd: "/workspace", mcpServers: [] })
		await flush()
		expect(updates.at(-1)?.update).toEqual({ sessionUpdate: "config_option_update", configOptions: [] })
		expect(JSON.stringify(updates)).not.toContain("test-model")
		await expect(
			agent.loadSession({ sessionId: "child", cwd: "/workspace/child", mcpServers: [] }),
		).rejects.toMatchObject({
			code: -32602,
		})
	})

	it("does not report an unrestorable or history-less fallback model", async () => {
		const root = new ReplayFakeSession("parent")
		root.entries = [association("parent", "child")]
		const child = new ReplayFakeSession("child")
		setModel(child, "fallback-model")
		Reflect.set(child, "modelFallbackMessage", "Could not restore model test/unavailable-model")
		const { agent, updates } = harness(root, () => child)
		await agent.loadSession({ sessionId: "parent", cwd: "/workspace", mcpServers: [] })
		await flush()
		const config = updates.at(-1)
		if (config?.update.sessionUpdate !== "config_option_update") throw new Error("Missing config snapshot")
		expect(config.update.configOptions.find((option) => option.id === "model")).toBeUndefined()
		expect(config.update.configOptions.find((option) => option.id === "reasoning_effort")).toBeUndefined()
	})

	it("disposes the restored projection when transcript replay throws", async () => {
		const root = new ReplayFakeSession("parent")
		root.entries = [association("parent", "child")]
		const child = new ReplayFakeSession("child")
		const resources = vi.fn()
		Object.assign(child.resourceLoader, { dispose: resources })
		const dispose = vi.spyOn(child, "dispose")
		const reporter = vi.spyOn(SubagentConfigReporter.prototype, "dispose")
		const { agent, updates } = harness(root, () => child)
		const replay = Reflect.get(agent, "replayTranscript") as (session: AgentSession, record?: unknown) => void
		Reflect.set(agent, "replayTranscript", (session: AgentSession, record?: unknown) => {
			if (session.sessionId === "child") throw new Error("malformed child transcript")
			replay.call(agent, session, record)
		})
		await agent.loadSession({ sessionId: "parent", cwd: "/workspace", mcpServers: [] })
		await flush()
		expect(updates.at(-1)?.update).toEqual({ sessionUpdate: "config_option_update", configOptions: [] })
		expect(resources).toHaveBeenCalledOnce()
		expect(dispose).toHaveBeenCalledOnce()
		expect(reporter).toHaveBeenCalledOnce()
		reporter.mockRestore()
	})

	it("keeps association identity and publishes empty config when the child identity disagrees", async () => {
		const root = new ReplayFakeSession("parent")
		root.entries = [association("parent", "child")]
		const wrongChild = new ReplayFakeSession("different-child")
		const resources = vi.fn()
		Object.assign(wrongChild.resourceLoader, { dispose: resources })
		const dispose = vi.spyOn(wrongChild, "dispose")
		const { agent, updates } = harness(root, () => wrongChild)
		await agent.loadSession({ sessionId: "parent", cwd: "/workspace", mcpServers: [] })
		await flush()
		expect(updates.at(-1)?.update).toEqual({ sessionUpdate: "config_option_update", configOptions: [] })
		expect(resources).toHaveBeenCalledOnce()
		expect(dispose).toHaveBeenCalledOnce()
		const registry = Reflect.get(agent, "subagentRegistry") as { has(id: string): boolean }
		expect(registry.has("child")).toBe(true)
		expect(registry.has("different-child")).toBe(false)
	})

	it("disposes a loaded child when projection construction throws", async () => {
		const root = new ReplayFakeSession("parent")
		root.entries = [association("parent", "child")]
		const child = new ReplayFakeSession("child")
		child.failBranch = true
		const resources = vi.fn()
		Object.assign(child.resourceLoader, { dispose: resources })
		const dispose = vi.spyOn(child, "dispose")
		const { agent, updates } = harness(root, () => child)
		await agent.loadSession({ sessionId: "parent", cwd: "/workspace", mcpServers: [] })
		await flush()
		expect(updates.at(-1)?.update).toEqual({ sessionUpdate: "config_option_update", configOptions: [] })
		expect(resources).toHaveBeenCalledOnce()
		expect(dispose).toHaveBeenCalledOnce()
	})

	it("keeps cloned roots and capability-off connections isolated", async () => {
		const oldParent = "/sessions/old.jsonl"
		const inherited = association("old", "shared-child")
		Object.assign((inherited as { data: Record<string, unknown> }).data, {
			parentSessionFile: oldParent,
			prompt: "same native child task",
		})
		const rootA = new ReplayFakeSession("root-a", "/workspace", oldParent)
		rootA.entries = [inherited]
		const rootB = new ReplayFakeSession("root-b", "/workspace", oldParent)
		rootB.entries = [inherited]
		const child = new ReplayFakeSession("shared-child", "/workspace/child", oldParent)
		const first = harness(rootA, () => child)
		await first.agent.loadSession({ sessionId: "root-a", cwd: "/workspace", mcpServers: [] })
		const second = harness(rootB, () => child)
		await second.agent.loadSession({ sessionId: "root-b", cwd: "/workspace", mcpServers: [] })
		await flush()
		expect(
			first.updates.find((item) => item.update.sessionUpdate === "session_message" && item.sessionId === "root-a")
				?.update,
		).toMatchObject({
			recipientSessionId: "shared-child",
			senderSessionId: "root-a",
		})
		expect(
			second.updates.find((item) => item.update.sessionUpdate === "session_message" && item.sessionId === "root-b")
				?.update,
		).toMatchObject({
			recipientSessionId: "shared-child",
			senderSessionId: "root-b",
		})
		const legacyRoot = new ReplayFakeSession("legacy")
		legacyRoot.entries = [association("legacy", "legacy-child")]
		const legacy = harness(legacyRoot, () => child, {})
		await legacy.agent.loadSession({ sessionId: "legacy", cwd: "/workspace", mcpServers: [] })
		await flush()
		expect(legacy.loader).not.toHaveBeenCalled()
		expect(
			legacy.updates.filter(
				(item) => item.update.sessionUpdate === "subagent_update" || item.update.sessionUpdate === "session_message",
			),
		).toEqual([])
	})
})
