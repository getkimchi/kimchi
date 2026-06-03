import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import type {
	AgentSideConnection,
	ListSessionsRequest,
	RequestPermissionRequest,
	SessionNotification,
} from "@agentclientprotocol/sdk"
import type {
	AgentSession,
	AgentSessionEvent,
	AgentSessionEventListener,
	SessionInfo as PiSessionInfo,
} from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const THEME_KEY = Symbol.for("@earendil-works/pi-coding-agent:theme")
const THEME_KEY_OLD = Symbol.for("@mariozechner/pi-coding-agent:theme")

import { _resetState as _resetHideThinking, _setHideThinking } from "../../extensions/hide-thinking.js"
import { getAcpPrompter } from "./permission-prompter-registry.js"
import {
	type AcpSessionFactory,
	type AcpSessionLister,
	type AcpSessionLoader,
	KimchiAcpAgent,
	assertSessionHasModel,
	buildSessionModelState,
	describeToolCall,
	initializeHeadlessTheme,
	isHiddenToolCall,
	shouldEmitThinking,
	stripAnsi,
	toAcpSessionInfo,
	userMessageText,
} from "./server.js"

// Minimal fake of AgentSession surface used by KimchiAcpAgent. The factory seam
// means we only need to stand in for the methods the ACP server actually calls:
// sessionId, subscribe, prompt, abort, dispose. loadSession also reads
// `sessionManager.getBranch()` for replay and `model` for the response, so the
// fake exposes settable fields for both.
class FakeAgentSession {
	readonly sessionId: string
	private listeners = new Set<AgentSessionEventListener>()
	disposed = false
	aborted = false
	model: { provider: string; id: string; name?: string; input?: string[] } | undefined = {
		provider: "test",
		id: "test-model",
		name: "Test Model",
		input: ["text"],
	}
	modelRegistry = {
		getAvailable: () =>
			this.model ? [{ provider: this.model.provider, id: this.model.id, name: this.model.name ?? this.model.id }] : [],
	}
	promptImpl: (text: string, opts?: { images?: unknown[] }) => Promise<void> = async () => {}
	abortImpl: () => Promise<void> = async () => {}
	bindExtensionsImpl: (_bindings: unknown) => Promise<void> = async () => {}
	lastPromptImages?: unknown[]
	// Branch entries returned to the replay walker. Tests fill this with the
	// shape buildSessionContext consumers expect (type:"message" + role).
	branch: unknown[] = []
	sessionManager = {
		getBranch: () => this.branch,
	}

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

	async prompt(text: string, opts?: { images?: unknown[] }): Promise<void> {
		this.lastPromptImages = opts?.images
		await this.promptImpl(text, opts)
	}

	async setModel(model: { provider: string; id: string }): Promise<void> {
		this.model = model
	}

	async abort(): Promise<void> {
		this.aborted = true
		await this.abortImpl()
	}

