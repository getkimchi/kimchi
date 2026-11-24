import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, it } from "vitest"
import {
	DEFAULT_MODEL,
	type FakeOpenAiServer,
	type FakeResponseScript,
	startFakeOpenAiServer,
} from "../e2e/tui/support/fake-openai-server.js"
import { writeKimchiConfig } from "./print-config.js"

const BINARY_PATH = resolve("dist/bin/kimchi")
const PACKAGE_DIR = resolve("dist/share/kimchi")
const PROCESS_EXIT_TIMEOUT_MS = 12_000

const KIMCHI_INFRA_ERROR_EXIT_CODE = 74

function infraErrorResponse(): FakeResponseScript {
	return { status: 503, body: { error: "Service Unavailable" } }
}

function runPrint(
	homeDir: string,
	workDir: string,
	sessionPath: string,
	prompt: string,
	modelArgs = ["--provider", "fake", "--model", DEFAULT_MODEL.slug],
) {
	return new Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>((resolvePromise) => {
		const child = spawn(BINARY_PATH, ["--print", ...modelArgs, "--session", sessionPath], {
			cwd: workDir,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: homeDir,
				PI_PACKAGE_DIR: PACKAGE_DIR,
				KIMCHI_API_KEY: "fake",
				KIMCHI_PERMISSIONS: "yolo",
				KIMCHI_TELEMETRY_ENABLED: "0",
			},
		})
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

// Kimchi Studio still launches new terminal sessions with `--model multi-model`.
it("starts on the saved default model when launched with the retired --model multi-model", {
	timeout: 25_000,
}, async () => {
	const tempRoot = mkdtempSync(join(tmpdir(), "kimchi-print-exit-"))
	let fake: FakeOpenAiServer | undefined
	try {
		fake = await startFakeOpenAiServer({ responses: [{ stream: ["The default model answered."] }] })
		const homeDir = join(tempRoot, "home")
		const workDir = join(tempRoot, "work")
		const sessionPath = join(tempRoot, "main.jsonl")
		mkdirSync(homeDir, { recursive: true })
		mkdirSync(workDir, { recursive: true })
		writeKimchiConfig(homeDir, fake.baseUrl)
		const settingsPath = join(homeDir, ".config", "kimchi", "harness", "settings.json")
		const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))
		writeFileSync(
			settingsPath,
			JSON.stringify({ ...settings, defaultProvider: "fake", defaultModel: DEFAULT_MODEL.slug }),
		)

		const result = await runPrint(homeDir, workDir, sessionPath, "hello", ["--model", "multi-model"])
		const failure = `timedOut=${result.timedOut} code=${result.code}\nstdout=${result.stdout}\nstderr=${result.stderr}`
		const chatRequests = fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))

		expect(result.timedOut, failure).toBe(false)
		expect(result.code, failure).toBe(0)
		expect(result.stderr, failure).toContain("--model multi-model is no longer supported")
		expect(result.stdout, failure).toContain("The default model answered.")
		expect((chatRequests[0]?.body as { model?: string } | undefined)?.model, failure).toBe(DEFAULT_MODEL.slug)
	} finally {
		await fake?.stop().catch(() => {})
		rmSync(tempRoot, { recursive: true, force: true })
	}
})
