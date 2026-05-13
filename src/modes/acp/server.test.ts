import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk"
import type { AgentSession, AgentSessionEvent, AgentSessionEventListener } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it } from "vitest"
import { type AcpSessionFactory, KimchiAcpAgent, assertSessionHasModel, buildSessionModelState, describeToolCall } from "./server.js"

// Minimal fake of AgentSession surface used by KimchiAcpAgent. The factory seam
// means we only need to stand in for the methods the ACP server actually calls:
// sessionId, subscribe, prompt, abort, dispose.
class FakeAgentSession {
	readonly sessionId: string
	private listeners = new Set<AgentSessionEventListener>()
	disposed = false
	aborted = false
	model?: { id: string }
	modelRegistry = { getAvailable: () => [] as Array<{ id: string; name: string }> }
	promptImpl: (text: string) => Promise<void> = async () => {}
	abortImpl: () => Promise<void> = async () => {}

	constructor(sessionId: string) {
		this.sessionId = sessionId
	}

	subscribe(listener: AgentSessionEventListener): () => void {
		this.listeners.add(listener)
		return () => {
			this.listeners.delete(listener)
		}
	}

	emit(event: AgentSessionEvent): void {
		for (const l of [...this.listeners]) l(event)
	}

	async prompt(text: string, _opts?: unknown): Promise<void> {
		await this.promptImpl(text)
	}

	async setModel(model: { id: string }): Promise<void> {
		this.model = model
	}

	async abort(): Promise<void> {
		this.aborted = true
		await this.abortImpl()
	}

	dispose(): void {
		this.disposed = true
		this.listeners.clear()
	}
}

function asSession(fake: FakeAgentSession): AgentSession {
	return fake as unknown as AgentSession
}

function makeConn(): AgentSideConnection {
	const stub = {
		sessionUpdate: async (_p: SessionNotification) => {},
	}
	return stub as unknown as AgentSideConnection
}