	async bindExtensions(bindings: unknown): Promise<void> {
		await this.bindExtensionsImpl(bindings)
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

function agentEnd(): AgentSessionEvent {
	return { type: "agent_end", messages: [], willRetry: false }
}

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

	// initialize() should declare image support based on cached models.json
	describe("initialize capability detection", () => {
		const tempAgentDir = "/tmp/kimchi-acp-test-agent-dir"

		beforeEach(() => {
			// Clean up and create temp agent dir
			try {
				rmSync(tempAgentDir, { recursive: true, force: true })
			} catch {}
			mkdirSync(tempAgentDir, { recursive: true })
		})

		afterEach(() => {
			try {
				rmSync(tempAgentDir, { recursive: true, force: true })
			} catch {}
		})

		it("declares image: true when cached models include vision models", async () => {
			// Stub API key so models are considered "available" (configured auth)
			const restoreEnv = (key: string, value: string | undefined) => {
				const original = process.env[key]
				process.env[key] = value
				return () => {
					process.env[key] = original
				}
			}
			const cleanup = restoreEnv("OPENAI_API_KEY", "fake-key-for-testing")

			try {
				const modelsJson = {
					providers: {
						openai: {
							models: [
								{
									id: "gpt-4o",
									name: "GPT-4o",
									input: ["text", "image"],
								},
							],
						},
					},
				}
				writeFileSync(resolve(tempAgentDir, "models.json"), JSON.stringify(modelsJson))

				const testAgent = new KimchiAcpAgent(makeConn(), {
					extensionFactories: [],
					agentDir: tempAgentDir,
					sessionFactory: async () => asSession(fake),
				})

				const response = await testAgent.initialize({ protocolVersion: 1 })
				expect(response.agentCapabilities?.promptCapabilities?.image).toBe(true)
			} finally {
				cleanup()
			}
		})

		it("declares image capability based on available models", async () => {
			// ModelRegistry merges cached models with built-in defaults.
			// This test verifies the initialize() method correctly queries
			// the registry and returns a boolean for image support.
			const testAgent = new KimchiAcpAgent(makeConn(), {
				extensionFactories: [],
				agentDir: tempAgentDir,
				sessionFactory: async () => asSession(fake),
			})

			const response = await testAgent.initialize({ protocolVersion: 1 })
			// The result depends on merged models (cached + built-in).
			// Just verify it's a boolean (the logic ran successfully).
			expect(typeof response.agentCapabilities?.promptCapabilities?.image).toBe("boolean")
		})
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
				fake.emit(agentEnd())
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
				fake.emit(agentEnd())
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
			setTimeout(() => fake.emit(agentEnd()), 30)
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
			fake.emit(agentEnd())
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
				prompt: [{ type: "audio" as any, data: "x" } as any],
			})
			expect(r1.stopReason).toBe("end_turn")
			// Second call with same unsupported type: no new warning (deduped).
			const r2 = await agent.prompt({
				sessionId,
				// biome-ignore lint/suspicious/noExplicitAny: unsupported block on purpose
				prompt: [{ type: "audio" as any, data: "y" } as any],
			})
			expect(r2.stopReason).toBe("end_turn")
			// New unsupported type: warns again.
			const r3 = await agent.prompt({
				sessionId,
				// biome-ignore lint/suspicious/noExplicitAny: unsupported block on purpose
				prompt: [{ type: "embeddedContext" as any, data: "z" } as any],
			})
			expect(r3.stopReason).toBe("end_turn")
		} finally {
			process.stderr.write = origWrite
		}
		const matches = writes.filter((w) => w.includes("acp prompt: dropping"))
		expect(matches).toHaveLength(2)
		expect(matches.some((w) => w.includes("audio block"))).toBe(true)
		expect(matches.some((w) => w.includes("embeddedContext block"))).toBe(true)
	})

	// Image blocks are supported when model supports vision: they should be
	// extracted and passed to session.prompt() without warnings.
	it("accepts image blocks when model supports vision", async () => {
		fake.model = { provider: "test", id: "vision-model", input: ["text", "image"] }
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			await delay(5)
			fake.emit(agentEnd())
		}

		const result = await agent.prompt({
			sessionId,
			prompt: [
				{ type: "text", text: "describe this image" },
				{ type: "image", data: "base64data", mimeType: "image/png" },
			],
		})
		expect(result.stopReason).toBe("end_turn")
		// Verify images were passed to session.prompt
		expect(fake.lastPromptImages).toHaveLength(1)
		expect(fake.lastPromptImages?.[0]).toMatchObject({
			type: "image",
			data: "base64data",
			mimeType: "image/png",
		})
	})

	// Image blocks are dropped when model doesn't support vision: they should
	// be silently discarded with a warning.
	it("drops image blocks when model has no vision support", async () => {
		fake.model = { provider: "test", id: "text-only-model", input: ["text"] }
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			await delay(5)
			fake.emit(agentEnd())
		}

		const writes: string[] = []
		const origWrite = process.stderr.write.bind(process.stderr)
		// biome-ignore lint/suspicious/noExplicitAny: test-only stderr capture
		;(process.stderr.write as any) = (chunk: string | Uint8Array) => {
			writes.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"))
			return true
		}

		try {
			const result = await agent.prompt({
				sessionId,
				prompt: [
					{ type: "text", text: "describe this image" },
					{ type: "image", data: "base64data", mimeType: "image/png" },
				],
			})
			expect(result.stopReason).toBe("end_turn")
			// Images should be dropped, not passed to session.prompt (passed as empty array)
			expect(fake.lastPromptImages).toEqual([])
		} finally {
			process.stderr.write = origWrite
		}

		const matches = writes.filter((w) =>
			w.includes("acp prompt: dropping image block (active model has no vision input)"),
		)
		expect(matches).toHaveLength(1)
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
		expect(() => fake.emit(agentEnd())).not.toThrow()
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

	it("unregisters the ACP permission prompter if bindExtensions throws during newSession", async () => {
		const leaky = new FakeAgentSession("session-bind-leak")
		leaky.bindExtensionsImpl = async () => {
			throw new Error("bind boom")
		}
		const factory: AcpSessionFactory = async () => asSession(leaky)
		const localAgent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})

		await expect(localAgent.newSession({ cwd: "/tmp", mcpServers: [] })).rejects.toThrow(/bind boom/)
		expect(leaky.disposed).toBe(true)
		expect(getAcpPrompter("session-bind-leak")).toBeUndefined()
	})

	it("registers an ACP permission prompter that maps allow_once through requestPermission", async () => {
		const requests: RequestPermissionRequest[] = []
		const conn = {
			sessionUpdate: async (_p: SessionNotification) => {},
			requestPermission: async (params: RequestPermissionRequest) => {
				requests.push(params)
				return { outcome: { outcome: "selected", optionId: "choice-0" } }
			},
		} as unknown as AgentSideConnection
		const localFake = new FakeAgentSession("session-permission")
		const localAgent = new KimchiAcpAgent(conn, {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(localFake),
		})
		await localAgent.newSession({ cwd: "/tmp", mcpServers: [] })

		const prompter = getAcpPrompter("session-permission")
		expect(prompter).toBeDefined()
		const result = await prompter?.request({
			toolCallId: "tc-permission",
			toolName: "bash",
			input: { command: "touch allowed.txt" },
			choices: [
				{ kind: "allow-once", label: "Allow once" },
				{ kind: "deny", label: "Deny" },
			],
		})

		expect(result).toEqual({ kind: "allow-once" })
		expect(requests).toHaveLength(1)
		expect(requests[0]).toMatchObject({
			sessionId: "session-permission",
			toolCall: {
				toolCallId: "tc-permission",
				title: "touch allowed.txt",
				kind: "execute",
				status: "pending",
				rawInput: { command: "touch allowed.txt" },
			},
			options: [
				{ optionId: "choice-0", name: "Allow once", kind: "allow_once" },
				{ optionId: "choice-1", name: "Deny", kind: "reject_once" },
			],
		})

		await localAgent.shutdown()
		expect(getAcpPrompter("session-permission")).toBeUndefined()
	})

	it("maps ACP permission cancellation to an aborted prompt result", async () => {
		const requests: RequestPermissionRequest[] = []
		const conn = {
			sessionUpdate: async (_p: SessionNotification) => {},
			requestPermission: async (params: RequestPermissionRequest) => {
				requests.push(params)
				return {
					outcome: { outcome: "cancelled" },
				}
			},
		} as unknown as AgentSideConnection
		const localFake = new FakeAgentSession("session-permission-cancel")
		const localAgent = new KimchiAcpAgent(conn, {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(localFake),
		})
		await localAgent.newSession({ cwd: "/tmp", mcpServers: [] })

		const prompter = getAcpPrompter("session-permission-cancel")
		const result = await prompter?.request({
			toolCallId: "tc-cancel",
			toolName: "write",
			input: { path: "/tmp/out.txt", content: "x" },
			choices: [{ kind: "allow-once", label: "Allow once" }],
		})

		expect(result).toEqual({ kind: "aborted" })
		expect(requests).toHaveLength(1)

		const abort = new AbortController()
		abort.abort()
		const skippedResult = await prompter?.request({
			toolCallId: "tc-cancel-retry",
			toolName: "write",
			input: { path: "/tmp/out.txt", content: "x" },
			choices: [{ kind: "allow-once", label: "Allow once" }],
			signal: abort.signal,
		})

		expect(skippedResult).toEqual({ kind: "aborted" })
		expect(requests).toHaveLength(1)
		await localAgent.shutdown()
	})

	it("closes a live session and unregisters its ACP permission prompter", async () => {
		expect(getAcpPrompter(sessionId)).toBeDefined()

		await agent.unstable_closeSession({ sessionId })

		expect(fake.disposed).toBe(true)
		expect(getAcpPrompter(sessionId)).toBeUndefined()
		await expect(
			agent.prompt({
				sessionId,
				prompt: [{ type: "text", text: "hello" }],
			}),
		).rejects.toMatchObject({ code: -32602 })
	})

	it("cancels an in-flight turn when closing a session", async () => {
		let releasePrompt!: () => void
		const promptReleased = new Promise<void>((resolve) => {
			releasePrompt = resolve
		})
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			await promptReleased
		}

		const result = agent.prompt({
			sessionId,
			prompt: [{ type: "text", text: "hello" }],
		})
		await delay(0)
		await agent.unstable_closeSession({ sessionId })
		releasePrompt()

		await expect(result).resolves.toEqual({ stopReason: "cancelled" })
		expect(fake.aborted).toBe(true)
		expect(fake.disposed).toBe(true)
	})

	it("keeps a same-id reload isolated while close awaits abort", async () => {
		const sid = "session-close-reload"
		const oldFake = new FakeAgentSession(sid)
		const newFake = new FakeAgentSession(sid)
		const { conn, updates } = makeRecordingConn()
		let loaderCalls = 0
		let releaseOldPrompt!: () => void
		const oldPromptReleased = new Promise<void>((resolve) => {
			releaseOldPrompt = resolve
		})
		let releaseNewPrompt!: () => void
		const newPromptReleased = new Promise<void>((resolve) => {
			releaseNewPrompt = resolve
		})
		let markNewPromptStarted!: () => void
		const newPromptStarted = new Promise<void>((resolve) => {
			markNewPromptStarted = resolve
		})
		let newPrompt: Promise<unknown> | undefined
		const localAgent = new KimchiAcpAgent(conn, {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(oldFake),
			sessionLoader: async () => {
				loaderCalls++
				return asSession(newFake)
			},
		})

		oldFake.promptImpl = async () => {
			oldFake.emit({ type: "agent_start" })
			await oldPromptReleased
		}
		newFake.promptImpl = async () => {
			newFake.emit({ type: "agent_start" })
			markNewPromptStarted()
			await newPromptReleased
			newFake.emit(agentEnd())
		}
		oldFake.abortImpl = async () => {
			await localAgent.loadSession({ sessionId: sid, cwd: "/tmp", mcpServers: [] })
			newPrompt = localAgent.prompt({
				sessionId: sid,
				prompt: [{ type: "text", text: "new turn" }],
			})
			await newPromptStarted
			oldFake.emit({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "stale old event" },
			} as unknown as AgentSessionEvent)
			releaseNewPrompt()
		}

		await localAgent.newSession({ cwd: "/tmp", mcpServers: [] })
		const oldPrompt = localAgent.prompt({
			sessionId: sid,
			prompt: [{ type: "text", text: "old turn" }],
		})
		await delay(0)

		await localAgent.unstable_closeSession({ sessionId: sid })
		releaseOldPrompt()

		await expect(oldPrompt).resolves.toEqual({ stopReason: "cancelled" })
		await expect(newPrompt).resolves.toEqual({ stopReason: "end_turn" })
		expect(loaderCalls).toBe(1)
		expect(getAcpPrompter(sid)).toBeDefined()
		expect(
			updates.some(
				(u) =>
					u.update.sessionUpdate === "agent_message_chunk" &&
					(u.update as { content: { text: string } }).content.text === "stale old event",
			),
		).toBe(false)

		await localAgent.shutdown()
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
			setTimeout(() => fakeA.emit(agentEnd()), 60)
		}
		fakeB.promptImpl = async () => {
			fakeB.emit({ type: "agent_start" })
			await delay(5)
			setTimeout(() => fakeB.emit(agentEnd()), 10)
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
			fake.emit(agentEnd())
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
			fake.emit(agentEnd())
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

	it("suppresses ACP tool notifications for system Agent tool calls", async () => {
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "tool_execution_start",
				toolCallId: "tc-system-agent",
				toolName: "Agent",
				args: { prompt: "classify", description: "permission classifier", visibility: "system" },
			})
			fake.emit({
				type: "tool_execution_update",
				toolCallId: "tc-system-agent",
				toolName: "Agent",
				args: { prompt: "classify", description: "permission classifier", visibility: "system" },
				partialResult: { content: [{ type: "text", text: "System agent started." }] },
			})
			fake.emit({
				type: "tool_execution_end",
				toolCallId: "tc-system-agent",
				toolName: "Agent",
				result: { content: [{ type: "text", text: "System agent started." }] },
				isError: false,
			})
			fake.emit(agentEnd())
		}

		const res = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "run" }] })
		expect(res.stopReason).toBe("end_turn")
		expect(updates.some((u) => u.update.sessionUpdate === "tool_call")).toBe(false)
		expect(updates.some((u) => u.update.sessionUpdate === "tool_call_update")).toBe(false)
	})

	it("suppresses system Agent updates even if an update arrives before the start event", async () => {
		fake.promptImpl = async () => {
			fake.emit({ type: "agent_start" })
			fake.emit({
				type: "tool_execution_update",
				toolCallId: "tc-system-agent-update-first",
				toolName: "Agent",
				args: { prompt: "classify", description: "permission classifier", visibility: "system" },
				partialResult: { content: [{ type: "text", text: "System agent started." }] },
			})
			fake.emit({
				type: "tool_execution_end",
				toolCallId: "tc-system-agent-update-first",
				toolName: "Agent",
				result: { content: [{ type: "text", text: "System agent started." }] },
				isError: false,
			})
			fake.emit(agentEnd())
		}

		const res = await agent.prompt({ sessionId, prompt: [{ type: "text", text: "run" }] })
		expect(res.stopReason).toBe("end_turn")
		expect(updates.some((u) => u.update.sessionUpdate === "tool_call")).toBe(false)
		expect(updates.some((u) => u.update.sessionUpdate === "tool_call_update")).toBe(false)
	})
})

