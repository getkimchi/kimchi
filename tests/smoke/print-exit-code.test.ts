import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, it } from "vitest"
import {
	DEFAULT_MODEL,
	type FakeOpenAiServer,
	type FakeResponseScript,
	resolveModels,
	startFakeOpenAiServer,
} from "../e2e/tui/support/fake-openai-server.js"

const BINARY_PATH = resolve("dist/bin/kimchi")
const PACKAGE_DIR = resolve("dist/share/kimchi")
const PROCESS_EXIT_TIMEOUT_MS = 12_000

// pi-coding-agent's own exit-code constant (LLM_GATEWAY_INFRASTRUCTURE_EXIT_CODE in
// src/llm-gateway-error.ts). Hardcoded rather than imported so this test exercises
// only the compiled binary, matching every other tests/smoke/*.test.ts file.
const KIMCHI_INFRA_ERROR_EXIT_CODE = 74

/** Use a real HTTP 503: streamError is normalized to a generic finish-reason
 * message and would not exercise provider_5xx classification. */
function infraErrorResponse(): FakeResponseScript {
	return { status: 503, body: { error: "Service Unavailable" } }
}

function writeKimchiConfig(homeDir: string, fakeBaseUrl: string): void {
	const configDir = join(homeDir, ".config", "kimchi")
	const harnessDir = join(configDir, "harness")
	mkdirSync(harnessDir, { recursive: true })
	writeFileSync(
		join(configDir, "config.json"),
		JSON.stringify({ apiKey: "fake", llmEndpoint: fakeBaseUrl, skillPaths: [], migrationState: "done" }),
	)
	writeFileSync(
		join(harnessDir, "settings.json"),
		JSON.stringify({
			multiModel: false,
			// No extensions enabled: this is a plain --print run, not a Goal run.
			// The exit-code path under test (applyPostMainInfrastructureExitPolicy
			// in src/cli-infrastructure-exit.ts) applies to every --print invocation,
			// not just Goal continuations.
			resources: {},
			// Keep the real retry path but reduce its backoff for this smoke test.
			retry: { maxRetries: 1, baseDelayMs: 10 },
		}),
	)
	writeFileSync(
		join(harnessDir, "models.json"),
		JSON.stringify({
			providers: {
				fake: {
					baseUrl: `${fakeBaseUrl}/openai/v1`,
					apiKey: "fake",
					api: "openai-completions",
					authHeader: true,
					models: resolveModels(undefined).map((model) => ({
						id: model.slug,
						name: model.displayName,
						reasoning: model.reasoning,
						input: model.input,
						contextWindow: model.contextWindow,
						maxTokens: model.maxTokens,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					})),
				},
			},
		}),
	)
}

function runPrint(homeDir: string, workDir: string, sessionPath: string, prompt: string) {
	return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolvePromise) => {
		const child = spawn(
			BINARY_PATH,
			["--print", "--provider", "fake", "--model", DEFAULT_MODEL.slug, "--session", sessionPath],
			{
				cwd: workDir,
				env: {
					PATH: process.env.PATH ?? "",
					HOME: homeDir,
					PI_PACKAGE_DIR: PACKAGE_DIR,
					KIMCHI_API_KEY: "fake",
					KIMCHI_PERMISSIONS: "yolo",
					KIMCHI_TELEMETRY_ENABLED: "0",
				},
			},
		)
		let stdout = ""
		let stderr = ""
		let timedOut = false
		child.stdout.setEncoding("utf-8").on("data", (chunk) => (stdout += chunk))
		child.stderr.setEncoding("utf-8").on("data", (chunk) => (stderr += chunk))
		child.stdin.end(prompt)
		const timeout = setTimeout(() => {
			timedOut = true
			child.kill("SIGKILL")
		}, PROCESS_EXIT_TIMEOUT_MS)
		child.once("exit", (code) => {
			clearTimeout(timeout)
			resolvePromise({ code, stdout, stderr, timedOut })
		})
	})
}

it("exits 0 when a --print run hits a transient infrastructure error and the retry succeeds", {
	timeout: 25_000,
}, async () => {
	// Regression for print-mode exit policy after an infrastructure retry recovers.
	const tempRoot = mkdtempSync(join(tmpdir(), "kimchi-print-exit-"))
	let fake: FakeOpenAiServer | undefined
	try {
		fake = await startFakeOpenAiServer({
			responses: [infraErrorResponse(), { stream: ["The retry succeeded."] }],
		})
		const homeDir = join(tempRoot, "home")
		const workDir = join(tempRoot, "work")
		const sessionPath = join(tempRoot, "main.jsonl")
		mkdirSync(homeDir, { recursive: true })
		mkdirSync(workDir, { recursive: true })
		writeKimchiConfig(homeDir, fake.baseUrl)

		const result = await runPrint(homeDir, workDir, sessionPath, "hello")
		const failure = `timedOut=${result.timedOut} code=${result.code}\nstdout=${result.stdout}\nstderr=${result.stderr}`
		const chatRequests = fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))

		expect(result.timedOut, failure).toBe(false)
		expect(result.code, failure).toBe(0)
		expect(result.stdout, failure).toContain("The retry succeeded.")
		// Proves the fake server's scripted infra error actually fired and a
		// genuine retry happened, rather than the first response being skipped
		// or the success reply answering on the first request.
		expect(chatRequests.length, failure).toBeGreaterThan(1)
	} finally {
		await fake?.stop().catch(() => {})
		rmSync(tempRoot, { recursive: true, force: true })
	}
})

it("exits non-zero when every attempt of a --print run hits an infrastructure error", { timeout: 25_000 }, async () => {
	// Confirm the 503 remains classified as infrastructure, not merely any failure.
	const tempRoot = mkdtempSync(join(tmpdir(), "kimchi-print-exit-"))
	let fake: FakeOpenAiServer | undefined
	try {
		fake = await startFakeOpenAiServer({
			// maxRetries: 1 means exactly 2 attempts before giving up.
			responses: [infraErrorResponse(), infraErrorResponse()],
		})
		const homeDir = join(tempRoot, "home")
		const workDir = join(tempRoot, "work")
		const sessionPath = join(tempRoot, "main.jsonl")
		mkdirSync(homeDir, { recursive: true })
		mkdirSync(workDir, { recursive: true })
		writeKimchiConfig(homeDir, fake.baseUrl)

		const result = await runPrint(homeDir, workDir, sessionPath, "hello")
		const failure = `timedOut=${result.timedOut} code=${result.code}\nstdout=${result.stdout}\nstderr=${result.stderr}`
		const chatRequests = fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))

		expect(result.timedOut, failure).toBe(false)
		expect(result.code, failure).toBe(KIMCHI_INFRA_ERROR_EXIT_CODE)
		expect(result.stderr, failure).toContain("KIMCHI_INFRA_ERROR")
		expect(result.stdout, failure).toBe("")
		expect(chatRequests.length, failure).toBeGreaterThan(1)
	} finally {
		await fake?.stop().catch(() => {})
		rmSync(tempRoot, { recursive: true, force: true })
	}
})
