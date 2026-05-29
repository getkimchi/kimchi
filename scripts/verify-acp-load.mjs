#!/usr/bin/env node
// Verifies ACP session/load: reconnect-and-resume + ACP↔CLI round-trip.
//
// Two scenarios:
//   A) Reconnect-and-resume — ACP creates session, disconnect, reconnect,
//      session/load same id, follow-up prompt sees prior context.
//   B) ACP↔CLI round-trip — ACP creates session + 1 turn, CLI resumes via
//      `--session <id>` adding turn 2, ACP reconnects + session/load shows
//      replay of both prior turns, follow-up prompt (turn 3) sees full
//      context. After this, the on-disk session contains all three turns.
//
// Both scenarios drive a real LLM via stdio JSON-RPC; KIMCHI_API_KEY must be
// in env. Companion to verify-acp.mjs / verify-acp-stop.mjs.
//
// Usage: node scripts/verify-acp-load.mjs [path-to-kimchi-binary]

import { spawn } from "node:child_process"
import { Readable, Writable } from "node:stream"
import { setTimeout as delay } from "node:timers/promises"
import * as acp from "@agentclientprotocol/sdk"

const binary = process.argv[2] ?? "./dist/bin/kimchi"
const CWD = process.cwd()
const PROMPT_TIMEOUT_MS = 90_000
// Sized off PROMPT_TIMEOUT_MS so a worst-case run (5 LLM-touching prompts at
// ≈90s + load/spawn overhead) doesn't trip the watchdog before the per-prompt
// timeouts can flag the slow call individually. Hardcoding 5min was too tight.
const WATCHDOG_MS = PROMPT_TIMEOUT_MS * 8

const liveProcs = new Set()

class Client {
	userChunks = []
	agentChunks = []

	reset() {
		this.userChunks = []
		this.agentChunks = []
	}

	async sessionUpdate(params) {
		const u = params.update
		if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
			this.agentChunks.push(u.content.text)
		} else if (u.sessionUpdate === "user_message_chunk" && u.content?.type === "text") {
			this.userChunks.push(u.content.text)
		}
		process.stderr.write(`[update] ${u.sessionUpdate}\n`)
	}

	async requestPermission(params) {
		// Reject — text-only prompts shouldn't trigger tools; deny if they do
		// so the test fails loudly instead of hanging on an interactive prompt.
		const reject = params.options.find((o) => o.kind === "reject_once") ?? params.options[0]
		process.stderr.write(`[perm] ${params.toolCall.title} -> reject\n`)
		return { outcome: { outcome: "selected", optionId: reject.optionId } }
	}
	async writeTextFile() {
		return {}
	}
	async readTextFile() {
		return { content: "" }
	}
}

function spawnAcp() {
	const proc = spawn(binary, ["--mode", "acp"], {
		stdio: ["pipe", "pipe", "inherit"],
		env: process.env,
		cwd: CWD,
	})
	liveProcs.add(proc)
	proc.once("exit", () => liveProcs.delete(proc))
	proc.on("error", (e) => {
		process.stderr.write(`acp spawn error: ${e}\n`)
		process.exit(1)
	})
	const writable = Writable.toWeb(proc.stdin)
	const readable = Readable.toWeb(proc.stdout)
	const client = new Client()
	const stream = acp.ndJsonStream(writable, readable)
	const conn = new acp.ClientSideConnection(() => client, stream)
	return { proc, client, conn }
}

async function killProcess(proc) {
	if (proc.exitCode !== null || proc.signalCode !== null) return
	proc.kill("SIGTERM")
	await Promise.race([new Promise((r) => proc.once("exit", r)), delay(3000)])
	if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL")
}

async function initConn(conn) {
	return await conn.initialize({
		protocolVersion: acp.PROTOCOL_VERSION,
		clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
	})
}

async function promptWithTimeout(conn, sessionId, text) {
	// Attach a no-op catch BEFORE racing: if the timeout wins and conn.prompt
	// rejects later, an unhandled rejection would crash the runner under
	// stricter Node defaults.
	const promptPromise = conn.prompt({ sessionId, prompt: [{ type: "text", text }] }).catch((err) => ({
		stopReason: "ERROR",
		error: err instanceof Error ? err.message : String(err),
	}))
	const result = await Promise.race([promptPromise, delay(PROMPT_TIMEOUT_MS).then(() => ({ stopReason: "TIMEOUT" }))])
	return result
}