describe("isHiddenToolCall", () => {
	it("returns false for non-Agent tool names", () => {
		expect(isHiddenToolCall("bash", {})).toBe(false)
		expect(isHiddenToolCall("read", { visibility: "system" })).toBe(false)
	})

	it("returns false when visibility is missing", () => {
		expect(isHiddenToolCall("Agent", {})).toBe(false)
		expect(isHiddenToolCall("Agent", { prompt: "hello" })).toBe(false)
	})

	it("returns false when visibility is not 'system' (any casing)", () => {
		expect(isHiddenToolCall("Agent", { visibility: "public" })).toBe(false)
		expect(isHiddenToolCall("Agent", { visibility: "private" })).toBe(false)
	})

	it("returns true when visibility is 'system' (case-insensitive)", () => {
		expect(isHiddenToolCall("Agent", { visibility: "system" })).toBe(true)
		expect(isHiddenToolCall("Agent", { visibility: "System" })).toBe(true)
		expect(isHiddenToolCall("Agent", { visibility: "SYSTEM" })).toBe(true)
	})

	it("returns true for Agent with mixed-case 'System' visibility", () => {
		expect(isHiddenToolCall("Agent", { visibility: "SyStEm" })).toBe(true)
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

describe("initializeHeadlessTheme", () => {
	beforeEach(() => {
		vi.stubGlobal(THEME_KEY, undefined)
		vi.stubGlobal(THEME_KEY_OLD, undefined)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("initializes pi's global theme proxy for headless sessions", () => {
		const globals = globalThis as Record<symbol, unknown>

		expect(globals[THEME_KEY]).toBeUndefined()
		expect(globals[THEME_KEY_OLD]).toBeUndefined()

		initializeHeadlessTheme({ getTheme: () => "default" })

		expect(globals[THEME_KEY]).toBeDefined()
		expect(globals[THEME_KEY_OLD]).toBeDefined()
		const initializedTheme = globals[THEME_KEY] as { getFgAnsi(color: string): string }
		expect(() => initializedTheme.getFgAnsi("accent")).not.toThrow()
	})
})

describe("buildSessionModelState", () => {
	it("returns null when model is missing", () => {
		const fake = new FakeAgentSession("s1")
		fake.model = undefined
		const result = buildSessionModelState(fake as unknown as Parameters<typeof buildSessionModelState>[0])
		expect(result).toBeNull()
	})

	it("returns currentModelId and availableModels when model is present", () => {
		const fake = new FakeAgentSession("s1")
		fake.model = { provider: "openai", id: "gpt-4" }
		fake.modelRegistry = {
			getAvailable: () => [
				{ provider: "openai", id: "gpt-4", name: "GPT-4" },
				{ provider: "anthropic", id: "claude-3", name: "Claude 3" },
			],
		}
		const result = buildSessionModelState(fake as unknown as Parameters<typeof buildSessionModelState>[0])
		expect(result).toEqual({
			currentModelId: "openai/gpt-4",
			availableModels: [
				{ modelId: "openai/gpt-4", name: "GPT-4" },
				{ modelId: "anthropic/claude-3", name: "Claude 3" },
			],
		})
	})

	it("returns empty availableModels when registry has no models", () => {
		const fake = new FakeAgentSession("s1")
		fake.model = { provider: "openai", id: "gpt-4" }
		fake.modelRegistry = { getAvailable: () => [] }
		const result = buildSessionModelState(fake as unknown as Parameters<typeof buildSessionModelState>[0])
		expect(result).toEqual({
			currentModelId: "openai/gpt-4",
			availableModels: [],
		})
	})
})

describe("newSession model state", () => {
	it("returns model state in the response when a model is available", async () => {
		const fake = new FakeAgentSession("session-model")
		fake.model = { provider: "openai", id: "gpt-4" }
		fake.modelRegistry = {
			getAvailable: () => [
				{ provider: "openai", id: "gpt-4", name: "GPT-4" },
				{ provider: "anthropic", id: "claude-3", name: "Claude 3" },
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
		expect(res.models?.currentModelId).toBe("openai/gpt-4")
		expect(res.models?.availableModels).toHaveLength(2)
		expect(res.models?.availableModels[0]).toEqual({ modelId: "openai/gpt-4", name: "GPT-4" })
		expect(res.models?.availableModels[1]).toEqual({ modelId: "anthropic/claude-3", name: "Claude 3" })
	})

	it("rejects with authRequired when no model is active", async () => {
		const fake = new FakeAgentSession("session-empty")
		fake.model = undefined
		const factory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})
		await expect(agent.newSession({ cwd: "/tmp", mcpServers: [] })).rejects.toMatchObject({ code: -32000 })
		expect(fake.disposed).toBe(true)
	})
})

describe("unstable_setSessionModel", () => {
	it("switches to a valid model", async () => {
		const fake = new FakeAgentSession("switch-session")
		fake.model = { provider: "provider-a", id: "model-a" }
		fake.modelRegistry = {
			getAvailable: () => [
				{ provider: "provider-a", id: "model-a", name: "Model A" },
				{ provider: "provider-b", id: "model-b", name: "Model B" },
			],
		}
		const factory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		const res = await agent.unstable_setSessionModel({ sessionId: "switch-session", modelId: "provider-b/model-b" })
		expect(res).toEqual({})
		expect(fake.model?.provider).toBe("provider-b")
		expect(fake.model?.id).toBe("model-b")
	})

	it("throws invalidParams for unknown modelId", async () => {
		const fake = new FakeAgentSession("switch-session")
		fake.model = { provider: "provider-a", id: "model-a" }
		fake.modelRegistry = {
			getAvailable: () => [{ provider: "provider-a", id: "model-a", name: "Model A" }],
		}
		const factory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		await expect(agent.unstable_setSessionModel({ sessionId: "switch-session", modelId: "unknown" })).rejects.toThrow()
	})

	it("prompt still works after switching model", async () => {
		const fake = new FakeAgentSession("switch-session")
		fake.model = { provider: "provider-a", id: "model-a" }
		fake.modelRegistry = {
			getAvailable: () => [
				{ provider: "provider-a", id: "model-a", name: "Model A" },
				{ provider: "provider-b", id: "model-b", name: "Model B" },
			],
		}
		const factory: AcpSessionFactory = async () => asSession(fake)
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
		})
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })
		await agent.unstable_setSessionModel({ sessionId: "switch-session", modelId: "provider-b/model-b" })
		const result = await agent.prompt({
			sessionId: "switch-session",
			prompt: [{ type: "text", text: "hello" }],
		})
		expect(result).toBeDefined()
		expect(fake.model?.provider).toBe("provider-b")
		expect(fake.model?.id).toBe("model-b")
	})

	it("throws invalidParams for unknown sessionId", async () => {
		const agent = new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
		})
		await expect(agent.unstable_setSessionModel({ sessionId: "no-such-session", modelId: "model-a" })).rejects.toThrow()
	})
})