// Recording variant of makeConn: captures every sessionUpdate the agent emits
// so tests can assert on the full notification stream (tool_call, partial
// tool_call_update, terminal tool_call_update, etc.).
function makeRecordingConn(): { conn: AgentSideConnection; updates: SessionNotification[] } {
	const updates: SessionNotification[] = []
	const stub = {
		sessionUpdate: async (p: SessionNotification) => {
			updates.push(p)
		},
	}
	return { conn: stub as unknown as AgentSideConnection, updates }
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe("KimchiAcpAgent turn lifecycle", () => {
	let fake: FakeAgentSession
	let agent: KimchiAcpAgent
	let sessionId: string

	beforeEach(async () => {
		fake = new FakeAgentSession("session-a")
		const sessionFactory: AcpSessionFactory = async () => asSession(fake)
		agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory,
		})
		const res = await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		sessionId = res.sessionId
	})

	// The fragile scenario the previous setImmediate heuristic could trip on:
	// session.prompt() resolves BEFORE the subscriber receives agent_end (e.g.
	// a slow extension agent_end handler awaits real I/O). The fix trusts
	// pi-agent-core's agent_end contract and waits until the event actually
	// arrives at our listener.
	it("resolves end_turn even when agent_end is delivered after session.prompt resolves", async () => {
		let agentEndDeliveredAt = 0
		let outerResolvedAt = 0
		fake.promptImpl = async () => {
			// Mirror pi-mono: agent_start is the first event of a real run.
			fake.emit({ type: "agent_start" })
			// agent.prompt awaits the LLM call; simulate with a short delay.
			await delay(5)
			// session.prompt is about to resolve; schedule agent_end AFTER that,
			// simulating a slow downstream handler on the agent_end path.
			setTimeout(() => {
				agentEndDeliveredAt = Date.now()
				fake.emit({ type: "agent_end", messages: [] })
			}, 40)
			// Return now — agent_end has NOT reached our subscriber yet.
		}

		const start = Date.now()
		const result = await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "hi" }],
		})
		outerResolvedAt = Date.now()

		expect(result.stopReason).toBe("end_turn")
		// The outer prompt must wait for agent_end, not race ahead of it.
		expect(agentEndDeliveredAt).toBeGreaterThan(0)
		expect(outerResolvedAt).toBeGreaterThanOrEqual(agentEndDeliveredAt)
		expect(outerResolvedAt - start).toBeGreaterThanOrEqual(40)
	})

	// CANARY: documents the load-bearing assumption in prompt() that SOME turn
	// event (agent_start or later) is delivered before session.prompt() resolves.
	// pi-mono's agent.prompt awaits the LLM call, draining the microtask queue
	// and ensuring _processAgentEvent ran for at least agent_start. If pi-mono
	// ever delays ALL turn events until after session.prompt() resolves, real
	// turns would hit the !turnActive branch and synthesize end_turn prematurely —
	// late agent_end / tool events would be silently dropped. This test locks in
	// the current behavior; a future pi-mono update that breaks the contract
	// should fail this test, at which point swap the detector for something more
	// robust (e.g. peek at isStreaming on the session).
	it("CANARY: synthesizes end_turn when no turn events arrive before session.prompt resolves", async () => {
		let lateEventsFired = false
		fake.promptImpl = async () => {
			await delay(5)
			// Schedule agent_start + agent_end AFTER session.prompt resolves.
			setTimeout(() => {
				fake.emit({ type: "agent_start" })
				fake.emit({ type: "agent_end", messages: [] })
				lateEventsFired = true
			}, 30)
		}

		const result = await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "hi" }],
		})
		// Current behavior: end_turn synthesized immediately after session.prompt
		// resolves — before late events arrive. If this changes to "cancelled" or
		// "end_turn from late agent_end", the short-circuit detector was updated.
		expect(result.stopReason).toBe("end_turn")
		expect(lateEventsFired).toBe(false)

		// Let late events fire and confirm they are dropped (turn already cleared).
		await delay(40)
		expect(lateEventsFired).toBe(true)
	})

	// Defensive widening: if the first event we observe from pi-mono is
	// tool_execution_start (hypothetical future ordering where agent_start
	// isn't synchronous with agent.prompt), turnActive still flips and the
	// prompt() resolver waits for agent_end instead of synthesizing end_turn
	// prematurely. This pins down the widening in TurnContext.turnActive.
	it("treats tool_execution_start as a turn-active signal (no premature short-circuit)", async () => {
		fake.promptImpl = async () => {
			// No agent_start. Emit only tool_execution_start + agent_end.
			fake.emit({
				type: "tool_execution_start",
				toolCallId: "tc-early",
				toolName: "bash",
				args: { command: "noop" },
			})
			await delay(5)
			setTimeout(() => fake.emit({ type: "agent_end", messages: [] }), 30)
		}
		const result = await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "x" }],
		})
		// end_turn must come from agent_end (post-delay), not from the
		// !turnActive short-circuit branch firing immediately after
		// session.prompt() resolves.
		expect(result.stopReason).toBe("end_turn")
	})

	// Extension-command / input-handler / no-op path: session.prompt returns
	// without emitting any agent events. The ACP handler must synthesize
	// end_turn itself — no agent_end is ever coming.
	it("synthesizes end_turn when the turn short-circuits without agent_start", async () => {
		fake.promptImpl = async () => {
			// No events emitted — exactly like an extension-command path.
		}

		const result = await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "/help" }],
		})

		expect(result.stopReason).toBe("end_turn")
	})

	// Client cancels mid-turn: cancelled=true is set on the turn context, then
	// agent_end fires and the subscriber finalizes with stopReason=cancelled.
	it("resolves cancelled when cancel fires before agent_end", async () => {
		let cancelSeen = false
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			// Wait until cancel() runs.
			while (!cancelSeen) await delay(5)
			// pi-mono's abort path still emits agent_end on teardown.
			fake.emit({ type: "agent_end", messages: [] })
		}
		fake.abortImpl = async () => {
			cancelSeen = true
		}

		const promptP = agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "run forever" }],
		})
		// Give the prompt a moment to arm the turn context.
		await delay(10)
		await agent.cancel({ sessionId })

		const result = await promptP
		expect(result.stopReason).toBe("cancelled")
		expect(fake.aborted).toBe(true)
	})

	// Cancel path where pi-mono surfaces abortion as a rejection instead of a
	// final agent_end: the RPC contract still demands stopReason="cancelled",
	// not a JSON-RPC error. The prompt() catch block must honor cancelled=true
	// and resolve, not reject.
	it("resolves cancelled when session.prompt rejects after cancel", async () => {
		let cancelSeen = false
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			while (!cancelSeen) await delay(5)
			// Simulate pi-mono's "abort throws out of prompt()" variant — no
			// agent_end is emitted before the rejection.
			throw new Error("AbortError: operation was aborted")
		}
		fake.abortImpl = async () => {
			cancelSeen = true
		}

		const promptP = agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "run forever" }],
		})
		await delay(10)
		await agent.cancel({ sessionId })

		const result = await promptP
		expect(result.stopReason).toBe("cancelled")
		expect(fake.aborted).toBe(true)
	})

	// If session.prompt throws (pre-turn validation, config error, etc.), the
	// outer RPC promise must reject — not hang — regardless of whether any
	// events were emitted before the throw.
	it("rejects the outer prompt when session.prompt throws", async () => {
		fake.promptImpl = async () => {
			throw new Error("no model configured")
		}

		await expect(agent.prompt({ sessionId, prompt: [{ type: "text", text: "x" }] })).rejects.toThrow(
			/no model configured/,
		)
	})

	// shutdown() must not leave pending PromptResponse promises dangling.
	// When the caller awaits shutdown (e.g. runAcpMode's finally after
	// conn.closed resolves) an in-flight turn must be rejected so the prompt
	// caller's await settles rather than hanging until process exit.
	it("rejects in-flight turns when shutdown() is called", async () => {
		let resumePrompt!: () => void
		const pending = new Promise<void>((resolve) => {
			resumePrompt = resolve
		})
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			await pending // never resolves on its own in this test
		}

		const promptP = agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "hang forever" }],
		})
		// Pre-attach catch handler so the rejection fires synchronously during
		// shutdown without landing as an unhandled rejection.
		const caught = promptP.catch((err) => err)
		// Arm the turn.
		await delay(10)

		await agent.shutdown()
		const err = await caught
		expect(err).toBeInstanceOf(Error)
		expect((err as Error).message).toMatch(/shutting down/)
		// Cleanup the dangling promptImpl.
		resumePrompt()
		expect(fake.disposed).toBe(true)
	})

	// Misbehaving client sends a block type our capabilities declared as
	// unsupported (image/audio/embeddedContext). The server drops it silently
	// from the text payload but must warn on stderr so a dev debugging the
	// resulting empty-turn sees what happened. Warn exactly once per type.
	it("warns once on stderr for unsupported prompt block types", async () => {
		const writes: string[] = []
		const origWrite = process.stderr.write.bind(process.stderr)
		// biome-ignore lint/suspicious/noExplicitAny: test-only stderr capture
		;(process.stderr.write as any) = (chunk: string | Uint8Array) => {
			writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
			return true
		}
		try {
			const r1 = await agent.prompt({
				sessionId,
				// biome-ignore lint/suspicious/noExplicitAny: unsupported block on purpose
				prompt: [{ type: "image" as any, data: "x" } as any],
			})
			expect(r1.stopReason).toBe("end_turn")
			// Second call with same unsupported type: no new warning (deduped).
			const r2 = await agent.prompt({
				sessionId,
				// biome-ignore lint/suspicious/noExplicitAny: unsupported block on purpose
				prompt: [{ type: "image" as any, data: "y" } as any],
			})
			expect(r2.stopReason).toBe("end_turn")
			// New unsupported type: warns again.
			const r3 = await agent.prompt({
				sessionId,
				// biome-ignore lint/suspicious/noExplicitAny: unsupported block on purpose
				prompt: [{ type: "audio" as any, data: "z" } as any],
			})
			expect(r3.stopReason).toBe("end_turn")
		} finally {
			process.stderr.write = origWrite
		}
		const matches = writes.filter((w) => w.includes("acp prompt: dropping unsupported block type"))
		expect(matches).toHaveLength(2)
		expect(matches.some((w) => w.includes('"image"'))).toBe(true)
		expect(matches.some((w) => w.includes('"audio"'))).toBe(true)
	})

	// Defensive: once a turn is finalized (short-circuit, shutdown, cancel),
	// stray tool_execution_{start,end} must not emit tool_call notifications
	// to the client. Clients would otherwise see tool activity on a turn they
	// consider complete. Checked alongside the existing agent_end drop test.
	it("drops stray tool_execution_start/end after a short-circuited turn", async () => {
		const localFake = new FakeAgentSession("session-tool-late")
		const factory: AcpSessionFactory = async () => asSession(localFake)
		const { conn, updates } = makeRecordingConn()
		const localAgent = new KimchiAcpAgent(conn, {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})
		const { sessionId: sid } = await localAgent.newSession({ cwd: "/tmp", mcpServers: [] })

		localFake.promptImpl = async () => {
			// Short-circuit: no events.
		}
		const result = await localAgent.prompt({
			sessionId: sid,
			prompt: [{ type: "text", text: "/help" }],
		})
		expect(result.stopReason).toBe("end_turn")
		const updatesBefore = updates.length

		// Stray tool events arrive after finalization — must be dropped.
		localFake.emit({
			type: "tool_execution_start",
			toolCallId: "tc-late",
			toolName: "bash",
			args: { command: "late" },
		})
		localFake.emit({
			type: "tool_execution_end",
			toolCallId: "tc-late",
			toolName: "bash",
			result: { content: [{ type: "text", text: "late" }] },
			isError: false,
		})
		expect(updates.length).toBe(updatesBefore)
	})

	// Defensive: a late agent_end arriving after the short-circuit path has
	// already finalized must be a no-op, not a crash or double-resolve.
	it("ignores a late agent_end after a short-circuited turn", async () => {
		fake.promptImpl = async () => {
			// No events.
		}
		const result = await agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "/help" }],
		})
		expect(result.stopReason).toBe("end_turn")

		// Stray agent_end arrives later (shouldn't happen in production, but
		// the guard in onSessionEvent must keep us safe either way).
		expect(() => fake.emit({ type: "agent_end", messages: [] })).not.toThrow()
	})

	// Resource safety on the newSession error path: if subscribe (or any step
	// between factory-returns-session and sessions.set) throws, the live session
	// must be disposed — nothing else will ever clean it up.
	it("disposes the session if subscribe throws during newSession", async () => {
		const leaky = new FakeAgentSession("session-leak")
		leaky.subscribe = () => {
			throw new Error("subscribe boom")
		}
		const factory: AcpSessionFactory = async () => asSession(leaky)
		const localAgent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})

		await expect(localAgent.newSession({ cwd: "/tmp", mcpServers: [] })).rejects.toThrow(/subscribe boom/)
		expect(leaky.disposed).toBe(true)
	})

	// mcpServers is declared in the ACP request shape but kimchi has no hook to
	// wire them into a live session — pi-coding-agent loads MCP servers from its
	// own config. Silently dropping them would leave the client believing those
	// servers are available; reject up-front with invalidParams instead.
	it("rejects newSession when mcpServers is non-empty", async () => {
		const factoryCalled = { count: 0 }
		const factory: AcpSessionFactory = async () => {
			factoryCalled.count++
			return asSession(new FakeAgentSession("unused"))
		}
		const localAgent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})
		await expect(
			localAgent.newSession({
				cwd: "/tmp",
				// biome-ignore lint/suspicious/noExplicitAny: only the shape we care about
				mcpServers: [{ name: "x", command: "x", args: [] } as any],
			}),
		).rejects.toMatchObject({ code: -32602 })
		expect(factoryCalled.count).toBe(0)
	})

	// Empty array is fine — equivalent to "no per-session servers requested".
	it("accepts newSession with empty mcpServers array", async () => {
		const localFake = new FakeAgentSession("empty-mcp")
		const factory: AcpSessionFactory = async () => asSession(localFake)
		const localAgent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})
		const res = await localAgent.newSession({ cwd: "/tmp", mcpServers: [] })
		expect(res.sessionId).toBe("empty-mcp")
	})

	// If the factory itself throws (e.g. bindExtensions failure in the default
	// factory), newSession must propagate the error — the factory owns disposal
	// of anything it allocated before throwing.
	it("propagates errors thrown by the session factory", async () => {
		const throwing: AcpSessionFactory = async () => {
			throw new Error("factory refused")
		}
		const localAgent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: throwing,
		})

		await expect(localAgent.newSession({ cwd: "/tmp", mcpServers: [] })).rejects.toThrow(/factory refused/)
	})

	// Two sessions run prompts concurrently; each turn must finalize against
	// its own agent_end. The slower session must not block the faster one.
	it("isolates turn state across parallel sessions", async () => {
		const fakeA = new FakeAgentSession("session-a")
		const fakeB = new FakeAgentSession("session-b")
		const fakes = [fakeA, fakeB]
		let i = 0
		const rotating: AcpSessionFactory = async () => asSession(fakes[i++] ?? fakes[fakes.length - 1])
		const parallelAgent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: rotating,
		})
		const a = await parallelAgent.newSession({ cwd: "/tmp/a", mcpServers: [] })
		const b = await parallelAgent.newSession({ cwd: "/tmp/b", mcpServers: [] })
		expect(a.sessionId).not.toBe(b.sessionId)

		fakeA.promptImpl = async () => {
			fakeA.emit({ type: "agent_start" })
			await delay(5)
			setTimeout(() => fakeA.emit({ type: "agent_end", messages: [] }), 60)
		}
		fakeB.promptImpl = async () => {
			fakeB.emit({ type: "agent_start" })
			await delay(5)
			setTimeout(() => fakeB.emit({ type: "agent_end", messages: [] }), 10)
		}

		const [resA, resB] = await Promise.all([
			parallelAgent.prompt({ sessionId: a.sessionId, prompt: [{ type: "text", text: "a" }] }),
			parallelAgent.prompt({ sessionId: b.sessionId, prompt: [{ type: "text", text: "b" }] }),
		])
		expect(resA.stopReason).toBe("end_turn")
		expect(resB.stopReason).toBe("end_turn")
	})
})

