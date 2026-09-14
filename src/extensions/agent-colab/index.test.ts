import { randomUUID } from "node:crypto"
import { appendFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import { sendMessage } from "./client.js"
import agentColab from "./index.js"
import { listLivePeers, type PeerRecord, registerPeer, removePeer } from "./registry.js"

// ---------------------------------------------------------------------------
// Mock pi harness

type Handler = (event: unknown, ctx: unknown) => unknown

function mockPi() {
	const handlers = new Map<string, Handler[]>()
	const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = []
	const sent: Array<{ msg: Record<string, unknown>; opts?: Record<string, unknown> }> = []
	const commands: string[] = []
	const commandHandlers = new Map<string, (args: string, ctx: unknown) => Promise<void>>()
	const pi = {
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? []
			list.push(handler)
			handlers.set(event, list)
		},
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) => {
			tools.push(tool)
		},
		registerCommand: (name: string, opts: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands.push(name)
			commandHandlers.set(name, opts.handler)
		},
		registerMessageRenderer: vi.fn(),
		registerSkill: vi.fn(),
		events: { on: vi.fn(), emit: vi.fn() },
		getFlag: vi.fn(),
		sendMessage: vi.fn(async (msg: Record<string, unknown>, opts?: Record<string, unknown>) => {
			sent.push({ msg, opts })
		}),
	}
	const emit = async (event: string, payload: unknown, ctx?: unknown) => {
		const results: unknown[] = []
		for (const handler of handlers.get(event) ?? []) {
			results.push(await handler(payload, ctx))
		}
		return results
	}
	return { pi, handlers, tools, sent, commands, commandHandlers, emit }
}

// ---------------------------------------------------------------------------

let dir: string
let sessionId: string
let sessionFile: string
let idle: boolean
let confirmResult: boolean

function baseCtx() {
	return {
		mode: "tui",
		hasUI: true,
		cwd: "/tmp/fake-project",
		isIdle: () => idle,
		ui: {
			select: vi.fn(async () => undefined),
			confirm: vi.fn(async () => confirmResult),
			input: vi.fn(async () => undefined),
			notify: vi.fn(),
		},
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionName: () => "test-session",
			getSessionFile: () => sessionFile,
		},
		model: undefined,
	}
}

const ASSISTANT_LINE = `${JSON.stringify({
	type: "message",
	message: { role: "assistant", content: [{ type: "text", text: "the fix is in src/x.ts" }] },
})}\n`

function readRecord(): PeerRecord {
	const entry = listLivePeers(dir).find((e) => e.record.sessionId === sessionId)
	if (!entry) throw new Error("peer record not found")
	return entry.record
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agent-colab-index-"))
	sessionId = randomUUID()
	sessionFile = join(dir, "session.jsonl")
	writeFileSync(
		sessionFile,
		`{"type":"session","id":"${sessionId}"}\n{"type":"message","message":{"role":"user","content":[]}}\n`,
	)
	idle = true
	confirmResult = true
})

