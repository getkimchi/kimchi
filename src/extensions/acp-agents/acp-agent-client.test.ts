import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { AcpSessionCallbacks } from "../../sandbox/worker/acp-client.js"
import { type AcpMcpServer, StdioAcpClient, type StdioAcpClientOptions } from "./acp-agent-client.js"

const fixturePath = new URL("./test-fixtures/fake-acp-agent.mjs", import.meta.url).pathname

type LogEntry = Record<string, unknown> & { type: string }

function readLog(path: string): LogEntry[] {
	if (!existsSync(path)) return []
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as LogEntry)
}

async function waitFor(predicate: () => boolean, ms = 3000): Promise<void> {
	const deadline = Date.now() + ms
	while (Date.now() < deadline) {
		if (predicate()) return
		await new Promise((r) => setTimeout(r, 50))
	}
}

describe("StdioAcpClient", () => {
	let logDir: string
	let logPath: string

	beforeEach(() => {
		logDir = mkdtempSync(join(tmpdir(), "acp-client-test-"))
		logPath = join(logDir, "log.jsonl")
	})

	afterEach(() => {
		rmSync(logDir, { recursive: true, force: true })
	})

	function makeClient(callbacks: AcpSessionCallbacks = {}, extra: Partial<StdioAcpClientOptions> = {}): StdioAcpClient {
		return new StdioAcpClient({
			command: process.execPath,
			args: [fixturePath],
			env: { FAKE_ACP_LOG: logPath },
			cwd: logDir,
			callbacks,
			...extra,
		})
	}

	it("initializes and passes cwd and mcpServers to newSession", async () => {
		const mcpServers: AcpMcpServer[] = [
			{ name: "kimchi-agent-comms", command: "shim-bin", args: ["--agent-comms-mcp", "/sock", "tok"] },
		]
		const client = makeClient({}, { mcpServers })
		await client.initialize()

		expect(client.sessionId).toBe("fake-session-1")
		await waitFor(() => readLog(logPath).some((e) => e.type === "newSession"))
		const newSession = readLog(logPath).find((e) => e.type === "newSession")
		expect(newSession).toBeDefined()
		const params = newSession?.params as { cwd?: string; mcpServers?: unknown[] }
		expect(params.cwd).toBe(logDir)
		// env is defaulted to [] on the wire (the ACP stdio McpServer requires it)
		expect(params.mcpServers).toEqual([{ ...mcpServers[0], env: [] }])
		client.close()
	})

	it("streams a prompt with text, usage, and turn events", async () => {
		const events: string[] = []
		let usage: unknown
		const client = makeClient({
			onTextDelta: (delta, fullText) => events.push(`delta:${delta}`, `full:${fullText}`),
			onTurnEnd: (turnCount) => events.push(`turn:${turnCount}`),
			onAssistantUsage: (u) => {
				usage = u
			},
		})
		await client.initialize()

		const result = await client.prompt("hello")

		expect(result.stopReason).toBe("end_turn")
		expect(result.usage).toEqual({ input: 11, output: 7, cacheRead: 0, cacheWrite: 0 })
		expect(events).toContain("delta:echo:hello")
		expect(events).toContain("full:echo:hello")
		expect(events).toContain("turn:1")
		expect(usage).toEqual({ input: 11, output: 7, cacheRead: 0, cacheWrite: 0 })
		client.close()
	})

	it("surfaces tool_call notifications as tool activity", async () => {
		const acts: Array<{ status: string; toolName: string }> = []
		const client = makeClient({
			onToolActivity: (a) => {
				acts.push({ status: a.status, toolName: a.toolName })
			},
		})
		await client.initialize()

		await client.prompt("USE_TOOLS now")

		expect(acts).toEqual([
			{ status: "in_progress", toolName: "fake tool" },
			{ status: "completed", toolName: "fake tool" },
		])
		client.close()
	})

	it("resolves a blocked prompt as cancelled after cancel()", async () => {
		const client = makeClient()
		await client.initialize()

		const promptPromise = client.prompt("BLOCK forever")
		await waitFor(() => true, 200)
		await client.cancel()
		const result = await promptPromise

		expect(result.stopReason).toBe("cancelled")
		client.close()
	})

	it("denies permission requests by default", async () => {
		const client = makeClient()
		await client.initialize()

		await client.prompt("PERM please")

		await waitFor(() => readLog(logPath).some((e) => e.type === "permissionOutcome"))
		const outcome = readLog(logPath).find((e) => e.type === "permissionOutcome")
		expect(outcome?.result).toEqual({ outcome: { outcome: "cancelled" } })
		client.close()
	})

	it("allows permission requests when permissions: allow", async () => {
		const client = makeClient({}, { permissions: "allow" })
		await client.initialize()

		await client.prompt("PERM please")

		await waitFor(() => readLog(logPath).some((e) => e.type === "permissionOutcome"))
		const outcome = readLog(logPath).find((e) => e.type === "permissionOutcome")
		expect(outcome?.result).toEqual({ outcome: { outcome: "selected", optionId: "allow" } })
		client.close()
	})

	it("rejects initialize when the agent never responds (timeout)", async () => {
		const client = makeClient({}, { initializeTimeoutMs: 400, env: { FAKE_ACP_LOG: logPath, FAKE_ACP_MODE: "hang" } })

		await expect(client.initialize()).rejects.toThrow(/initialize timed out/)
		client.close()
	})

	it("aborts a pending prompt when the signal fires", async () => {
		const controller = new AbortController()
		const client = makeClient({}, { signal: controller.signal })
		await client.initialize()

		const promptPromise = client.prompt("BLOCK forever")
		await waitFor(() => true, 200)
		controller.abort()

		await expect(promptPromise).rejects.toThrow(/Aborted/)
		client.close()
	})

	it("rejects a pending prompt when the agent process dies mid-turn", async () => {
		const client = makeClient()
		await client.initialize()

		// Either rejection is valid: the SDK's stream-close handler fires on
		// stdout EOF ("ACP connection closed") and races ahead of our exit
		// handler ("process exited (code=3)" with the stderr tail). The test
		// proves the prompt rejects — it must not hang when the child dies.
		await expect(client.prompt("EXIT_DURING now")).rejects.toThrow(
			/ACP agent process exited \(code=3|ACP connection closed/,
		)

		client.close()
	})

	it("kills the child process on close()", async () => {
		const client = makeClient()
		await client.initialize()

		client.close()

		await waitFor(() => readLog(logPath).some((e) => e.type === "started"))
		const started = readLog(logPath).find((e) => e.type === "started")
		const pid = started?.pid as number
		await waitFor(() => {
			try {
				process.kill(pid, 0)
				return false
			} catch {
				return true
			}
		})
	}, 10_000)
})