// Streaming tools (bash in particular) emit tool_execution_update with a
// partialResult payload for every output chunk. The ACP server translates each
// of these into a tool_call_update with status="in_progress" and content carrying
// the partial output — distinct from the terminal completed/failed update that
// accompanies tool_execution_end. The block below covers that branch directly.
describe("KimchiAcpAgent tool execution stream", () => {
	let fake: FakeAgentSession
	let agent: KimchiAcpAgent
	let sessionId: string
	let updates: SessionNotification[]

	beforeEach(async () => {
		fake = new FakeAgentSession("session-tool")
		const sessionFactory: AcpSessionFactory = async () => asSession(fake)
		const rec = makeRecordingConn()
		updates = rec.updates
		agent = new KimchiAcpAgent(rec.conn, {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory,
		})
		const res = await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		sessionId = res.sessionId
	})

	it("forwards partial tool_execution_update events as in_progress tool_call_update notifications with content", async () => {
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "tool_execution_start",
				toolCallId: "tc-1",
				toolName: "bash",
				args: { command: "printf a; sleep 0; printf b" },
			})
			fake.emit({
				type: "tool_execution_update",
				toolCallId: "tc-1",
				toolName: "bash",
				args: { command: "printf a; sleep 0; printf b" },
				partialResult: { content: [{ type: "text", text: "a" }] },
			})
			fake.emit({
				type: "tool_execution_update",
				toolCallId: "tc-1",
				toolName: "bash",
				args: { command: "printf a; sleep 0; printf b" },
				partialResult: { content: [{ type: "text", text: "ab" }] },
			})
			fake.emit({
				type: "tool_execution_end",
				toolCallId: "tc-1",
				toolName: "bash",
				result: { content: [{ type: "text", text: "ab" }] },
				isError: false,
			})
			fake.emit({ type: "agent_end", messages: [] })
		}

		const res = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "run" }] })
		expect(res.stopReason).toBe("end_turn")

		const toolCallUpdates = updates.filter((u) => u.update.sessionUpdate === "tool_call_update")
		const partials = toolCallUpdates.filter((u) => {
			const up = u.update as { status?: string; content?: unknown[] }
			return up.status === "in_progress" && Array.isArray(up.content) && up.content.length > 0
		})
		expect(partials).toHaveLength(2)
		// Each partial must carry the agent_session partialResult content verbatim
		// as ACP tool_call content blocks — proving the partialResult -> content
		// translation (toolResultContent) ran on the stream path, not only at end.
		const firstContent = (partials[0].update as { content: Array<{ content: { text: string } }> }).content
		expect(firstContent[0].content.text).toBe("a")
		const secondContent = (partials[1].update as { content: Array<{ content: { text: string } }> }).content
		expect(secondContent[0].content.text).toBe("ab")

		// Terminal completed update still fires after the partials.
		const terminal = toolCallUpdates.find((u) => (u.update as { status?: string }).status === "completed")
		expect(terminal).toBeDefined()
	})

	// Guard on server.ts:213-214: an empty partialResult must NOT produce a
	// tool_call_update — an in_progress update with empty content is noise for
	// clients that render the stream as it arrives.
	it("skips tool_execution_update events whose partialResult carries no content", async () => {
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "tool_execution_start",
				toolCallId: "tc-2",
				toolName: "bash",
				args: { command: "true" },
			})
			// Empty partial shapes we can plausibly see: null, undefined, missing content, empty array.
			fake.emit({
				type: "tool_execution_update",
				toolCallId: "tc-2",
				toolName: "bash",
				args: { command: "true" },
				partialResult: null,
			})
			fake.emit({
				type: "tool_execution_update",
				toolCallId: "tc-2",
				toolName: "bash",
				args: { command: "true" },
				partialResult: { content: [] },
			})
			fake.emit({
				type: "tool_execution_end",
				toolCallId: "tc-2",
				toolName: "bash",
				result: { content: [{ type: "text", text: "" }] },
				isError: false,
			})
			fake.emit({ type: "agent_end", messages: [] })
		}

		const res = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "run" }] })
		expect(res.stopReason).toBe("end_turn")

		const toolCallUpdates = updates.filter((u) => u.update.sessionUpdate === "tool_call_update")
		const partials = toolCallUpdates.filter((u) => (u.update as { status?: string }).status === "in_progress")
		expect(partials).toHaveLength(0)
		// Terminal completed update still present.
		const terminal = toolCallUpdates.find((u) => (u.update as { status?: string }).status === "completed")
		expect(terminal).toBeDefined()
	})
})

