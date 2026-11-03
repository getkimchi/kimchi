// RPC-mode destination coverage: `export_html` resolves output paths against
// the SESSION cwd, never the long-lived server process's cwd. RPC mode is
// the surface where process cwd ≠ session cwd is the norm (an orchestrating
// client may host the process anywhere), so this e2e pins the resolution rule
// end-to-end: a session whose header records cwd = dir B, served by a binary
// process running in dir A, exports into dir B.
//
// Uses only supported protocol commands: `new_session`, `switch_session`
// (adopts the session header's recorded cwd), and `export_html` (calls the
// patched AgentSession.exportToHtml → runSecureExport). A zero-entry session
// suffices — the destination and permissions are the behavior under test.

import { type ChildProcess, spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	DEFAULT_MODEL,
	type FakeOpenAiServer,
	type FakeResponseScript,
	startFakeOpenAiServer,
} from "../tui/support/fake-openai-server.js"

const REPO_ROOT = process.env.KIMCHI_REPO_ROOT
	? resolve(process.env.KIMCHI_REPO_ROOT)
	: fileURLToPath(new URL("../../../", import.meta.url))
const BINARY_PATH = resolve(REPO_ROOT, "dist/bin/kimchi")
const PACKAGE_DIR = resolve(REPO_ROOT, "dist/share/kimchi")

/** Hard cap so a regression cannot hang CI. */
const RESPONSE_TIMEOUT_MS = 60_000

type RpcResponse = Record<string, unknown>

/** Minimal RPC client: line-delimited JSON requests with id correlation. */
class RpcClient {
	private buffer = ""
	private nextId = 0
	private readonly pending = new Map<
		number,
		{ resolve: (data: RpcResponse) => void; reject: (err: Error) => void; command: string }
	>()
	private stderrChunks: Buffer[] = []
	/** Rolling log of the last stdout lines — diagnostics for command timeouts. */
	private stdoutLines: string[] = []

	constructor(private readonly proc: ChildProcess) {
		this.proc.stdout?.setEncoding("utf-8")
		this.proc.stdout?.on("data", (chunk: string) => this.consume(chunk))
		this.proc.stderr?.on("data", (chunk: Buffer) => this.stderrChunks.push(chunk))
	}

	private consume(chunk: string): void {
		this.buffer += chunk
		this.stdoutLines.push(...chunk.split("\n").filter((l) => l.trim().length > 0))
		this.stdoutLines = this.stdoutLines.slice(-25)
		for (;;) {
			const newlineIndex = this.buffer.indexOf("\n")
			if (newlineIndex === -1) break
			const line = this.buffer.slice(0, newlineIndex)
			this.buffer = this.buffer.slice(newlineIndex + 1)
			if (!line.trim()) continue
			let message: {
				id?: number
				type?: string
				command?: string
				success?: boolean
				data?: RpcResponse
				error?: string
			}
			try {
				message = JSON.parse(line)
			} catch {
				continue
			}
			const waiter = this.pending.get(message.id ?? -1)
			if (!waiter || message.type !== "response") continue
			this.pending.delete(message.id ?? -1)
			if (message.success) {
				waiter.resolve(message.data ?? {})
			} else {
				waiter.reject(new Error(`${message.command ?? waiter.command} failed: ${message.error ?? "unknown error"}`))
			}
		}
	}

	send(type: string, fields: Record<string, unknown> = {}): Promise<RpcResponse> {
		const id = ++this.nextId
		return new Promise<RpcResponse>((resolvePromise, rejectPromise) => {
			const timer = setTimeout(() => {
				this.pending.delete(id)
				rejectPromise(
					new Error(
						`RPC ${type} timed out after ${RESPONSE_TIMEOUT_MS}ms; child stderr tail: ${Buffer.concat(this.stderrChunks).toString("utf-8").slice(-800)}; last stdout lines: ${this.stdoutLines.slice(-10).join(" | ").slice(-800)}`,
					),
				)
			}, RESPONSE_TIMEOUT_MS)
			this.pending.set(id, {
				resolve: (data) => {
					clearTimeout(timer)
					resolvePromise(data)
				},
				reject: (err) => {
					clearTimeout(timer)
					rejectPromise(err)
				},
				command: type,
			})
			this.proc.stdin?.write(`${JSON.stringify({ id, type, ...fields })}\n`)
		})
	}

	stderrText(): string {
		return Buffer.concat(this.stderrChunks).toString("utf-8")
	}
}

