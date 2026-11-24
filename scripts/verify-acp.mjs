#!/usr/bin/env node
// Scripted ACP client that drives kimchi --mode acp through handshake, newSession, prompt.
// Prints each notification received and final stop reason. Non-zero exit on failure.

import { spawn } from "node:child_process"
import { Readable, Writable } from "node:stream"
import { setTimeout as delay } from "node:timers/promises"
import * as acp from "@agentclientprotocol/sdk/unstable"

const binary = process.argv[2] ?? "./dist/bin/kimchi"

class Client {
	chunksBySession = new Map()
	toolCallsBySession = new Map()
	async sessionUpdate(params) {
		const u = params.update
		if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
			const prev = this.chunksBySession.get(params.sessionId) ?? ""
			this.chunksBySession.set(params.sessionId, prev + u.content.text)
			process.stderr.write(`[chunk ${params.sessionId.slice(0, 8)}] ${JSON.stringify(u.content.text)}\n`)
		} else if (u.sessionUpdate === "tool_call") {
			const arr = this.toolCallsBySession.get(params.sessionId) ?? []
			arr.push({ id: u.toolCallId, title: u.title, kind: u.kind, status: u.status })
			this.toolCallsBySession.set(params.sessionId, arr)
			process.stderr.write(`[tool_call ${params.sessionId.slice(0, 8)}] ${u.title} (${u.kind})\n`)
		} else if (u.sessionUpdate === "tool_call_update") {
			const arr = this.toolCallsBySession.get(params.sessionId) ?? []
			const tc = arr.find((t) => t.id === u.toolCallId)
			if (tc) tc.status = u.status ?? tc.status
			process.stderr.write(`[tool_call_update ${params.sessionId.slice(0, 8)}] ${u.toolCallId} -> ${u.status}\n`)
		} else {
			process.stderr.write(`[update ${params.sessionId.slice(0, 8)}] ${u.sessionUpdate}\n`)
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
}

async function main() {
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
	const app = acp
		.client()
		.onNotification(acp.methods.client.session.update, ({ params }) => client.sessionUpdate(params))
		.onRequest(acp.methods.client.session.requestPermission, ({ params }) => client.requestPermission(params))
		.onRequest(acp.methods.client.fs.writeTextFile, () => client.writeTextFile())
		.onRequest(acp.methods.client.fs.readTextFile, () => client.readTextFile())
	const conn = app.connect(stream).agent

	const timer = setTimeout(() => {
		process.stderr.write("TIMEOUT after 120s\n")
		proc.kill("SIGKILL")
		process.exit(2)
	}, 120_000)

	try {
		const init = await conn.request("initialize", {
			protocolVersion: acp.PROTOCOL_VERSION,
			clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
		})
		process.stderr.write(`[init] protocolVersion=${init.protocolVersion}\n`)
		if (init.protocolVersion !== acp.PROTOCOL_VERSION) throw new Error("protocol mismatch")

		const ns1 = await conn.request("session/new", { cwd: process.cwd(), mcpServers: [] })
		const ns2 = await conn.request("session/new", { cwd: process.cwd(), mcpServers: [] })
		process.stderr.write(`[newSession] a=${ns1.sessionId} b=${ns2.sessionId}\n`)
		if (!ns1.sessionId || !ns2.sessionId) throw new Error("missing sessionId")
		if (ns1.sessionId === ns2.sessionId) throw new Error("sessionIds must differ")

		const [res1, res2] = await Promise.all([
			conn.request("session/prompt", {
				sessionId: ns1.sessionId,
				prompt: [{ type: "text", text: "Reply with exactly: alpha" }],
			}),
			conn.request("session/prompt", {
				sessionId: ns2.sessionId,
				prompt: [{ type: "text", text: "Reply with exactly: beta" }],
			}),
		])
		process.stderr.write(
			`[prompt a] stopReason=${res1.stopReason} text=${JSON.stringify(client.chunks(ns1.sessionId))}\n`,
		)
		process.stderr.write(
			`[prompt b] stopReason=${res2.stopReason} text=${JSON.stringify(client.chunks(ns2.sessionId))}\n`,
		)

		if (res1.stopReason !== "end_turn" || res2.stopReason !== "end_turn") {
			throw new Error(`unexpected stopReason: ${res1.stopReason}/${res2.stopReason}`)
		}
		const t1 = client.chunks(ns1.sessionId).toLowerCase()
		const t2 = client.chunks(ns2.sessionId).toLowerCase()
		if (!t1.includes("alpha")) throw new Error(`session a missing alpha: ${t1}`)
		if (!t2.includes("beta")) throw new Error(`session b missing beta: ${t2}`)

		// Tool-call test: prompt kimchi to invoke a tool and verify tool_call + tool_call_update flowed through.
		const ns3 = await conn.request("session/new", { cwd: process.cwd(), mcpServers: [] })
		process.stderr.write(`[newSession] c=${ns3.sessionId}\n`)
		const res3 = await conn.request("session/prompt", {
			sessionId: ns3.sessionId,
			prompt: [
				{
					type: "text",
					text: "Use the bash tool to run exactly `echo acp-tool-ok` and then reply with the command's output.",
				},
			],
		})
		process.stderr.write(
			`[prompt c] stopReason=${res3.stopReason} text=${JSON.stringify(client.chunks(ns3.sessionId))}\n`,
		)
		if (res3.stopReason !== "end_turn") {
			throw new Error(`tool-call session unexpected stopReason: ${res3.stopReason}`)
		}
		const toolCalls = client.toolCalls(ns3.sessionId)
		process.stderr.write(`[tool-calls c] ${JSON.stringify(toolCalls)}\n`)
		if (toolCalls.length === 0) throw new Error("expected at least one tool_call notification in session c")
		const completed = toolCalls.filter((t) => t.status === "completed")
		if (completed.length === 0) {
			throw new Error(`no completed tool_call_update; saw: ${JSON.stringify(toolCalls.map((t) => t.status))}`)
		}
		const t3 = client.chunks(ns3.sessionId).toLowerCase()
		if (!t3.includes("acp-tool-ok")) throw new Error(`session c missing tool output: ${t3}`)

		// Cancel path: start a long-running prompt, cancel mid-flight, expect stopReason=cancelled.
		const ns4 = await conn.request("session/new", { cwd: process.cwd(), mcpServers: [] })
		process.stderr.write(`[newSession] d=${ns4.sessionId}\n`)
		const cancelPromise = conn.request("session/prompt", {
			sessionId: ns4.sessionId,
			prompt: [
				{
					type: "text",
					text: "Use the bash tool to run exactly `sleep 20` and then reply done.",
				},
			],
		})
		await delay(3000)
		await conn.notify("session/cancel", { sessionId: ns4.sessionId })
		const res4 = await cancelPromise
		process.stderr.write(`[prompt d] stopReason=${res4.stopReason}\n`)
		if (res4.stopReason !== "cancelled") {
			throw new Error(`expected stopReason=cancelled, got ${res4.stopReason}`)
		}

		// Slash-command short-circuit: extension commands handled by pi.registerCommand return
		// from session.prompt() without ever firing agent_start / agent_end. The ACP server must
		// synthesize stopReason="end_turn" itself; otherwise the prompt hangs until the 120s
		// global timeout. /tags is a kimchi extension command (src/extensions/tags.ts) so it
		// routes through _tryExecuteExtensionCommand and exercises that exact path.
		const ns5 = await conn.request("session/new", { cwd: process.cwd(), mcpServers: [] })
		process.stderr.write(`[newSession] e=${ns5.sessionId}\n`)
		const slashStart = Date.now()
		const res5 = await Promise.race([
			conn.request("session/prompt", {
				sessionId: ns5.sessionId,
				prompt: [{ type: "text", text: "/tags list" }],
			}),
			delay(10_000).then(() => {
				throw new Error("slash-command prompt did not resolve within 10s — short-circuit regression?")
			}),
		])
		process.stderr.write(`[prompt e] stopReason=${res5.stopReason} elapsedMs=${Date.now() - slashStart}\n`)
		if (res5.stopReason !== "end_turn") {
			throw new Error(`slash-command unexpected stopReason: ${res5.stopReason}`)
		}

		// Error path: prompt with bogus sessionId must return JSON-RPC error, not hang.
		let errorCaught = null
		try {
			await conn.request("session/prompt", {
				sessionId: "00000000-0000-0000-0000-000000000000",
				prompt: [{ type: "text", text: "should fail" }],
			})
		} catch (err) {
			errorCaught = err
		}
		if (!errorCaught) throw new Error("expected error for unknown sessionId, got success")
		const code = errorCaught?.code
		process.stderr.write(`[err unknown-session] code=${code} msg=${errorCaught?.message}\n`)
		if (code !== -32602) throw new Error(`expected invalidParams (-32602), got code=${code}`)

		clearTimeout(timer)
		proc.kill("SIGTERM")
		await delay(200)
		proc.kill("SIGKILL")
		process.stderr.write("OK\n")
		process.exit(0)
	} catch (err) {
		clearTimeout(timer)
		process.stderr.write(`FAIL: ${err}\n`)
		proc.kill("SIGKILL")
		process.exit(1)
	}
}

main().catch((e) => {
	process.stderr.write(`fatal: ${e}\n`)
	process.exit(1)
})