// Coverage for assertSessionHasModel: ACP clients (Zed) should see authRequired
// (-32000), not a generic internal error, when the model is unavailable — that
// error code routes to the client's auth UI instead of an opaque failure toast.
describe("assertSessionHasModel", () => {
	it("throws RequestError with code -32000 when model is missing", () => {
		try {
			assertSessionHasModel({ model: undefined } as Parameters<typeof assertSessionHasModel>[0])
			throw new Error("expected throw")
		} catch (err) {
			expect((err as { code?: number }).code).toBe(-32000)
			expect((err as Error).message).toMatch(/No model available/)
		}
	})

	it("is a no-op when model is present", () => {
		expect(() =>
			assertSessionHasModel({ model: {} as NonNullable<Parameters<typeof assertSessionHasModel>[0]["model"]> }),
		).not.toThrow()
	})
})

describe("buildSessionModelState", () => {
	it("returns null when model is missing", () => {
		const fake = new FakeAgentSession("s1")
		const result = buildSessionModelState(fake as unknown as Parameters<typeof buildSessionModelState>[0])
		expect(result).toBeNull()
	})

	it("returns currentModelId and availableModels when model is present", () => {
		const fake = new FakeAgentSession("s1")
		fake.model = { id: "gpt-4" }
		fake.modelRegistry = {
			getAvailable: () => [
				{ id: "gpt-4", name: "GPT-4" },
				{ id: "claude-3", name: "Claude 3" },
			],
		}
		const result = buildSessionModelState(fake as unknown as Parameters<typeof buildSessionModelState>[0])
		expect(result).not.toBeNull()
		expect(result!.currentModelId).toBe("gpt-4")
		expect(result!.availableModels).toEqual([
			{ modelId: "gpt-4", name: "GPT-4" },
			{ modelId: "claude-3", name: "Claude 3" },
		])
	})

	it("returns empty availableModels when registry has no models", () => {
		const fake = new FakeAgentSession("s1")
		fake.model = { id: "gpt-4" }
		fake.modelRegistry = { getAvailable: () => [] }
		const result = buildSessionModelState(fake as unknown as Parameters<typeof buildSessionModelState>[0])
		expect(result).not.toBeNull()
		expect(result!.currentModelId).toBe("gpt-4")
		expect(result!.availableModels).toEqual([])
	})
})

