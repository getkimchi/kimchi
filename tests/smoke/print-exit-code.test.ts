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

const KIMCHI_INFRA_ERROR_EXIT_CODE = 74

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
			resources: {},
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
		expect(chatRequests.length, failure).toBeGreaterThan(1)
	} finally {
		await fake?.stop().catch(() => {})
		rmSync(tempRoot, { recursive: true, force: true })
	}
})

it("exits non-zero when every attempt of a --print run hits an infrastructure error", { timeout: 25_000 }, async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "kimchi-print-exit-"))
	let fake: FakeOpenAiServer | undefined
	try {
		fake = await startFakeOpenAiServer({
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
