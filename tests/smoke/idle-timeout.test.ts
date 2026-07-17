/**
 * HTTP idle timeout — compiled-binary smoke test.
 *
 * The idle-timeout enforcement lives in an app-level fetch wrapper
 * (src/stream-idle-timeout.ts) because undici dispatcher timeouts are inert
 * under Bun, the runtime the shipped binary uses. That makes this the one test
 * layer that can catch a regression: unit tests run under Node, where the
 * undici path works and would mask a wrapper that never engages in the binary.
 *
 * Scenario: a fake OpenAI-compatible gateway streams one SSE chunk and then
 * stalls forever. With `httpIdleTimeoutMs` set low, the binary must terminate
 * the stalled connection near the deadline (observed as the server socket
 * closing) and exit on its own instead of hanging until an external kill.
 */

import { type ChildProcess, spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { BINARY_PATH, PACKAGE_DIR } from "./harness.js"

const IDLE_TIMEOUT_MS = 2_000
const RUN_DEADLINE_MS = 45_000

interface AttemptLog {
	url: string
	startedAt: number
	closedAt?: number
}

let server: Server
let baseUrl: string
let homeDir: string
let workDir: string
const attempts: AttemptLog[] = []

beforeAll(async () => {
	server = createServer((req, res) => {
		req.resume()
		req.on("end", () => {
			// Only the inference route stalls. Startup fetches (model metadata,
			// billing) get an immediate 404 so they fail fast instead of each
			// burning its own multi-second deadline (the metadata refresh alone
			// waits 20s — see FETCH_TIMEOUT_MS in src/models.ts) before the
			// request under test even starts.
			if (!(req.url ?? "").includes("/chat/completions")) {
				res.writeHead(404).end()
				return
			}
			const attempt: AttemptLog = { url: req.url ?? "", startedAt: Date.now() }
			attempts.push(attempt)
			res.writeHead(200, { "content-type": "text/event-stream" })
			res.write(
				`data: ${JSON.stringify({
					id: "stall",
					object: "chat.completion.chunk",
					choices: [{ index: 0, delta: { role: "assistant", content: "hel" } }],
				})}\n\n`,
			)
			// Never write again, never end — a silently dead upstream socket.
			res.socket?.on("close", () => {
				attempt.closedAt = Date.now()
			})
		})
	})
	await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen))
	const address = server.address()
	if (address === null || typeof address === "string") throw new Error("server did not bind a port")
	baseUrl = `http://127.0.0.1:${address.port}`

	homeDir = mkdtempSync(join(tmpdir(), "kimchi-idle-smoke-home-"))
	workDir = mkdtempSync(join(tmpdir(), "kimchi-idle-smoke-work-"))
	const configDir = join(homeDir, ".config", "kimchi")
	const agentDir = join(configDir, "harness")
	mkdirSync(agentDir, { recursive: true })
	writeFileSync(
		join(configDir, "config.json"),
		JSON.stringify({
			apiKey: "fake",
			llmEndpoint: baseUrl,
			skillPaths: [],
			migrationState: "done",
			onboarding: { hideSessionModeDialog: true },
		}),
	)
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				"stall-test": {
					baseUrl: `${baseUrl}/openai/v1`,
					apiKey: "fake",
					api: "openai-completions",
					authHeader: true,
					models: [
						{
							id: "stall-model",
							name: "Stall Model",
							reasoning: false,
							input: ["text"],
							contextWindow: 128000,
							maxTokens: 16384,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
					],
				},
			},
		}),
	)
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({
			httpIdleTimeoutMs: IDLE_TIMEOUT_MS,
			retry: { maxRetries: 1, baseDelayMs: 100 },
		}),
	)
})

afterAll(async () => {
	await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
	rmSync(homeDir, { recursive: true, force: true })
	rmSync(workDir, { recursive: true, force: true })
})

function runOnce(): Promise<{ exit: number | string | null; output: string; timedOut: boolean }> {
	return new Promise((resolveRun) => {
		const child: ChildProcess = spawn(
			BINARY_PATH,
			["--print", "--provider", "stall-test", "--model", "stall-model", "hi"],
			{
				cwd: workDir,
				env: {
					PATH: process.env.PATH ?? "",
					HOME: homeDir,
					PI_PACKAGE_DIR: PACKAGE_DIR,
					KIMCHI_API_KEY: "fake",
					KIMCHI_TELEMETRY_ENABLED: "0",
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		)
		let output = ""
		let timedOut = false
		child.stdout?.setEncoding("utf-8")
		child.stderr?.setEncoding("utf-8")
		child.stdout?.on("data", (chunk: string) => {
			output += chunk
		})
		child.stderr?.on("data", (chunk: string) => {
			output += chunk
		})
		const killTimer = setTimeout(() => {
			timedOut = true
			child.kill("SIGKILL")
		}, RUN_DEADLINE_MS)
		child.on("exit", (code, signal) => {
			clearTimeout(killTimer)
			resolveRun({ exit: signal ?? code, output, timedOut })
		})
	})
}

describe("http idle timeout in the compiled binary", () => {
	it(
		"terminates a stalled inference stream at the configured deadline and exits",
		async () => {
			const result = await runOnce()

			// The binary must give up on its own, not via our kill switch.
			expect(result.timedOut).toBe(false)

			// The gateway saw an inference attempt (other startup fetches get an
			// immediate 404 and don't stall), and the binary tore the stalled
			// inference connection down near the configured deadline (generous
			// upper bound to absorb CI scheduling noise; the pre-fix behavior is
			// no close at all).
			const inference = attempts.filter((a) => a.url.includes("/chat/completions"))
			expect(
				inference.length,
				`no inference attempt reached the gateway; output:\n${result.output}`,
			).toBeGreaterThanOrEqual(1)
			const first = inference[0]
			expect(first.closedAt, `stalled connection was never closed; output:\n${result.output}`).toBeDefined()
			const stallToClose = (first.closedAt as number) - first.startedAt
			expect(stallToClose).toBeGreaterThanOrEqual(IDLE_TIMEOUT_MS - 500)
			expect(stallToClose).toBeLessThan(IDLE_TIMEOUT_MS + 10_000)
		},
		RUN_DEADLINE_MS + 15_000,
	)
})