// Direct coverage for describeToolCall. The function drives the tool_call
// notification's title, kind, and locations — ACP clients key UI affordances
// off these. Two recent fixes (064ff92, 00f58f3) landed on it; table-driven
// cases here keep the title/kind matrix from silently drifting.
describe("describeToolCall", () => {
	it("detects hidden system Agent calls", () => {
		expect(isHiddenToolCall("Agent", { visibility: "system" })).toBe(true)
		expect(isHiddenToolCall("Agent", { visibility: "user" })).toBe(false)
		expect(isHiddenToolCall("bash", { visibility: "system" })).toBe(false)
	})

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
			name: "Agent maps to think kind",
			toolName: "Agent",
			args: { prompt: "go", visibility: "user" },
			expect: { title: "Agent", kind: "think", locations: [] },
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

// Helper for the listSessions tests: builds a pi SessionInfo with sensible
// defaults so each test only spells out the fields it cares about.
function makePiSession(overrides: Partial<PiSessionInfo> = {}): PiSessionInfo {
	return {
		path: "/tmp/sessions/x.jsonl",
		id: "id-x",
		cwd: "/tmp/proj",
		name: undefined,
		parentSessionPath: undefined,
		created: new Date("2026-01-01T00:00:00Z"),
		modified: new Date("2026-01-01T00:00:00Z"),
		messageCount: 0,
		firstMessage: "",
		allMessagesText: "",
		...overrides,
	}
}

// Direct coverage for the pi → ACP SessionInfo mapping. Title fallback and
// updatedAt formatting are both load-bearing for Zed's thread-picker UI.
describe("toAcpSessionInfo", () => {
	it("uses the user-defined name when present", () => {
		const out = toAcpSessionInfo(makePiSession({ id: "s1", cwd: "/p", name: "named", firstMessage: "ignored" }))
		expect(out).toEqual({
			sessionId: "s1",
			cwd: "/p",
			title: "named",
			updatedAt: "2026-01-01T00:00:00.000Z",
		})
	})

	it("falls back to truncated firstMessage when name is absent", () => {
		const long = "q".repeat(120)
		const out = toAcpSessionInfo(makePiSession({ firstMessage: long }))
		expect(out.title).toBe(`${"q".repeat(80)}…`)
	})

	it("returns null title when both name and firstMessage are empty", () => {
		const out = toAcpSessionInfo(makePiSession({ name: undefined, firstMessage: "" }))
		expect(out.title).toBeNull()
	})

	it("falls back to firstMessage when name is the empty string (not just undefined)", () => {
		// Pi types `name?: string`, but a hand-edited / migrated session info
		// entry can land with name === "". A previous version used `??` which
		// only short-circuits on null/undefined, so the fallback was skipped
		// and the title became null even though firstMessage was populated.
		const out = toAcpSessionInfo(makePiSession({ name: "", firstMessage: "hello world" }))
		expect(out.title).toBe("hello world")
	})

	it("formats updatedAt as ISO 8601 from the modified Date", () => {
		const out = toAcpSessionInfo(makePiSession({ modified: new Date("2026-05-09T12:34:56.789Z") }))
		expect(out.updatedAt).toBe("2026-05-09T12:34:56.789Z")
	})
})

describe("KimchiAcpAgent listSessions", () => {
	function makeAgent(lister: AcpSessionLister): KimchiAcpAgent {
		return new KimchiAcpAgent(makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(new FakeAgentSession("unused")),
			sessionLister: lister,
		})
	}

	it("advertises sessionCapabilities.list in initialize", async () => {
		const agent = makeAgent(async () => [])
		const init = await agent.initialize({
			protocolVersion: 1,
			clientCapabilities: {} as never,
		} as never)
		expect(init.agentCapabilities?.sessionCapabilities?.list).toEqual({})
	})

	it("dispatches to SessionManager.list when cwd is provided", async () => {
		let received: { cwd?: string | null } = {}
		const agent = makeAgent(async (params) => {
			received = { cwd: params.cwd }
			return []
		})
		await agent.listSessions({ cwd: "/repo/foo", mcpServers: [] } as never)
		expect(received.cwd).toBe("/repo/foo")
	})

	it("falls back to listAll when cwd is omitted", async () => {
		let cwdSeen: string | null | undefined = "sentinel"
		const agent = makeAgent(async (params) => {
			cwdSeen = params.cwd
			return []
		})
		await agent.listSessions({} as never)
		// Lister receives the original (undefined) cwd; the default lister maps
		// that to listAll(). Tests of the default lister itself live in pi.
		expect(cwdSeen).toBeUndefined()
	})

	it("forwards additionalDirectories to the session lister", async () => {
		let received: ListSessionsRequest | undefined
		const agent = makeAgent(async (params) => {
			received = params
			return []
		})
		await agent.listSessions({
			cwd: "/repo/foo",
			additionalDirectories: ["/repo/bar", "/repo/baz"],
		} as never)
		expect(received?.additionalDirectories).toEqual(["/repo/bar", "/repo/baz"])
	})

	it("dedupes sessions returned across multiple roots by id", async () => {
		// Custom lister stand-in for the multi-root default lister: returns the
		// same id from two roots; handler must surface it once.
		const dup = makePiSession({ id: "shared", modified: new Date("2026-04-01T00:00:00Z"), name: "shared" })
		const uniq = makePiSession({ id: "uniq", modified: new Date("2026-03-01T00:00:00Z"), name: "uniq" })
		const agent = makeAgent(async () => [dup, uniq, dup])
		const res = await agent.listSessions({ cwd: "/p" } as never)
		expect(res.sessions.map((s) => s.sessionId)).toEqual(["shared", "uniq"])
	})

	it("returns empty array for a directory with no sessions", async () => {
		const agent = makeAgent(async () => [])
		const res = await agent.listSessions({ cwd: "/empty" } as never)
		expect(res.sessions).toEqual([])
	})

	it("returns nextCursor: null to signal end-of-pagination", async () => {
		const agent = makeAgent(async () => [makePiSession({ id: "s" })])
		const res = await agent.listSessions({ cwd: "/p" } as never)
		expect(res.nextCursor).toBeNull()
	})

	it("sorts sessions newest-first by updatedAt", async () => {
		const piSessions: PiSessionInfo[] = [
			makePiSession({ id: "old", modified: new Date("2026-01-01T00:00:00Z"), name: "old" }),
			makePiSession({ id: "new", modified: new Date("2026-05-09T00:00:00Z"), name: "new" }),
			makePiSession({ id: "mid", modified: new Date("2026-03-01T00:00:00Z"), name: "mid" }),
		]
		const agent = makeAgent(async () => piSessions)
		const res = await agent.listSessions({ cwd: "/p" } as never)
		expect(res.sessions.map((s) => s.sessionId)).toEqual(["new", "mid", "old"])
	})

	it("uses truncated firstMessage as title when name is absent", async () => {
		const long = "z".repeat(120)
		const agent = makeAgent(async () => [makePiSession({ id: "s", firstMessage: long, name: undefined })])
		const res = await agent.listSessions({ cwd: "/p" } as never)
		expect(res.sessions[0].title).toBe(`${"z".repeat(80)}…`)
	})
})

// Helpers for replay tests: build the SessionMessageEntry shape that
// SessionManager.getBranch() returns. `userText` / `assistantText` produce the
// minimal valid envelope — id/parentId/timestamp are not consulted by the
// replay walker, so any non-empty placeholder is fine.
function userTextEntry(text: string, id = "u1", parentId: string | null = null): unknown {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-05-09T00:00:00Z",
		message: { role: "user", content: text, timestamp: 0 },
	}
}
function assistantTextEntry(text: string, id = "a1", parentId: string | null = null): unknown {
	return assistantBlocksEntry([{ type: "text", text }], id, parentId)
}

// Variant that builds an assistant entry from arbitrary content blocks (text,
// thinking, toolCall). Used by replay tests to drop in mixed-block fixtures
// without re-spelling the message envelope each time.
function assistantBlocksEntry(content: unknown[], id = "a1", parentId: string | null = null): unknown {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-05-09T00:00:01Z",
		message: {
			role: "assistant",
			content,
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 0,
		},
	}
}