describe("agent-colab extension", () => {
	it("session_start wires server, registry, tools, and command; inbound reply round-trips", async () => {
		const harness = mockPi()
		agentColab(harness.pi as never, { registryDir: dir, replyTimeoutMs: 5000, inbound: "accept" })
		const ctx = baseCtx()
		await harness.emit("session_start", { reason: "startup" }, ctx)

		// Registry record exists with a bound port; 5 tools + /colab + renderer.
		const record = readRecord()
		expect(record.port).toBeGreaterThan(0)
		expect(record.name).toBe("test-session")
		expect(record.token).toBeTruthy()
		expect(harness.tools.map((t) => t.name).sort()).toEqual([
			"ask_peer",
			"link_peer",
			"list_peers",
			"message_peer",
			"unlink_peer",
		])
		expect(harness.commands).toContain("colab")
		expect(harness.pi.registerMessageRenderer).toHaveBeenCalled()

		// Inbound delivery: idle → followUp + triggerTurn; reply captured from session file.
		const replyPromise = sendMessage(record.port, "please check the flaky test", {
			token: record.token,
			fromName: "peer-b",
			timeoutMs: 5000,
		})
		await vi.waitFor(() => expect(harness.sent.length).toBe(1))
		expect(harness.sent[0].opts).toMatchObject({ deliverAs: "followUp", triggerTurn: true })
		const text = (harness.sent[0].msg.content as Array<{ text: string }>)[0].text
		expect(text).toContain("[peer message from peer-b]")
		expect(text).toContain("please check the flaky test")

		// Agent "replies": append an assistant entry, then settle.
		appendFileSync(sessionFile, ASSISTANT_LINE)
		await harness.emit("agent_settled", {}, ctx)
		const result = await replyPromise
		expect(result.state).toBe("completed")
		expect(result.reply).toBe("the fix is in src/x.ts")
	}, 15_000)

	it("delivers as steer when the agent is busy", async () => {
		const harness = mockPi()
		agentColab(harness.pi as never, { registryDir: dir, replyTimeoutMs: 5000 })
		idle = false
		await harness.emit("session_start", { reason: "startup" }, baseCtx())
		const record = readRecord()

		const replyPromise = sendMessage(record.port, "heads up", {
			token: record.token,
			fromName: "peer-b",
			timeoutMs: 5000,
		})
		await vi.waitFor(() => expect(harness.sent.length).toBe(1))
		expect(harness.sent[0].opts).toMatchObject({ deliverAs: "steer" })

		appendFileSync(sessionFile, ASSISTANT_LINE)
		await harness.emit("agent_settled", {}, baseCtx())
		const result = await replyPromise
		expect(result.reply).toBe("the fix is in src/x.ts")
	}, 15_000)

	it("hold + declined confirm fails the task; refuse rejects outright", async () => {
		// hold, user declines — deliver throws; the server settles the task as
		// failed and the sender sees the reason rather than an exception.
		const declined = mockPi()
		agentColab(declined.pi as never, { registryDir: dir, replyTimeoutMs: 5000, inbound: "hold" })
		confirmResult = false
		await declined.emit("session_start", { reason: "startup" }, baseCtx())
		const record = readRecord()
		const heldResult = await sendMessage(record.port, "hi", { token: record.token, fromName: "p", timeoutMs: 5000 })
		expect(heldResult.state).toBe("failed")
		expect(heldResult.reason).toMatch(/held/i)

		// refuse
		const refusing = mockPi()
		agentColab(refusing.pi as never, { registryDir: dir, replyTimeoutMs: 5000, inbound: "refuse" })
		confirmResult = true
		await refusing.emit("session_start", { reason: "startup" }, baseCtx())
		const record2 = readRecord()
		const refusedResult = await sendMessage(record2.port, "hi", {
			token: record2.token,
			fromName: "p",
			timeoutMs: 5000,
		})
		expect(refusedResult.state).toBe("failed")
		expect(refusedResult.reason).toMatch(/refused/i)
	}, 15_000)

	it("hold + approved confirm delivers the message", async () => {
		const harness = mockPi()
		agentColab(harness.pi as never, { registryDir: dir, replyTimeoutMs: 5000, inbound: "hold" })
		confirmResult = true
		await harness.emit("session_start", { reason: "startup" }, baseCtx())
		const record = readRecord()
		const replyPromise = sendMessage(record.port, "approved message", {
			token: record.token,
			fromName: "p",
			timeoutMs: 5000,
		})
		await vi.waitFor(() => expect(harness.sent.length).toBe(1))
		appendFileSync(sessionFile, ASSISTANT_LINE)
		await harness.emit("agent_settled", {}, baseCtx())
		const result = await replyPromise
		expect(result.state).toBe("completed")
	}, 15_000)

	it("notifyWhenIdle pushes a one-shot notice to the sender's inbox", async () => {
		// Capture server standing in for the sender's inbox.
		const received: Array<{ auth?: string; body: string }> = []
		const capture = createServer((req, res) => {
			const chunks: Buffer[] = []
			req.on("data", (c: Buffer) => chunks.push(c))
			req.on("end", () => {
				received.push({ auth: req.headers.authorization, body: Buffer.concat(chunks).toString("utf8") })
				res.writeHead(200, { "Content-Type": "application/json" })
				res.end(
					JSON.stringify({
						jsonrpc: "2.0",
						id: 1,
						result: { id: "task-x", contextId: "c", status: { state: "completed" }, history: [] },
					}),
				)
			})
		})
		const senderPort = await new Promise<number>((resolve) => {
			capture.listen(0, "127.0.0.1", () => resolve((capture.address() as { port: number }).port))
		})

		const harness = mockPi()
		agentColab(harness.pi as never, { registryDir: dir, replyTimeoutMs: 5000 })
		await harness.emit("session_start", { reason: "startup" }, baseCtx())
		const record = readRecord()

		// Register the sender so the notice has a target.
		registerPeer(dir, {
			...readRecord(),
			sessionId: "sender-2222-3333",
			name: "sender-two",
			token: "tok-sender",
			port: senderPort,
		})

		const replyPromise = sendMessage(record.port, "long running thing", {
			token: record.token,
			fromName: "sender-two",
			fromSessionId: "sender-2222-3333",
			notifyWhenIdle: true,
			timeoutMs: 5000,
		})
		await vi.waitFor(() => expect(harness.sent.length).toBe(1))
		appendFileSync(sessionFile, ASSISTANT_LINE)
		await harness.emit("agent_settled", {}, baseCtx())
		const result = await replyPromise
		expect(result.state).toBe("completed")

		// The notice is best-effort async — wait for it on the capture server.
		await vi.waitFor(
			() => {
				expect(received.length).toBe(1)
			},
			{ timeout: 5000 },
		)
		expect(received[0].auth).toBe("Bearer tok-sender")
		const noticeText = (JSON.parse(received[0].body) as { params: { message: { parts: Array<{ text: string }> } } })
			.params.message.parts[0].text
		expect(noticeText).toContain("[peer notice from test-session]")
		expect(noticeText).toContain("the fix is in src/x.ts")

		await new Promise<void>((resolve) => capture.close(() => resolve()))
	}, 20_000)

	it("before_agent_start injects a clause only when peers are linked", async () => {
		const harness = mockPi()
		agentColab(harness.pi as never, { registryDir: dir, replyTimeoutMs: 5000 })
		const ctx = baseCtx()
		await harness.emit("session_start", { reason: "startup" }, ctx)

		// No linked peers → no change.
		expect(await harness.emit("before_agent_start", { systemPrompt: "BASE" }, ctx)).toEqual([undefined])

		// Link via the tool, then the clause appears.
		const linkPeer = harness.tools.find((t) => t.name === "link_peer")
		registerPeer(dir, {
			sessionId: "session-beta",
			pid: process.pid,
			port: 1,
			token: "t",
			name: "beta",
			cwd: "/tmp/beta",
			startedAt: new Date().toISOString(),
		})
		await linkPeer?.execute("c1", { peer: "beta" }, undefined, undefined, ctx)
		const results = await harness.emit("before_agent_start", { systemPrompt: "BASE" }, ctx)
		const clause = (results[0] as { systemPrompt: string }).systemPrompt
		expect(clause).toContain("BASE")
		expect(clause).toContain("Linked peer sessions")
		expect(clause).toContain("beta (session-")
	}, 15_000)

	it("fire-and-forget (expectReply: false) queues discreetly — nextTurn, no forced turn, transport ack", async () => {
		const harness = mockPi()
		agentColab(harness.pi as never, { registryDir: dir, replyTimeoutMs: 5000 })
		await harness.emit("session_start", { reason: "startup" }, baseCtx())
		const record = readRecord()

		const result = await sendMessage(record.port, "fyi: schema migrated", {
			token: record.token,
			fromName: "peer-b",
			expectReply: false,
			timeoutMs: 5000,
		})
		// Transport ack: completed at injection, no agent reply awaited.
		expect(result.state).toBe("completed")
		expect(result.reply).toBe("delivered")
		expect(harness.sent).toHaveLength(1)
		expect(harness.sent[0].opts).toMatchObject({ deliverAs: "nextTurn" })
		expect(harness.sent[0].opts).not.toHaveProperty("triggerTurn", true)

		// No reply waiters: a later settle resolves nothing extra (no spurious sends).
		await harness.emit("agent_settled", {}, baseCtx())
		expect(harness.sent).toHaveLength(1)
	}, 15_000)

	it("fire-and-forget while busy lands as steer; notifyWhenIdle notice fires on settle", async () => {
		// Capture server standing in for the sender's inbox.
		const received: Array<{ body: string }> = []
		const capture = createServer((req, res) => {
			const chunks: Buffer[] = []
			req.on("data", (c: Buffer) => chunks.push(c))
			req.on("end", () => {
				received.push({ body: Buffer.concat(chunks).toString("utf8") })
				res.writeHead(200, { "Content-Type": "application/json" })
				res.end(
					JSON.stringify({ jsonrpc: "2.0", id: 1, result: { id: "t", status: { state: "completed" }, history: [] } }),
				)
			})
		})
		const senderPort = await new Promise<number>((resolve) => {
			capture.listen(0, "127.0.0.1", () => resolve((capture.address() as { port: number }).port))
		})

		const harness = mockPi()
		agentColab(harness.pi as never, { registryDir: dir, replyTimeoutMs: 5000 })
		idle = false
		await harness.emit("session_start", { reason: "startup" }, baseCtx())
		const record = readRecord()
		registerPeer(dir, {
			...readRecord(),
			sessionId: "sender-2222-3333",
			name: "sender-two",
			token: "tok-sender",
			port: senderPort,
		})

		const result = await sendMessage(record.port, "long task heads up", {
			token: record.token,
			fromName: "sender-two",
			fromSessionId: "sender-2222-3333",
			notifyWhenIdle: true,
			expectReply: false,
			timeoutMs: 5000,
		})
		expect(result.state).toBe("completed")
		expect(harness.sent[0].opts).toMatchObject({ deliverAs: "steer" })
		expect(received).toHaveLength(0) // busy → notice waits for settle

		appendFileSync(sessionFile, ASSISTANT_LINE)
		await harness.emit("agent_settled", {}, baseCtx())
		await vi.waitFor(
			() => {
				expect(received.length).toBe(1)
			},
			{ timeout: 5000 },
		)
		const noticeText = (JSON.parse(received[0].body) as { params: { message: { parts: Array<{ text: string }> } } })
			.params.message.parts[0].text
		expect(noticeText).toContain("processed your message")
		expect(noticeText).toContain("the fix is in src/x.ts")

		await new Promise<void>((resolve) => capture.close(() => resolve()))
	}, 20_000)

	it("fire-and-forget + notifyWhenIdle while idle notices immediately (no turn started)", async () => {
		const received: Array<{ body: string }> = []
		const capture = createServer((req, res) => {
			const chunks: Buffer[] = []
			req.on("data", (c: Buffer) => chunks.push(c))
			req.on("end", () => {
				received.push({ body: Buffer.concat(chunks).toString("utf8") })
				res.writeHead(200, { "Content-Type": "application/json" })
				res.end(
					JSON.stringify({ jsonrpc: "2.0", id: 1, result: { id: "t", status: { state: "completed" }, history: [] } }),
				)
			})
		})
		const senderPort = await new Promise<number>((resolve) => {
			capture.listen(0, "127.0.0.1", () => resolve((capture.address() as { port: number }).port))
		})

		const harness = mockPi()
		agentColab(harness.pi as never, { registryDir: dir, replyTimeoutMs: 5000 })
		await harness.emit("session_start", { reason: "startup" }, baseCtx())
		const record = readRecord()
		registerPeer(dir, {
			...readRecord(),
			sessionId: "sender-2222-3333",
			name: "sender-two",
			token: "tok-sender",
			port: senderPort,
		})

		await sendMessage(record.port, "fyi", {
			token: record.token,
			fromName: "sender-two",
			fromSessionId: "sender-2222-3333",
			notifyWhenIdle: true,
			expectReply: false,
			timeoutMs: 5000,
		})
		await vi.waitFor(
			() => {
				expect(received.length).toBe(1)
			},
			{ timeout: 5000 },
		)
		const noticeText = (JSON.parse(received[0].body) as { params: { message: { parts: Array<{ text: string }> } } })
			.params.message.parts[0].text
		expect(noticeText).toContain("session is idle")
		// The injected message queued without triggering a turn.
		expect(harness.sent[0].opts).toMatchObject({ deliverAs: "nextTurn" })

		await new Promise<void>((resolve) => capture.close(() => resolve()))
	}, 20_000)

	it("/agent-name renames across registry, card, and restarts", async () => {
		const harness = mockPi()
		agentColab(harness.pi as never, { registryDir: dir, replyTimeoutMs: 5000 })
		const ctx = baseCtx()
		await harness.emit("session_start", { reason: "startup" }, ctx)

		const agentName = harness.commandHandlers.get("agent-name")
		expect(agentName).toBeDefined()
		await agentName?.("api-worker", ctx)

		const record = readRecord()
		expect(record.name).toBe("api-worker")
		// Card is served live under the new name.
		const cardRes = await fetch(`http://127.0.0.1:${record.port}/.well-known/agent-card.json`)
		expect(((await cardRes.json()) as { name: string }).name).toBe("api-worker")

		// A fresh extension instance (restart/resume) adopts the persisted name.
		const second = mockPi()
		agentColab(second.pi as never, { registryDir: dir, replyTimeoutMs: 5000 })
		await second.emit("session_start", { reason: "resume" }, ctx)
		expect(readRecord().name).toBe("api-worker")
	}, 15_000)

	it("linked workers survive peer restarts — refresh by id, name re-attach, dead dropped", async () => {
		const harness = mockPi()
		agentColab(harness.pi as never, { registryDir: dir, replyTimeoutMs: 5000 })
		const ctx = baseCtx()
		await harness.emit("session_start", { reason: "startup" }, ctx)

		registerPeer(dir, {
			sessionId: "old-12345678",
			pid: process.pid,
			port: 40001,
			token: "t1",
			name: "beta",
			cwd: "/tmp/beta",
			startedAt: new Date().toISOString(),
		})
		const linkPeer = harness.tools.find((t) => t.name === "link_peer")
		await linkPeer?.execute("c1", { peer: "beta" }, undefined, undefined, ctx)

		// Case 1: same id, new port/token (in-place reload) → snapshot refreshed, still linked.
		registerPeer(dir, {
			sessionId: "old-12345678",
			pid: process.pid,
			port: 40002,
			token: "t2",
			name: "beta",
			cwd: "/tmp/beta",
			startedAt: new Date().toISOString(),
		})
		const clause1 = (await harness.emit("before_agent_start", { systemPrompt: "BASE" }, ctx))[0] as {
			systemPrompt: string
		}
		expect(clause1.systemPrompt).toContain("beta (old-1234")

		// Case 2: peer restarts with a NEW id under the same persisted name → re-attached.
		removePeer(dir, "old-12345678")
		registerPeer(dir, {
			sessionId: "new-87654321",
			pid: process.pid,
			port: 40003,
			token: "t3",
			name: "beta",
			cwd: "/tmp/beta",
			startedAt: new Date().toISOString(),
		})
		const clause2 = (await harness.emit("before_agent_start", { systemPrompt: "BASE" }, ctx))[0] as {
			systemPrompt: string
		}
		expect(clause2.systemPrompt).toContain("beta (new-8765")
		const listPeers = harness.tools.find((t) => t.name === "list_peers")
		const listed = (await listPeers?.execute("c2", {}, undefined, undefined, ctx)) as {
			content: Array<{ text: string }>
		}
		expect(listed.content[0].text).toContain("[linked]")

		// Case 3: peer gone entirely → refresh empties the link set, clause dropped.
		removePeer(dir, "new-87654321")
		const results = await harness.emit("before_agent_start", { systemPrompt: "BASE" }, ctx)
		expect(results[0]).toBeUndefined()
	}, 15_000)

	it("session_shutdown stops the server and removes the registry record", async () => {
		const harness = mockPi()
		agentColab(harness.pi as never, { registryDir: dir, replyTimeoutMs: 5000 })
		await harness.emit("session_start", { reason: "startup" }, baseCtx())
		const record = readRecord()
		expect(existsSync(sessionFile)).toBe(true)

		await harness.emit("session_shutdown", {}, baseCtx())
		expect(listLivePeers(dir).find((e) => e.record.sessionId === sessionId)).toBeUndefined()
		await expect(sendMessage(record.port, "x", { token: record.token, timeoutMs: 2000 })).rejects.toThrow()
	}, 15_000)

	it("skips non-TUI modes entirely", async () => {
		const harness = mockPi()
		agentColab(harness.pi as never, { registryDir: dir })
		const ctx = { ...baseCtx(), mode: "rpc" }
		await harness.emit("session_start", { reason: "startup" }, ctx)
		expect(listLivePeers(dir)).toHaveLength(0)
		expect(harness.tools).toHaveLength(0)
	}, 15_000)
})

afterAll(() => {
	rmSync(dir, { recursive: true, force: true })
})