describe("RPC export_html destination (process cwd ≠ session cwd)", () => {
	let homeDir: string
	let processDir: string
	let sessionDir: string
	let fake: FakeOpenAiServer
	let proc: ChildProcess
	let client: RpcClient

	beforeEach(async () => {
		homeDir = mkdtempSync(join(tmpdir(), "kimchi-rpc-home-"))
		processDir = mkdtempSync(join(tmpdir(), "kimchi-rpc-process-"))
		sessionDir = mkdtempSync(join(tmpdir(), "kimchi-rpc-session-"))
		fake = await startFakeOpenAiServer({ responses: [] as FakeResponseScript[] })

		// Isolated harness config pointing at the fake model server — mirrors
		// the ACP e2e fixture's setup (no real provider, keys, or network).
		const configDir = join(homeDir, ".config", "kimchi")
		const agentDir = join(configDir, "harness")
		mkdirSync(join(agentDir, "extensions"), { recursive: true })
		writeFileSync(
			join(configDir, "config.json"),
			JSON.stringify(
				{
					apiKey: "fake",
					llmEndpoint: fake.baseUrl,
					skillPaths: [],
					migrationState: "done",
					onboarding: { hideSessionModeDialog: true },
				},
				null,
				"\t",
			),
			"utf-8",
		)
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify(
				{
					providers: {
						fake: {
							baseUrl: `${fake.baseUrl}/openai/v1`,
							apiKey: "fake",
							api: "openai-completions",
							authHeader: true,
							models: [
								{
									id: DEFAULT_MODEL.slug,
									name: DEFAULT_MODEL.displayName,
									reasoning: DEFAULT_MODEL.reasoning,
									input: DEFAULT_MODEL.input,
									contextWindow: 64_000,
									maxTokens: 1024,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
									provider: "fake",
								},
							],
						},
					},
				},
				null,
				"\t",
			),
			"utf-8",
		)
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "fake", defaultModel: DEFAULT_MODEL.slug }, null, "\t"),
			"utf-8",
		)

		// The pre-created session in dir B records its own cwd (dir B) — the
		// header cwd the session manager adopts on switch_session.
		writeFileSync(
			join(sessionDir, "header-only.jsonl"),
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "0f0e0d0c-1111-2222-3333-444455556666",
				timestamp: new Date().toISOString(),
				cwd: sessionDir,
			})}\n`,
			"utf-8",
		)

		// Qualified provider/model: RPC mode resolves --model eagerly at startup,
		// and the harness's own gateway provider (from config apiKey) also serves a
		// "basic" model — the unqualified slug is ambiguous across the two
		// authenticated providers.
		proc = spawn(BINARY_PATH, ["--mode", "rpc", "--model", `fake/${DEFAULT_MODEL.slug}`], {
			stdio: ["pipe", "pipe", "pipe"],
			cwd: processDir,
			env: {
				...process.env,
				HOME: homeDir,
				PI_PACKAGE_DIR: PACKAGE_DIR,
				KIMCHI_PARENT_SESSION_ID: "",
				KIMCHI_DISABLE_BUILTIN_PROVIDERS: "1",
				PI_SKIP_VERSION_CHECK: "1",
				KIMCHI_NO_UPDATE_CHECK: "1",
				KIMCHI_REMOTE_ENDPOINT: fake.baseUrl,
			},
		})
		client = new RpcClient(proc)
		proc.on("exit", (code, signal) => {
			// Fail fast with diagnostics if the server dies during the hook.
			process.stderr.write(
				`[rpc-e2e] kimchi exited with code=${code} signal=${signal} at ${new Date().toISOString()}: ${client
					.stderrText()
					.slice(-600)}\n`,
			)
		})

		// Boot readiness: the first command's response proves the reader is up.
		await client.send("new_session")
	}, 90_000)

	afterEach(async () => {
		if (proc && proc.exitCode === null && proc.signalCode === null) {
			proc.kill("SIGTERM")
			const exited = new Promise<void>((resolveExit) => proc.once("exit", () => resolveExit()))
			const outcome = await Promise.race([exited.then(() => "exited"), delay(3000).then(() => "timeout")])
			// Escalate only when the process is genuinely still alive. A blind
			// delayed SIGKILL would fire on an already-exited pid — and macOS
			// recycles pids fast enough that the kill can land on the NEXT test's
			// freshly spawned binary, killing it mid-boot.
			if (outcome === "timeout" && proc.exitCode === null && proc.signalCode === null) {
				proc.kill("SIGKILL")
				await exited
			}
		}
		await fake.stop().catch(() => {})
		for (const dir of [homeDir, processDir, sessionDir]) {
			rmSync(dir, { recursive: true, force: true })
		}
	})

	function exportSideEffects(dir: string): string[] {
		try {
			return readdirSync(dir).filter((f) => f.endsWith(".html") || f.endsWith(".jsonl"))
		} catch {
			return []
		}
	}

	it("default-path export lands in the session cwd at mode 0600 — nothing in the process cwd", async () => {
		await client.send("switch_session", { sessionPath: join(sessionDir, "header-only.jsonl") })

		const result = await client.send("export_html")
		const exportedPath = result.path
		expect(typeof exportedPath).toBe("string")
		const path = String(exportedPath)

		expect(path.startsWith(sessionDir)).toBe(true)
		expect(path.endsWith(".html")).toBe(true)
		expect(existsSync(path)).toBe(true)
		// A real, processed export (renderer scripts injected by the pipeline).
		const html = readFileSync(path, "utf-8")
		expect(html).toContain('id="trace-id-renderer"')
		// The session side keeps only the session file itself; the process cwd
		// (where upstream's process.cwd()-relative default used to land) has none.
		expect(exportSideEffects(processDir)).toEqual([])
		expect(exportSideEffects(sessionDir)).toEqual(["header-only.jsonl", path.substring(sessionDir.length + 1)])
	})

	it("a relative outputPath resolves against the session cwd", { skip: process.platform === "win32" }, async () => {
		await client.send("switch_session", { sessionPath: join(sessionDir, "header-only.jsonl") })

		const result = await client.send("export_html", { outputPath: "nested/relative-out.html" })
		const path = String(result.path)

		expect(path).toBe(join(sessionDir, "nested", "relative-out.html"))
		expect(existsSync(path)).toBe(true)
		expect(exportSideEffects(processDir)).toEqual([])
	})

	it("published exports are private (0600) on POSIX", { skip: process.platform === "win32" }, async () => {
		await client.send("switch_session", { sessionPath: join(sessionDir, "header-only.jsonl") })
		const result = await client.send("export_html", { outputPath: "permissions.html" })
		const { statSync } = await import("node:fs")
		expect(statSync(String(result.path)).mode & 0o777).toBe(0o600)
	})
})
