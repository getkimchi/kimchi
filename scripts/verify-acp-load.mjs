#!/usr/bin/env node
// E2E verification script for session/load functionality.
// Companion to verify-acp.mjs - tests loading a persisted session and resuming conversation.

import { spawn } from "node:child_process"
import { Readable, Writable } from "node:stream"
import { setTimeout as delay } from "node:timers/promises"
import * as acp from "@agentclientprotocol/sdk"

const binary = process.argv[2] ?? "./dist/bin/kimchi"

class Client {
	chunksBySession = new Map()
	toolCallsBySession = new Map()
	updatesBySession = new Map()

	async sessionUpdate(params) {
		const u = params.update
		const sessionId = params.sessionId

		// Track all updates for debugging
		const updates = this.updatesBySession.get(sessionId) ?? []
		updates.push(u.sessionUpdate)
		this.updatesBySession.set(sessionId, updates)

		if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
			const prev = this.chunksBySession.get(sessionId) ?? ""
			this.chunksBySession.set(sessionId, prev + u.content.text)
			process.stderr.write(`[chunk ${sessionId.slice(0, 8)}] ${JSON.stringify(u.content.text)}\n`)
		} else if (u.sessionUpdate === "tool_call") {
			const arr = this.toolCallsBySession.get(sessionId) ?? []
			arr.push({ id: u.toolCallId, title: u.title, kind: u.kind, status: u.status })
			this.toolCallsBySession.set(sessionId, arr)
			process.stderr.write(`[tool_call ${sessionId.slice(0, 8)}] ${u.title} (${u.kind})\n`)
		} else if (u.sessionUpdate === "tool_call_update") {
			const arr = this.toolCallsBySession.get(sessionId) ?? []
			const tc = arr.find((t) => t.id === u.toolCallId)
			if (tc) tc.status = u.status ?? tc.status
			process.stderr.write(`[tool_call_update ${sessionId.slice(0, 8)}] ${u.toolCallId} -> ${u.status}\n`)
		} else if (u.sessionUpdate === "session_start") {
			process.stderr.write(`[session_start ${sessionId.slice(0, 8)}]\n`)
		} else {
			process.stderr.write(`[update ${sessionId.slice(0, 8)}] ${u.sessionUpdate}\n`)
		}
	}

	chunks(sessionId) {
		return this.chunksBySession.get(sessionId) ?? ""
	}

	toolCalls(sessionId) {
		return this.toolCallsBySession.get(sessionId) ?? []
	}

	async requestPermission(params) {
		process.stderr.write(`[perm] ${params.toolCall.title} -> auto-reject\n`)
		const reject = params.options.find((o) => o.kind === "reject_once") ?? params.options[0]
		return { outcome: { outcome: "selected", optionId: reject.optionId } }
	}

	async writeTextFile() {
		return {}
	}

	async readTextFile() {
		return { content: "" }
	}

	resetSession(sessionId) {
		this.chunksBySession.delete(sessionId)
		this.toolCallsBySession.delete(sessionId)
		this.updatesBySession.delete(sessionId)
	}
}

/**
 * Create a connected ACP client and kimchi process.
 */
function createConnection() {
	const proc = spawn(binary, ["--mode", "acp"], {
		stdio: ["pipe", "pipe", "inherit"],
		env: process.env,
	})
	proc.on("error", (e) => {
		process.stderr.write(`spawn error: ${e}\n`)
		process.exit(1)
	})

	const writable = Writable.toWeb(proc.stdin)
	const readable = Readable.toWeb(proc.stdout)
	const client = new Client()
	const stream = acp.ndJsonStream(writable, readable)
	const conn = new acp.ClientSideConnection(() => client, stream)

	return { proc, conn, client }
}