describe("newSession model state", () => {
	it("returns model state in the response when a model is available", async () => {
		const fake = new FakeAgentSession("session-model")
		fake.model = { id: "gpt-4" }
		fake.modelRegistry = {
			getAvailable: () => [
				{ id: "gpt-4", name: "GPT-4" },
				{ id: "claude-3", name: "Claude 3" },
			],
		}
		const factory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})
		const res = await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		expect(res.sessionId).toBe("session-model")
		expect(res.models).toBeDefined()
		expect(res.models?.currentModelId).toBe("gpt-4")
		expect(res.models?.availableModels).toHaveLength(2)
		expect(res.models?.availableModels[0]).toEqual({ modelId: "gpt-4", name: "GPT-4" })
		expect(res.models?.availableModels[1]).toEqual({ modelId: "claude-3", name: "Claude 3" })
	})

	it("returns models: null when no model is active", async () => {
		const fake = new FakeAgentSession("session-empty")
		// model defaults to undefined
		const factory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})
		const res = await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		expect(res.sessionId).toBe("session-empty")
		expect(res.models).toBeNull()
	})
})

describe("unstable_setSessionModel", () => {
	it("switches to a valid model", async () => {
		const fake = new FakeAgentSession("switch-session")
		fake.model = { id: "model-a" }
		fake.modelRegistry = {
			getAvailable: () => [
				{ id: "model-a", name: "Model A" },
				{ id: "model-b", name: "Model B" },
			],
		}
		const factory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		const res = await agent.unstable_setSessionModel({ sessionId: "switch-session", modelId: "model-b" })
		expect(res).toEqual({})
		expect(fake.model?.id).toBe("model-b")
	})

	it("throws invalidParams for unknown modelId", async () => {
		const fake = new FakeAgentSession("switch-session")
		fake.model = { id: "model-a" }
		fake.modelRegistry = {
			getAvailable: () => [{ id: "model-a", name: "Model A" }],
		}
		const factory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		await expect(
			agent.unstable_setSessionModel({ sessionId: "switch-session", modelId: "unknown" }),
		).rejects.toThrow()
	})

	it("prompt still works after switching model", async () => {
		const fake = new FakeAgentSession("switch-session")
		fake.model = { id: "model-a" }
		fake.modelRegistry = {
			getAvailable: () => [
				{ id: "model-a", name: "Model A" },
				{ id: "model-b", name: "Model B" },
			],
		}
		const factory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		await agent.unstable_setSessionModel({ sessionId: "switch-session", modelId: "model-b" })
		const result = await agent.prompt({
			sessionId: "switch-session",
			prompt: [{ type: "text", text: "hello" }],
		})
		expect(result).toBeDefined()
		expect(fake.model?.id).toBe("model-b")
	})

	it("throws invalidParams for unknown sessionId", async () => {
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
		})
		await expect(
			agent.unstable_setSessionModel({ sessionId: "no-such-session", modelId: "model-a" }),
		).rejects.toThrow()
	})
})