function toolResultEntry(
	toolCallId: string,
	toolName: string,
	text: string,
	isError = false,
	id = `tr-${toolCallId}`,
	parentId: string | null = null,
): unknown {
	return {
		type: "message",
		id,
		parentId,
		timestamp: "2026-05-09T00:00:02Z",
		message: {
			role: "toolResult",
			toolCallId,
			toolName,
			content: [{ type: "text", text }],
			isError,
			timestamp: 0,
		},
	}
}

function testEncodeCwdDir(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
}

describe("KimchiAcpAgent loadSession", () => {
	function makeAgent(loader: AcpSessionLoader, opts?: { conn?: AgentSideConnection }): KimchiAcpAgent {
		return new KimchiAcpAgent(opts?.conn ?? makeConn(), {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: async () => asSession(new FakeAgentSession("unused")),
			sessionLoader: loader,
		})
	}

	it("advertises loadSession capability in initialize", async () => {
		const agent = makeAgent(async () => asSession(new FakeAgentSession("unused")))
		const init = await agent.initialize({
			protocolVersion: 1,
			clientCapabilities: {} as never,
		} as never)
		expect(init.agentCapabilities?.loadSession).toBe(true)
		expect(init.agentCapabilities?.sessionCapabilities?.close).toEqual({})
	})

	it("rejects loadSession when mcpServers is non-empty (does not invoke loader)", async () => {
		const loaderCalls = { count: 0 }
		const loader: AcpSessionLoader = async () => {
			loaderCalls.count++
			return asSession(new FakeAgentSession("unused"))
		}
		const agent = makeAgent(loader)
		await expect(
			agent.loadSession({
				sessionId: "s1",
				cwd: "/tmp",
				// biome-ignore lint/suspicious/noExplicitAny: only the shape we care about
				mcpServers: [{ name: "x", command: "x", args: [] } as any],
			}),
		).rejects.toMatchObject({ code: -32602 })
		expect(loaderCalls.count).toBe(0)
	})

	it("replays and returns an already loaded session without reopening it", async () => {
		const loaderCalls = { count: 0 }
		const live = new FakeAgentSession("live-1")
		live.branch = [userTextEntry("already here", "u1", null)]
		const factory: AcpSessionFactory = async () => asSession(live)
		const loader: AcpSessionLoader = async () => {
			loaderCalls.count++
			return asSession(new FakeAgentSession("unused"))
		}
		const { conn, updates } = makeRecordingConn()
		const agent = new KimchiAcpAgent(conn, {
			extensionFactories: [],
			agentDir: "/tmp/fake-agent-dir",
			sessionFactory: factory,
			sessionLoader: loader,
		})
		await agent.newSession({ cwd: "/tmp", mcpServers: [] })

		const res = await agent.loadSession({ sessionId: "live-1", cwd: "/tmp", mcpServers: [] })

		expect(res.models).toMatchObject({
			currentModelId: "test/test-model",
		})
		expect(loaderCalls.count).toBe(0)
		expect(updates).toHaveLength(1)
		expect(updates[0].update).toMatchObject({
			sessionUpdate: "user_message_chunk",
			content: { type: "text", text: "already here" },
		})
	})

	it("coalesces concurrent loadSession requests for the same sessionId", async () => {
		const fake = new FakeAgentSession("coalesce-1")
		let loaderCalls = 0
		let markLoaderStarted!: () => void
		let releaseLoader!: () => void
		const loaderStarted = new Promise<void>((resolve) => {
			markLoaderStarted = resolve
		})
		const release = new Promise<void>((resolve) => {
			releaseLoader = resolve
		})
		const loader: AcpSessionLoader = async () => {
			loaderCalls++
			markLoaderStarted()
			await release
			return asSession(fake)
		}
		const agent = makeAgent(loader)
		const first = agent.loadSession({ sessionId: "coalesce-1", cwd: "/tmp", mcpServers: [] })
		await loaderStarted
		const second = agent.loadSession({ sessionId: "coalesce-1", cwd: "/tmp", mcpServers: [] })
		releaseLoader()

		await expect(Promise.all([first, second])).resolves.toHaveLength(2)
		expect(loaderCalls).toBe(1)
	})

	it("propagates loader errors (e.g. missing file → invalidParams)", async () => {
		const agent = makeAgent(async () => {
			throw Object.assign(new Error("session not found"), { code: -32602 })
		})
		await expect(agent.loadSession({ sessionId: "missing", cwd: "/tmp", mcpServers: [] })).rejects.toThrow(
			/session not found/,
		)
	})

	it("rejects default-loaded sessions whose header cwd disagrees before opening", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "kimchi-acp-load-"))
		try {
			const sessionId = "cwd-mismatch"
			const requestedCwd = "/tmp/requested"
			const sessionDir = join(agentDir, "sessions", testEncodeCwdDir(requestedCwd))
			mkdirSync(sessionDir, { recursive: true })
			writeFileSync(
				join(sessionDir, `2026-05-09T00-00-00.000Z_${sessionId}.jsonl`),
				`${JSON.stringify({
					type: "session",
					version: 3,
					id: sessionId,
					timestamp: "2026-05-09T00:00:00Z",
					cwd: "/tmp/other",
				})}\n`,
			)
			const agent = new KimchiAcpAgent(makeConn(), {
				extensionFactories: [],
				agentDir,
				sessionFactory: async () => asSession(new FakeAgentSession("unused")),
			})

			await expect(agent.loadSession({ sessionId, cwd: requestedCwd, mcpServers: [] })).rejects.toThrow(
				/session cwd \/tmp\/other does not match requested cwd \/tmp\/requested/,
			)
		} finally {
			rmSync(agentDir, { recursive: true, force: true })
		}
	})

	it("disposes the session if subscribe throws during loadSession", async () => {
		const leaky = new FakeAgentSession("leak-1")
		leaky.subscribe = () => {
			throw new Error("subscribe boom")
		}
		const agent = makeAgent(async () => asSession(leaky))
		await expect(agent.loadSession({ sessionId: "leak-1", cwd: "/tmp", mcpServers: [] })).rejects.toThrow(
			/subscribe boom/,
		)
		expect(leaky.disposed).toBe(true)
	})

	it("unwinds registration and disposes the session if replay throws", async () => {
		// Pin the atomic-ownership invariant: a throw during replay must remove
		// the session from the registry AND dispose it, otherwise the id stays
		// "live" while loadSession rejects — blocking re-load with invalidRequest.
		const fake = new FakeAgentSession("replay-boom")
		fake.sessionManager = {
			getBranch: () => {
				throw new Error("branch read failed")
			},
		}
		const agent = makeAgent(async () => asSession(fake))
		await expect(agent.loadSession({ sessionId: "replay-boom", cwd: "/tmp", mcpServers: [] })).rejects.toThrow(
			/branch read failed/,
		)
		expect(fake.disposed).toBe(true)
		// Re-load must not see the failed session as already-live.
		fake.sessionManager = { getBranch: () => [] }
		fake.disposed = false
		await expect(agent.loadSession({ sessionId: "replay-boom", cwd: "/tmp", mcpServers: [] })).resolves.toBeDefined()
	})

	it("replays user/assistant text turns as session/update notifications before the response resolves", async () => {
		const fake = new FakeAgentSession("loaded-1")
		fake.model = { provider: "test", id: "test-model", name: "Test Model" }
		fake.modelRegistry = {
			getAvailable: () => [{ provider: "test", id: "test-model", name: "Test Model" }],
		}
		fake.branch = [
			userTextEntry("hello", "u1", null),
			assistantTextEntry("hi there", "a1", "u1"),
			userTextEntry("how are you?", "u2", "a1"),
			assistantTextEntry("doing well", "a2", "u2"),
		]
		const { conn, updates } = makeRecordingConn()
		const agent = makeAgent(async () => asSession(fake), { conn })

		// Capture the order: replay notifications must land BEFORE the response
		// resolves so Zed sees a coherent transcript on the load promise.
		const updatesAtResolve: (typeof updates)[number][] = []
		const original = (conn as unknown as { sessionUpdate: (p: SessionNotification) => Promise<void> }).sessionUpdate
		;(conn as unknown as { sessionUpdate: (p: SessionNotification) => Promise<void> }).sessionUpdate = async (
			p: SessionNotification,
		) => {
			await original(p)
		}

		const res = await agent.loadSession({
			sessionId: "loaded-1",
			cwd: "/tmp",
			mcpServers: [],
		})
		// Snapshot updates seen at this point (ie. before any further awaits).
		updatesAtResolve.push(...updates)

		expect(updatesAtResolve).toHaveLength(4)
		expect(updatesAtResolve[0].update).toMatchObject({
			sessionUpdate: "user_message_chunk",
			content: { type: "text", text: "hello" },
		})
		expect(updatesAtResolve[1].update).toMatchObject({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "hi there" },
		})
		expect(updatesAtResolve[2].update).toMatchObject({
			sessionUpdate: "user_message_chunk",
			content: { type: "text", text: "how are you?" },
		})
		expect(updatesAtResolve[3].update).toMatchObject({
			sessionUpdate: "agent_message_chunk",
			content: { type: "text", text: "doing well" },
		})
		expect(res.models).toMatchObject({
			currentModelId: "test/test-model",
			availableModels: [{ modelId: "test/test-model", name: "Test Model" }],
		})
	})

	// Replay walker: text + thinking + tool calls all surface as their own
	// session/update notifications; non-message entries (compaction,
	// branch_summary, model_change, custom) emit nothing. The block of tests
	// below exercises one fixture per kind plus a combined fixture.

	it("rejects a load whose session-header id disagrees with the requested sessionId", async () => {
		// Defensive: pi reads sessionId from the JSONL header, not the file
		// name. A corrupt / hand-edited session whose header drifted from the
		// filename would otherwise land in `sessions` under a different key
		// than the client knows, and subsequent prompts would 404 even though
		// the file is held open.
		const fake = new FakeAgentSession("header-id")
		const loader: AcpSessionLoader = async () => asSession(fake)
		const agent = makeAgent(loader)
		await expect(agent.loadSession({ sessionId: "requested-id", cwd: "/tmp", mcpServers: [] })).rejects.toMatchObject({
			code: -32602,
		})
		expect(fake.disposed).toBe(true)
	})

	it("coalesces contiguous text blocks within an assistant message into one chunk", async () => {
		// Replay contract: emit the full message as a single chunk. Adjacent
		// text blocks (rare but legal) must merge into one agent_message_chunk;
		// structural blocks (thinking / toolCall) flush the buffer so ordering
		// stays faithful.
		const fake = new FakeAgentSession("loaded-coalesce")
		fake.branch = [
			userTextEntry("go", "u1", null),
			assistantBlocksEntry(
				[
					{ type: "text", text: "first " },
					{ type: "text", text: "second" },
					{ type: "thinking", thinking: "pondering" },
					{ type: "text", text: "third" },
				],
				"a1",
				"u1",
			),
		]
		const { conn, updates } = makeRecordingConn()
		const agent = makeAgent(async () => asSession(fake), { conn })
		await agent.loadSession({ sessionId: "loaded-coalesce", cwd: "/tmp", mcpServers: [] })
		expect(updates.map((u) => u.update.sessionUpdate)).toEqual([
			"user_message_chunk",
			"agent_message_chunk",
			"agent_thought_chunk",
			"agent_message_chunk",
		])
		expect((updates[1].update as { content: { text: string } }).content.text).toBe("first second")
		expect((updates[3].update as { content: { text: string } }).content.text).toBe("third")
	})

	it("routes ANSI-dimmed replay text to thought chunks and strips remaining ANSI", async () => {
		// hide-thinking-aware models (DeepSeek, QwQ) plus hideThinkingBlock=false
		// persist text with ANSI dim escapes around inner <think> content. The
		// live TUI renders them as reasoning; ACP's text content type is
		// plaintext, so replay must preserve that semantic split explicitly.
		const dimmed = "before \x1b[2minner\x1b[22m after"
		const fake = new FakeAgentSession("loaded-ansi")
		fake.branch = [
			userTextEntry("go", "u1", null),
			assistantBlocksEntry(
				[
					{ type: "text", text: dimmed },
					{ type: "thinking", thinking: "raw \x1b[2mthought\x1b[22m" },
				],
				"a1",
				"u1",
			),
		]
		const { conn, updates } = makeRecordingConn()
		const agent = makeAgent(async () => asSession(fake), { conn })
		await agent.loadSession({ sessionId: "loaded-ansi", cwd: "/tmp", mcpServers: [] })
		const messageTexts = updates
			.filter((u) => u.update.sessionUpdate === "agent_message_chunk")
			.map((u) => (u.update as { content: { text: string } }).content.text)
		const thoughtTexts = updates
			.filter((u) => u.update.sessionUpdate === "agent_thought_chunk")
			.map((u) => (u.update as { content: { text: string } }).content.text)
		expect(messageTexts).toEqual(["before ", " after"])
		expect(thoughtTexts).toEqual(["inner", "raw thought"])
	})

	it("drops ANSI-dimmed replay thinking when hideThinkingBlock is enabled", async () => {
		_setHideThinking(true)
		try {
			const fake = new FakeAgentSession("loaded-ansi-hidden")
			fake.branch = [
				userTextEntry("go", "u1", null),
				assistantBlocksEntry([{ type: "text", text: "before \x1b[2minner\x1b[22m after" }], "a1", "u1"),
			]
			const { conn, updates } = makeRecordingConn()
			const agent = makeAgent(async () => asSession(fake), { conn })
			await agent.loadSession({ sessionId: "loaded-ansi-hidden", cwd: "/tmp", mcpServers: [] })
			const messageTexts = updates
				.filter((u) => u.update.sessionUpdate === "agent_message_chunk")
				.map((u) => (u.update as { content: { text: string } }).content.text)
			expect(updates.find((u) => u.update.sessionUpdate === "agent_thought_chunk")).toBeUndefined()
			expect(messageTexts).toEqual(["before  after"])
		} finally {
			_resetHideThinking()
		}
	})

	it("treats a concurrent session/cancel during replay as a no-op (no turn active)", async () => {
		const fake = new FakeAgentSession("loaded-cancel")
		fake.branch = [userTextEntry("hi", "u1", null)]
		const agent = makeAgent(async () => asSession(fake))
		await agent.loadSession({ sessionId: "loaded-cancel", cwd: "/tmp", mcpServers: [] })
		// No turn was created during loadSession, so cancel must not throw and
		// must not invoke abort with side effects beyond the no-op session.abort.
		await expect(agent.cancel({ sessionId: "loaded-cancel" })).resolves.toBeUndefined()
	})

	it("rejects loaded sessions with no model", async () => {
		const fake = new FakeAgentSession("loaded-no-model")
		fake.model = undefined
		fake.branch = []
		const agent = makeAgent(async () => asSession(fake))
		await expect(
			agent.loadSession({
				sessionId: "loaded-no-model",
				cwd: "/tmp",
				mcpServers: [],
			}),
		).rejects.toMatchObject({ code: -32000 })
		expect(fake.disposed).toBe(true)
	})

	it("registers the loaded session so a follow-up prompt is accepted", async () => {
		const fake = new FakeAgentSession("loaded-prompt")
		fake.branch = [userTextEntry("prior", "u1", null)]
		const agent = makeAgent(async () => asSession(fake))
		await agent.loadSession({ sessionId: "loaded-prompt", cwd: "/tmp", mcpServers: [] })
		// Drive a turn through the loaded session — short-circuit path is fine,
		// we just need to confirm prompt() doesn't reject with "unknown
		// sessionId" (which would mean the load registration failed).
		fake.promptImpl = async () => {}
		const res = await agent.prompt({
			sessionId: "loaded-prompt",
			prompt: [{ type: "text", text: "follow up" }],
		})
		expect(res.stopReason).toBe("end_turn")
	})

	// Per ToolKind: replayed tool calls should produce the same shape as live
	// turns — an initial tool_call carrying the kind/title/locations, followed
	// by a single terminal tool_call_update that pins status + content. This
	// matrix locks in describeToolCall coverage on the replay path so a future
	// kind addition doesn't silently bypass replay.
	const toolKindMatrix: Array<{
		name: string
		toolName: string
		args: Record<string, unknown>
		result: { text: string; isError?: boolean }
		expect: { kind: string; title: string; status: string; locations: Array<{ path: string }> }
	}> = [
		{
			name: "bash → execute",
			toolName: "bash",
			args: { command: "ls -la" },
			result: { text: "ok" },
			expect: { kind: "execute", title: "ls -la", status: "completed", locations: [] },
		},
		{
			name: "read → read with location",
			toolName: "read",
			args: { file_path: "/tmp/a.ts" },
			result: { text: "contents" },
			expect: { kind: "read", title: "/tmp/a.ts", status: "completed", locations: [{ path: "/tmp/a.ts" }] },
		},
		{
			name: "edit → edit with location",
			toolName: "edit",
			args: { file_path: "/tmp/b.ts" },
			result: { text: "edited" },
			expect: { kind: "edit", title: "/tmp/b.ts", status: "completed", locations: [{ path: "/tmp/b.ts" }] },
		},
		{
			name: "grep → search",
			toolName: "grep",
			args: { pattern: "foo" },
			result: { text: "match" },
			expect: { kind: "search", title: "foo", status: "completed", locations: [] },
		},
		{
			name: "ls → read",
			toolName: "ls",
			args: { path: "/tmp" },
			result: { text: "listing" },
			expect: { kind: "read", title: "/tmp", status: "completed", locations: [{ path: "/tmp" }] },
		},
		{
			name: "find → search",
			toolName: "find",
			args: { pattern: "*.ts" },
			result: { text: "found" },
			expect: { kind: "search", title: "*.ts", status: "completed", locations: [] },
		},
		{
			name: "web_fetch → fetch",
			toolName: "web_fetch",
			args: { url: "https://example.com" },
			result: { text: "html" },
			expect: { kind: "fetch", title: "web_fetch", status: "completed", locations: [] },
		},
		{
			name: "Agent → think",
			toolName: "Agent",
			args: { prompt: "go" },
			result: { text: "done" },
			expect: { kind: "think", title: "Agent", status: "completed", locations: [] },
		},
		{
			name: "unknown tool → other",
			toolName: "mcp__foo__bar",
			args: { arg: 1 },
			result: { text: "ok" },
			expect: { kind: "other", title: "mcp__foo__bar", status: "completed", locations: [] },
		},
	]
	for (const c of toolKindMatrix) {
		it(`replays tool call (${c.name}) as tool_call + terminal tool_call_update`, async () => {
			const fake = new FakeAgentSession(`loaded-tool-${c.toolName}`)
			fake.branch = [
				userTextEntry("go", "u1", null),
				assistantBlocksEntry([{ type: "toolCall", id: "tc-1", name: c.toolName, arguments: c.args }], "a1", "u1"),
				toolResultEntry("tc-1", c.toolName, c.result.text, c.result.isError ?? false, "tr1", "a1"),
			]
			const { conn, updates } = makeRecordingConn()
			const agent = makeAgent(async () => asSession(fake), { conn })
			await agent.loadSession({ sessionId: fake.sessionId, cwd: "/tmp", mcpServers: [] })
			const seq = updates.map((u) => u.update.sessionUpdate)
			expect(seq).toEqual(["user_message_chunk", "tool_call", "tool_call_update"])

			const toolCall = updates[1].update as Record<string, unknown>
			expect(toolCall).toMatchObject({
				sessionUpdate: "tool_call",
				toolCallId: "tc-1",
				kind: c.expect.kind,
				title: c.expect.title,
				status: c.expect.status,
				locations: c.expect.locations,
				rawInput: c.args,
			})
			const update = updates[2].update as Record<string, unknown>
			expect(update).toMatchObject({
				sessionUpdate: "tool_call_update",
				toolCallId: "tc-1",
				status: c.expect.status,
			})
			const content = (update as { content: Array<{ content: { text: string } }> }).content
			expect(content[0].content.text).toBe(c.result.text)
		})
	}

	it("replays a denied/failed tool call with status failed and the persisted error content", async () => {
		const fake = new FakeAgentSession("loaded-tool-fail")
		fake.branch = [
			userTextEntry("go", "u1", null),
			assistantBlocksEntry(
				[{ type: "toolCall", id: "tc-deny", name: "bash", arguments: { command: "rm -rf /" } }],
				"a1",
				"u1",
			),
			toolResultEntry("tc-deny", "bash", "permission denied", true, "tr1", "a1"),
		]
		const { conn, updates } = makeRecordingConn()
		const agent = makeAgent(async () => asSession(fake), { conn })
		await agent.loadSession({ sessionId: "loaded-tool-fail", cwd: "/tmp", mcpServers: [] })
		const toolCall = updates[1].update as { status?: string }
		const update = updates[2].update as { status?: string; content: Array<{ content: { text: string } }> }
		expect(toolCall.status).toBe("failed")
		expect(update.status).toBe("failed")
		expect(update.content[0].content.text).toBe("permission denied")
	})

	it("replays an interrupted tool call (no persisted result) as failed with empty content", async () => {
		// Session was killed mid tool execution; the tool result never landed in
		// the JSONL. "failed" is the only honest terminal status we can synthesize
		// — leaving it in_progress would hang the client's spinner forever.
		const fake = new FakeAgentSession("loaded-tool-orphan")
		fake.branch = [
			userTextEntry("go", "u1", null),
			assistantBlocksEntry(
				[{ type: "toolCall", id: "tc-orphan", name: "bash", arguments: { command: "sleep 100" } }],
				"a1",
				"u1",
			),
		]
		const { conn, updates } = makeRecordingConn()
		const agent = makeAgent(async () => asSession(fake), { conn })
		await agent.loadSession({ sessionId: "loaded-tool-orphan", cwd: "/tmp", mcpServers: [] })
		expect(updates.map((u) => u.update.sessionUpdate)).toEqual(["user_message_chunk", "tool_call", "tool_call_update"])
		const toolCall = updates[1].update as { status?: string }
		const update = updates[2].update as { status?: string; content: unknown[] }
		expect(toolCall.status).toBe("failed")
		expect(update.status).toBe("failed")
		expect(update.content).toEqual([])
	})

	it("replays thinking blocks as agent_thought_chunk with raw text (no ANSI)", async () => {
		const fake = new FakeAgentSession("loaded-thinking")
		fake.branch = [
			userTextEntry("go", "u1", null),
			assistantBlocksEntry([{ type: "thinking", thinking: "considering options" }], "a1", "u1"),
		]
		const { conn, updates } = makeRecordingConn()
		const agent = makeAgent(async () => asSession(fake), { conn })
		await agent.loadSession({ sessionId: "loaded-thinking", cwd: "/tmp", mcpServers: [] })
		const thought = updates.find((u) => u.update.sessionUpdate === "agent_thought_chunk")
		expect(thought).toBeDefined()
		const content = (thought?.update as { content: { type: string; text: string } }).content
		expect(content.text).toBe("considering options")
		// No ANSI escape codes — filterThinkingForDisplay returns dimmed text
		// for live TUI rendering, but ACP clients can't render escapes. Replay
		// uses the helper as a yes/no predicate and emits the raw thinking.
		expect(content.text.includes("\x1b[")).toBe(false)
	})

	it("skips thinking blocks when hideThinkingBlock is enabled (shared with hide-thinking extension)", async () => {
		// Same redaction rule the live TUI uses — verified by sharing
		// filterThinkingForDisplay across both code paths so a setting flip
		// doesn't drift between live and replay.
		_setHideThinking(true)
		try {
			const fake = new FakeAgentSession("loaded-thinking-hidden")
			fake.branch = [
				userTextEntry("go", "u1", null),
				assistantBlocksEntry([{ type: "thinking", thinking: "considering options" }], "a1", "u1"),
			]
			const { conn, updates } = makeRecordingConn()
			const agent = makeAgent(async () => asSession(fake), { conn })
			await agent.loadSession({ sessionId: "loaded-thinking-hidden", cwd: "/tmp", mcpServers: [] })
			expect(updates.find((u) => u.update.sessionUpdate === "agent_thought_chunk")).toBeUndefined()
		} finally {
			_resetHideThinking()
		}
	})

	it("skips redacted thinking blocks even when hideThinkingBlock is off", async () => {
		// Redacted thinking has only an opaque encrypted payload (in
		// thinkingSignature) for multi-turn provider continuity — no plaintext
		// to surface to the user.
		const fake = new FakeAgentSession("loaded-thinking-redacted")
		fake.branch = [
			userTextEntry("go", "u1", null),
			assistantBlocksEntry(
				[{ type: "thinking", thinking: "ignored", redacted: true, thinkingSignature: "opaque" }],
				"a1",
				"u1",
			),
		]
		const { conn, updates } = makeRecordingConn()
		const agent = makeAgent(async () => asSession(fake), { conn })
		await agent.loadSession({ sessionId: "loaded-thinking-redacted", cwd: "/tmp", mcpServers: [] })
		expect(updates.find((u) => u.update.sessionUpdate === "agent_thought_chunk")).toBeUndefined()
	})

	it("emits zero notifications for compaction / branch_summary / model_change / custom entries", async () => {
		// Non-message entries are LLM-context artifacts (or, for model_change,
		// already conveyed via the load response's models field). Surfacing
		// them as session updates would make Zed's transcript UI churn through
		// historical state changes the user never saw the first time around.
		const fake = new FakeAgentSession("loaded-skip-only")
		fake.branch = [
			{ type: "model_change", id: "mc1", parentId: null, timestamp: "x", provider: "p", modelId: "m" },
			{
				type: "compaction",
				id: "c1",
				parentId: "mc1",
				timestamp: "x",
				summary: "snip",
				firstKeptEntryId: "u1",
				tokensBefore: 0,
			},
			{ type: "branch_summary", id: "bs1", parentId: "c1", timestamp: "x", summary: "branch" },
			{ type: "custom", id: "cu1", parentId: "bs1", timestamp: "x", payload: { whatever: true } },
		]
		const { conn, updates } = makeRecordingConn()
		const agent = makeAgent(async () => asSession(fake), { conn })
		await agent.loadSession({ sessionId: "loaded-skip-only", cwd: "/tmp", mcpServers: [] })
		expect(updates).toHaveLength(0)
	})

	it("replays a mixed transcript end-to-end (text, thinking, tool, skipped entries, follow-up text)", async () => {
		const fake = new FakeAgentSession("loaded-mixed")
		fake.branch = [
			userTextEntry("question", "u1", null),
			assistantBlocksEntry(
				[
					{ type: "text", text: "let me check" },
					{ type: "thinking", thinking: "weighing options" },
					{ type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "ls" } },
				],
				"a1",
				"u1",
			),
			toolResultEntry("tc-1", "bash", "file1\nfile2", false, "tr1", "a1"),
			// Skipped entries scattered through the branch must not break the walker.
			{ type: "model_change", id: "mc1", parentId: "tr1", timestamp: "x", provider: "p", modelId: "m" },
			{
				type: "compaction",
				id: "c1",
				parentId: "mc1",
				timestamp: "x",
				summary: "snip",
				firstKeptEntryId: "u1",
				tokensBefore: 0,
			},
			assistantTextEntry("here is what I found", "a2", "c1"),
		]
		const { conn, updates } = makeRecordingConn()
		const agent = makeAgent(async () => asSession(fake), { conn })
		await agent.loadSession({ sessionId: "loaded-mixed", cwd: "/tmp", mcpServers: [] })
		// Order is significant: tool_call must precede tool_call_update, and
		// the post-skipped-entries assistant text must land last.
		expect(updates.map((u) => u.update.sessionUpdate)).toEqual([
			"user_message_chunk",
			"agent_message_chunk",
			"agent_thought_chunk",
			"tool_call",
			"tool_call_update",
			"agent_message_chunk",
		])
	})

	it("does not deliver synthetic agent_* events to session subscribers during replay", async () => {
		// Acceptance criterion from the plan: extensions registered on a loaded
		// session must not see the historical turns as if they were live —
		// otherwise telemetry/loop-guard/etc. would double-count. Replay sends
		// notifications straight to conn.sessionUpdate, never via emit().
		const fake = new FakeAgentSession("loaded-no-events")
		fake.branch = [
			userTextEntry("hi", "u1", null),
			assistantBlocksEntry(
				[
					{ type: "text", text: "hello" },
					{ type: "thinking", thinking: "thinking" },
					{ type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "ls" } },
				],
				"a1",
				"u1",
			),
			toolResultEntry("tc-1", "bash", "out", false, "tr1", "a1"),
		]
		// Pre-subscribe a counter BEFORE loadSession so it sits alongside the
		// agent's own subscriber; if replay went through the event emitter we'd
		// see agent_start / message_update / tool_execution_* / agent_end here.
		let extensionEventCount = 0
		fake.subscribe(() => {
			extensionEventCount++
		})
		const agent = makeAgent(async () => asSession(fake))
		await agent.loadSession({ sessionId: "loaded-no-events", cwd: "/tmp", mcpServers: [] })
		expect(extensionEventCount).toBe(0)
	})

	it("replays a 200-turn session well within a generous bound (regression guard)", async () => {
		// Regression guard against quadratic walker behavior. The fake skips
		// disk I/O and JSON-RPC framing — what's actually under test is that
		// the walker stays O(N). Bound is loose (3s) because shared CI runners
		// are noisy; a real regression would blow past it by orders of
		// magnitude.
		const fake = new FakeAgentSession("loaded-perf")
		const branch: unknown[] = []
		for (let i = 0; i < 200; i++) {
			branch.push(userTextEntry(`q${i}`, `u${i}`, i === 0 ? null : `a${i - 1}`))
			branch.push(
				assistantBlocksEntry(
					[
						{ type: "text", text: `a${i}` },
						{ type: "toolCall", id: `tc-${i}`, name: "bash", arguments: { command: `echo ${i}` } },
					],
					`a${i}`,
					`u${i}`,
				),
			)
			branch.push(toolResultEntry(`tc-${i}`, "bash", `out${i}`, false, `tr-${i}`, `a${i}`))
		}
		fake.branch = branch
		const agent = makeAgent(async () => asSession(fake))
		const start = Date.now()
		await agent.loadSession({ sessionId: "loaded-perf", cwd: "/tmp", mcpServers: [] })
		const elapsed = Date.now() - start
		expect(elapsed).toBeLessThan(3000)
	})
})