async function scenarioReconnectResume() {
	process.stderr.write("\n=== scenario A: reconnect-and-resume ===\n")
	const failures = []
	const TOKEN = "ALPHA-7K9"

	const a = spawnAcp()
	let sessionId
	try {
		const init = await initConn(a.conn)
		if (!init.agentCapabilities?.loadSession) {
			failures.push("A1 initialize: loadSession capability not advertised")
		}

		const ns = await a.conn.newSession({ cwd: CWD, mcpServers: [] })
		sessionId = ns.sessionId
		process.stderr.write(`[A1] sessionId=${sessionId}\n`)

		const r1 = await promptWithTimeout(
			a.conn,
			sessionId,
			`Remember this token exactly: ${TOKEN}. Reply with the single word ok.`,
		)
		if (r1.stopReason !== "end_turn") failures.push(`A1 prompt stopReason="${r1.stopReason}"`)
		// Small drain so the session JSONL append for the assistant turn lands
		// before SIGTERM. session.prompt resolved means agent_end fired, but the
		// shutdownMarker / extension teardown still runs in the SIGTERM handler.
		await delay(200)
	} finally {
		await killProcess(a.proc)
	}
	if (!sessionId) {
		failures.push("A1: failed to create session")
		return failures
	}

	const b = spawnAcp()
	try {
		const init = await initConn(b.conn)
		if (!init.agentCapabilities?.loadSession) {
			failures.push("A2 initialize: loadSession capability missing")
		}

		b.client.reset()
		const load = await b.conn.loadSession({ sessionId, cwd: CWD, mcpServers: [] })
		process.stderr.write(
			`[A2] load models=${JSON.stringify(load.models)} userChunks=${b.client.userChunks.length} agentChunks=${b.client.agentChunks.length}\n`,
		)
		if (!load.models?.currentModelId) failures.push("A2 load: response.models.currentModelId missing")
		if (b.client.userChunks.length === 0) failures.push("A2 load: replay emitted no user_message_chunk")
		if (b.client.agentChunks.length === 0) failures.push("A2 load: replay emitted no agent_message_chunk")
		const replayUser = b.client.userChunks.join("")
		if (!replayUser.includes(TOKEN)) {
			failures.push(`A2 load: replay user content missing token "${TOKEN}" (got: ${JSON.stringify(replayUser)})`)
		}

		b.client.reset()
		const r2 = await promptWithTimeout(
			b.conn,
			sessionId,
			"What token did I ask you to remember? Reply with the exact token only, nothing else.",
		)
		if (r2.stopReason !== "end_turn") failures.push(`A2 followup stopReason="${r2.stopReason}"`)
		const reply = b.client.agentChunks.join("")
		process.stderr.write(`[A2] followup reply=${JSON.stringify(reply)}\n`)
		if (!reply.toUpperCase().includes(TOKEN)) {
			failures.push(`A2 followup: model did not recall token (reply=${JSON.stringify(reply)})`)
		}
	} finally {
		await killProcess(b.proc)
	}
	return failures
}