async function main() {
	process.stderr.write("[verify-acp-load] Starting session/load verification\n")

	// Step 1: Create a session and populate it with a prompt
	process.stderr.write("\n=== Step 1: Create session with initial prompt ===\n")
	const { proc: proc1, conn: conn1, client: client1 } = createConnection()

	const timer = setTimeout(() => {
		process.stderr.write("TIMEOUT after 120s\n")
		proc1.kill("SIGKILL")
		process.exit(2)
	}, 120_000)

	const init = await conn1.initialize({
		protocolVersion: acp.PROTOCOL_VERSION,
		clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
	})
	process.stderr.write(`[init] protocolVersion=${init.protocolVersion}\n`)

	// Verify loadSession capability is advertised
	if (!init.agentCapabilities.loadSession) {
		throw new Error("Expected loadSession capability to be true")
	}
	if (!init.agentCapabilities.sessionCapabilities?.list) {
		throw new Error("Expected sessionCapabilities.list to be defined")
	}
	process.stderr.write("[capabilities] loadSession: true, sessionCapabilities.list: {}\n")

	// Create a session with a simple prompt
	const ns1 = await conn1.newSession({ cwd: process.cwd(), mcpServers: [] })
	process.stderr.write(`[newSession] sessionId=${ns1.sessionId}\n`)

	const res1 = await conn1.prompt({
		sessionId: ns1.sessionId,
		prompt: [{ type: "text", text: "Reply with exactly: session-one" }],
	})
	process.stderr.write(
		`[prompt 1] stopReason=${res1.stopReason} text=${JSON.stringify(client1.chunks(ns1.sessionId))}\n`,
	)

	if (res1.stopReason !== "end_turn") {
		throw new Error(`unexpected stopReason: ${res1.stopReason}`)
	}
	const text1 = client1.chunks(ns1.sessionId).toLowerCase()
	if (!text1.includes("session-one")) {
		throw new Error(`session missing 'session-one': ${text1}`)
	}

	// Step 2: Disconnect from the first process
	process.stderr.write("\n=== Step 2: Disconnecting first session ===\n")
	conn1.close()
	await delay(500)
	proc1.kill("SIGTERM")
	await delay(200)

	// Step 3: Reconnect and load the same session
	process.stderr.write("\n=== Step 3: Reconnect and load session ===\n")
	const { proc: proc2, conn: conn2, client: client2 } = createConnection()

	const init2 = await conn2.initialize({
		protocolVersion: acp.PROTOCOL_VERSION,
		clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
	})
	process.stderr.write(`[init 2] protocolVersion=${init2.protocolVersion}\n`)

	// Load the existing session
	const loadResult = await conn2.loadSession({
		sessionId: ns1.sessionId,
		cwd: process.cwd(),
		mcpServers: [],
	})
	process.stderr.write(`[loadSession] sessionId=${loadResult.sessionId} models=${JSON.stringify(loadResult.models)}\n`)

	if (!loadResult.models) {
		throw new Error("Expected models to be populated after loadSession")
	}

	// Verify replay notifications were emitted (session_start + historical entries)
	const updates = client2.updatesBySession.get(ns1.sessionId) ?? []
	process.stderr.write(`[loadSession updates] ${JSON.stringify(updates)}\n`)

	if (!updates.includes("session_start")) {
		throw new Error("Expected session_start notification during replay")
	}

	// Step 4: Send a follow-up prompt to verify context continuity
	process.stderr.write("\n=== Step 4: Send follow-up prompt ===\n")
	const res2 = await conn2.prompt({
		sessionId: ns1.sessionId,
		prompt: [{ type: "text", text: "Reply with exactly: session-two" }],
	})
	process.stderr.write(
		`[prompt 2] stopReason=${res2.stopReason} text=${JSON.stringify(client2.chunks(ns1.sessionId))}\n`,
	)

	if (res2.stopReason !== "end_turn") {
		throw new Error(`unexpected stopReason after load: ${res2.stopReason}`)
	}
	const text2 = client2.chunks(ns1.sessionId).toLowerCase()
	if (!text2.includes("session-two")) {
		throw new Error(`session missing 'session-two' after load: ${text2}`)
	}

	// Step 5: Test session/list
	process.stderr.write("\n=== Step 5: Test session/list ===\n")
	const listResult = await conn2.listSessions({ cwd: process.cwd() })
	process.stderr.write(`[listSessions] found ${listResult.sessions.length} sessions\n`)

	const ourSession = listResult.sessions.find((s) => s.sessionId === ns1.sessionId)
	if (!ourSession) {
		throw new Error(`Expected to find our session ${ns1.sessionId} in listSessions result`)
	}
	process.stderr.write(`[listSessions] session: ${JSON.stringify(ourSession)}\n`)

	if (listResult.nextCursor !== null) {
		throw new Error("Expected nextCursor to be null in v1")
	}

	// Cleanup
	clearTimeout(timer)
	proc2.kill("SIGTERM")
	await delay(200)
	proc2.kill("SIGKILL")

	process.stderr.write("\n=== ALL TESTS PASSED ===\n")
	process.exit(0)
}

main().catch((e) => {
	process.stderr.write(`FAIL: ${e}\n`)
	process.exit(1)
})