describe("shouldEmitThinking", () => {
	it("returns true by default (hideThinkingBlock unset)", () => {
		_resetHideThinking()
		expect(shouldEmitThinking("anything")).toBe(true)
	})
	it("returns false when hideThinkingBlock is enabled", () => {
		_setHideThinking(true)
		try {
			expect(shouldEmitThinking("anything")).toBe(false)
		} finally {
			_resetHideThinking()
		}
	})
	it("does not break when the persisted thinking text contains a literal </think>", () => {
		// Regression: a previous version probed filterThinkingForDisplay with a
		// synthetic <think>${thinking}</think> wrapper. Models self-quoting
		// "</think>" closed the wrapper early and the inner text leaked, making
		// the predicate non-deterministic. Reading the setting directly avoids
		// the round-trip entirely.
		_resetHideThinking()
		const haunted = "I'll stop now. </think> trailing"
		expect(shouldEmitThinking(haunted)).toBe(true)
		_setHideThinking(true)
		try {
			expect(shouldEmitThinking(haunted)).toBe(false)
		} finally {
			_resetHideThinking()
		}
	})
})

describe("stripAnsi", () => {
	it("returns unchanged text when no ANSI escapes are present", () => {
		expect(stripAnsi("plain text")).toBe("plain text")
	})
	it("removes CSI sequences (color, dim, reset) without touching surrounding text", () => {
		expect(stripAnsi("\x1b[2mfoo\x1b[22m bar")).toBe("foo bar")
		expect(stripAnsi("\x1b[31mred\x1b[0m and \x1b[1mbold\x1b[0m")).toBe("red and bold")
	})
	it("leaves a stray ESC byte (no full sequence) untouched", () => {
		// Conservative scrub: only `\x1b[…<letter>` is dropped. A bare ESC
		// without a CSI body isn't styling and shouldn't be mangled.
		expect(stripAnsi("plain\x1bbody")).toBe("plain\x1bbody")
	})
})

describe("userMessageText", () => {
	it("returns string content unchanged for user messages", () => {
		expect(userMessageText("hello world")).toBe("hello world")
	})
	it("joins text blocks and skips images for user messages", () => {
		expect(
			userMessageText([
				{ type: "text", text: "hi " },
				{ type: "image", data: "x", mimeType: "image/png" },
				{ type: "text", text: "there" },
			]),
		).toBe("hi there")
	})
	it("returns empty string for null / non-array user content", () => {
		expect(userMessageText(null)).toBe("")
		expect(userMessageText(42)).toBe("")
	})
})