// Direct coverage for describeToolCall. The function drives the tool_call
// notification's title, kind, and locations — ACP clients key UI affordances
// off these. Two recent fixes (064ff92, 00f58f3) landed on it; table-driven
// cases here keep the title/kind matrix from silently drifting.
describe("describeToolCall", () => {
	const longCommand = "a".repeat(120)
	const longPath = `/tmp/${"x".repeat(120)}`
	const longPattern = "p".repeat(120)
	const cases: Array<{
		name: string
		toolName: string
		args: unknown
		expect: { title: string; kind: string; locations: Array<{ path: string }> }
	}> = [
		{
			name: "bash with command uses command as title and execute kind",
			toolName: "bash",
			args: { command: "ls -la" },
			expect: { title: "ls -la", kind: "execute", locations: [] },
		},
		{
			name: "bash without command falls back to tool name",
			toolName: "bash",
			args: {},
			expect: { title: "bash", kind: "execute", locations: [] },
		},
		{
			name: "bash command is truncated at TITLE_MAX",
			toolName: "bash",
			args: { command: longCommand },
			expect: { title: `${"a".repeat(80)}…`, kind: "execute", locations: [] },
		},
		{
			name: "read with file_path uses path and populates locations",
			toolName: "read",
			args: { file_path: "/etc/hosts" },
			expect: { title: "/etc/hosts", kind: "read", locations: [{ path: "/etc/hosts" }] },
		},
		{
			name: "edit with file_path uses path and edit kind",
			toolName: "edit",
			args: { file_path: "/tmp/a.ts" },
			expect: { title: "/tmp/a.ts", kind: "edit", locations: [{ path: "/tmp/a.ts" }] },
		},
		{
			name: "write with path (not file_path) still populates locations",
			toolName: "write",
			args: { path: "/tmp/b.ts" },
			expect: { title: "/tmp/b.ts", kind: "edit", locations: [{ path: "/tmp/b.ts" }] },
		},
		{
			name: "grep with pattern uses pattern as title and search kind",
			toolName: "grep",
			args: { pattern: "foo.*bar" },
			expect: { title: "foo.*bar", kind: "search", locations: [] },
		},
		{
			name: "ls maps to read kind",
			toolName: "ls",
			args: { path: "/tmp" },
			expect: { title: "/tmp", kind: "read", locations: [{ path: "/tmp" }] },
		},
		{
			name: "find maps to search kind",
			toolName: "find",
			args: { pattern: "*.ts" },
			expect: { title: "*.ts", kind: "search", locations: [] },
		},
		{
			name: "web_fetch maps to fetch kind",
			toolName: "web_fetch",
			args: { url: "https://example.com" },
			expect: { title: "web_fetch", kind: "fetch", locations: [] },
		},
		{
			name: "web_search maps to search kind",
			toolName: "web_search",
			args: { query: "kimchi" },
			expect: { title: "web_search", kind: "search", locations: [] },
		},
		{
			name: "subagent maps to think kind",
			toolName: "subagent",
			args: { prompt: "go" },
			expect: { title: "subagent", kind: "think", locations: [] },
		},
		{
			name: "unknown tool falls back to other kind",
			toolName: "mcp__foo__bar",
			args: { arg: 1 },
			expect: { title: "mcp__foo__bar", kind: "other", locations: [] },
		},
		{
			name: "null args is tolerated",
			toolName: "bash",
			args: null,
			expect: { title: "bash", kind: "execute", locations: [] },
		},
		{
			name: "long path title is truncated (locations keep full path)",
			toolName: "read",
			args: { file_path: longPath },
			expect: {
				title: `${longPath.slice(0, 80)}…`,
				kind: "read",
				locations: [{ path: longPath }],
			},
		},
		{
			name: "long pattern title is truncated",
			toolName: "grep",
			args: { pattern: longPattern },
			expect: {
				title: `${longPattern.slice(0, 80)}…`,
				kind: "search",
				locations: [],
			},
		},
	]

	for (const c of cases) {
		it(c.name, () => {
			const result = describeToolCall(c.toolName, c.args)
			expect(result.title).toBe(c.expect.title)
			expect(result.kind).toBe(c.expect.kind)
			expect(result.locations).toEqual(c.expect.locations)
		})
	}
})