async function scenarioCrossToolRoundTrip() {
	process.stderr.write("\n=== scenario B: ACP↔CLI round-trip ===\n")
	const failures = []
	const TOK_A = "BETA-3F2"
	const TOK_B = "GAMMA-9X8"

	const a = spawnAcp()
	let sessionId
	try {
		const init = await initConn(a.conn)
		// Mirror scenario A's capability check on this connection too — a
		// regression that drops the flag would otherwise only fail in A.
		if (!init.agentCapabilities?.loadSession) {
			failures.push("B1 initialize: loadSession capability not advertised")
		}
		if (!init.agentCapabilities?.sessionCapabilities?.list) {
			failures.push("B1 initialize: sessionCapabilities.list not advertised")
		}
		const ns = await a.conn.newSession({ cwd: CWD, mcpServers: [] })
		sessionId = ns.sessionId
		process.stderr.write(`[B1] sessionId=${sessionId}\n`)

		const r1 = await promptWithTimeout(
			a.conn,
			sessionId,
			`Remember token A exactly: ${TOK_A}. Reply with the single word ok.`,
		)
		if (r1.stopReason !== "end_turn") failures.push(`B1 prompt stopReason="${r1.stopReason}"`)
		await delay(200)
	} finally {
		await killProcess(a.proc)
	}
	if (!sessionId) {
		failures.push("B1: failed to create session")
		return failures
	}

	// CLI leg: kimchi reopens the same session via --session <id> and adds turn 2.
	// Pipe the prompt over stdin; pi enters print mode automatically when stdin
	// is not a TTY (main.js: `parsed.print || !stdinIsTTY` -> print). Inheriting
	// stderr lets pi's progress noise land in the test log; stdout is muted so
	// the TUI render doesn't spam this script's output.
	process.stderr.write(`[B2] launching kimchi --session ${sessionId}\n`)
	const cliPrompt = `Remember token B exactly: ${TOK_B}. Reply with the single word ok.`
	const cli = spawn(binary, ["--session", sessionId, "-p"], {
		stdio: ["pipe", "ignore", "inherit"],
		env: process.env,
		cwd: CWD,
	})
	liveProcs.add(cli)
	cli.once("exit", () => liveProcs.delete(cli))
	// If the child exits before reading stdin, `end(cliPrompt)` emits EPIPE
	// as an uncaught exception and aborts the test runner. Swallow both
	// streams' errors — the exit-code check below is the source of truth.
	cli.on("error", (e) => process.stderr.write(`[B2] cli error: ${e}\n`))
	cli.stdin.on("error", () => {})
	cli.stdin.end(cliPrompt)
	const cliExit = await Promise.race([
		new Promise((r) => cli.once("exit", (code, sig) => r({ code, sig }))),
		delay(PROMPT_TIMEOUT_MS).then(() => ({ code: "TIMEOUT", sig: null })),
	])
	process.stderr.write(`[B2] CLI exit code=${cliExit.code} signal=${cliExit.sig}\n`)
	if (cliExit.code !== 0) {
		failures.push(`B2 CLI exited with code=${cliExit.code} signal=${cliExit.sig}`)
		await killProcess(cli)
		return failures
	}

	const b = spawnAcp()
	try {
		await initConn(b.conn)
		b.client.reset()
		const load = await b.conn.loadSession({ sessionId, cwd: CWD, mcpServers: [] })
		process.stderr.write(
			`[B3] load userChunks=${b.client.userChunks.length} agentChunks=${b.client.agentChunks.length}\n`,
		)
		if (b.client.userChunks.length < 2) {
			failures.push(`B3 load: expected >=2 user_message_chunk during replay, got ${b.client.userChunks.length}`)
		}
		if (b.client.agentChunks.length < 2) {
			failures.push(`B3 load: expected >=2 agent_message_chunk during replay, got ${b.client.agentChunks.length}`)
		}
		const replayUser = b.client.userChunks.join("")
		if (!replayUser.includes(TOK_A)) failures.push(`B3 load: replay missing token A "${TOK_A}"`)
		if (!replayUser.includes(TOK_B)) failures.push(`B3 load: replay missing token B "${TOK_B}"`)
		if (load.models && !load.models.currentModelId) failures.push("B3 load: models present but currentModelId missing")

		// Turn 3 over ACP: model must surface BOTH tokens, proving that the
		// CLI-written turn 2 is in the conversation context (not just on disk).
		b.client.reset()
		const r3 = await promptWithTimeout(
			b.conn,
			sessionId,
			"List the two tokens I asked you to remember, separated by a comma. Reply with only the two tokens.",
		)
		if (r3.stopReason !== "end_turn") failures.push(`B3 followup stopReason="${r3.stopReason}"`)
		const reply = b.client.agentChunks.join("")
		process.stderr.write(`[B3] followup reply=${JSON.stringify(reply)}\n`)
		const upper = reply.toUpperCase()
		if (!upper.includes(TOK_A))
			failures.push(`B3 followup: model did not recall token A (reply=${JSON.stringify(reply)})`)
		if (!upper.includes(TOK_B))
			failures.push(`B3 followup: model did not recall token B (reply=${JSON.stringify(reply)})`)
		// Three turns now persisted: ACP-1 (TOK_A), CLI-2 (TOK_B), ACP-3 (above).
		// Drain so the ACP-3 turn flushes to JSONL before SIGTERM (mirrors A1/B1).
		await delay(200)
	} finally {
		await killProcess(b.proc)
	}

	// Step 4: prove turn 3 actually persisted by reloading from a fresh ACP
	// process and counting replayed user prompts — verify all three turns
	// are visible. Without this step we'd only have shown that turns 1+2 are
	// in context after the round trip; the third turn could silently be lost
	// on disk and the assertions above would still pass.
	const c = spawnAcp()
	try {
		await initConn(c.conn)
		c.client.reset()
		await c.conn.loadSession({ sessionId, cwd: CWD, mcpServers: [] })
		process.stderr.write(
			`[B4] reload userChunks=${c.client.userChunks.length} agentChunks=${c.client.agentChunks.length}\n`,
		)
		if (c.client.userChunks.length < 3) {
			failures.push(`B4 reload: expected >=3 user_message_chunk after round-trip, got ${c.client.userChunks.length}`)
		}
		if (c.client.agentChunks.length < 3) {
			failures.push(`B4 reload: expected >=3 agent_message_chunk after round-trip, got ${c.client.agentChunks.length}`)
		}
	} finally {
		await killProcess(c.proc)
	}
	return failures
}

async function main() {
	const watchdog = setTimeout(() => {
		process.stderr.write(`WATCHDOG TIMEOUT after ${WATCHDOG_MS}ms\n`)
		for (const p of liveProcs) p.kill("SIGKILL")
		process.exit(2)
	}, WATCHDOG_MS)

	let failures = []
	try {
		failures = failures.concat(await scenarioReconnectResume())
		failures = failures.concat(await scenarioCrossToolRoundTrip())
	} catch (err) {
		failures.push(`unexpected error: ${err?.stack ?? err}`)
	} finally {
		clearTimeout(watchdog)
		for (const p of liveProcs) {
			try {
				p.kill("SIGKILL")
			} catch {}
		}
	}

	if (failures.length === 0) {
		process.stderr.write("\nOK — session/load verified\n")
		process.exit(0)
	}
	for (const f of failures) process.stderr.write(`FAIL: ${f}\n`)
	process.exit(1)
}

main().catch((e) => {
	process.stderr.write(`fatal: ${e}\n`)
	for (const p of liveProcs) {
		try {
			p.kill("SIGKILL")
		} catch {}
	}
	process.exit(1)
})
