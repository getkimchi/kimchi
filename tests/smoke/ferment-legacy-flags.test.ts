import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
	DEFAULT_MODEL,
	type FakeOpenAiServer,
	resolveModels,
	startFakeOpenAiServer,
} from "../e2e/tui/support/fake-openai-server.js"

const BINARY_PATH = resolve("dist/bin/kimchi")
const PACKAGE_DIR = resolve("dist/share/kimchi")
const FAKE_PROVIDER = "fake"
const PROCESS_EXIT_TIMEOUT_MS = 12_000

const EXPECTED_ERROR =
	"--ferment-oneshot needs the legacy Ferment, which is off. Turn it on with: kimchi resources enable extensions.ferment-legacy"

interface ProcessResult {
	code: number | null
	signal: NodeJS.Signals | null
	stdout: string
	stderr: string
	timedOut: boolean
}

describe("V1 --ferment-oneshot legacy gate", () => {
	it("exits 2 with the exact error and makes no model request when legacy is off", async () => {
		const tempRoot = mkdtempSync(join(tmpdir(), "kimchi-ferment-legacy-flags-"))
		let fake: FakeOpenAiServer | undefined
		try {
			fake = await startFakeOpenAiServer({ responses: [{ stream: ["unused"] }] })
			const homeDir = join(tempRoot, "home")
			const workDir = join(tempRoot, "work")
			const sessionDir = join(tempRoot, "sessions")
			mkdirSync(homeDir, { recursive: true })
			mkdirSync(workDir, { recursive: true })
			mkdirSync(sessionDir, { recursive: true })
			writeKimchiConfig(homeDir, fake.baseUrl)

			const result = await runLegacyOneshot({
				homeDir,
				workDir,
				sessionPath: join(sessionDir, "main.jsonl"),
				prompt: "x",
			})
			const failure = `code=${result.code} signal=${result.signal} timedOut=${result.timedOut}\nstderr: ${result.stderr}\nrequests: ${fake.requests.length}`

			expect(result.timedOut, failure).toBe(false)
			expect(result.code, failure).toBe(2)
			expect(result.stderr, failure).toContain(EXPECTED_ERROR)
			// The gate fires before any session or model call: the fake provider
			// must never be hit.
			expect(fake.requests.length, failure).toBe(0)
		} finally {
			await fake?.stop().catch(() => {})
			rmSync(tempRoot, { recursive: true, force: true })
		}
	}, 25_000)
})

function writeKimchiConfig(homeDir: string, fakeBaseUrl: string, models = resolveModels(undefined)): void {
	const configDir = join(homeDir, ".config", "kimchi")
	const agentDir = join(configDir, "harness")
	mkdirSync(agentDir, { recursive: true })

	writeFileSync(
		join(configDir, "config.json"),
		JSON.stringify(
			{
				apiKey: "fake",
				llmEndpoint: fakeBaseUrl,
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
					[FAKE_PROVIDER]: {
						baseUrl: `${fakeBaseUrl}/openai/v1`,
						apiKey: "fake",
						api: "openai-completions",
						authHeader: true,
						headers: { "User-Agent": "kimchi/smoke-test" },
						models: models.map((model) => ({
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
			},
			null,
			"\t",
		),
		"utf-8",
	)
}

async function runLegacyOneshot(options: {
	homeDir: string
	workDir: string
	sessionPath: string
	prompt: string
}): Promise<ProcessResult> {
	const child = spawn(
		BINARY_PATH,
		[
			"-p",
			"--provider",
			FAKE_PROVIDER,
			"--model",
			DEFAULT_MODEL.slug,
			"--session",
			options.sessionPath,
			"--dangerously-skip-permissions",
			"--ferment-oneshot",
			options.prompt,
		],
		{
			cwd: options.workDir,
			env: {
				PATH: process.env.PATH ?? "",
				HOME: options.homeDir,
				PI_PACKAGE_DIR: PACKAGE_DIR,
				KIMCHI_API_KEY: "fake",
				KIMCHI_TELEMETRY_ENABLED: "0",
			},
			stdio: ["pipe", "pipe", "pipe"],
		},
	)

	let stdout = ""
	let stderr = ""
	let timedOut = false
	let forceKill: NodeJS.Timeout | undefined

	child.stdout.setEncoding("utf-8")
	child.stderr.setEncoding("utf-8")
	child.stdout.on("data", (chunk) => {
		stdout += chunk
	})
	child.stderr.on("data", (chunk) => {
		stderr += chunk
	})
	child.stdin.on("error", () => {})

	const exit = new Promise<ProcessResult>((resolvePromise, rejectPromise) => {
		const timeout = setTimeout(() => {
			timedOut = true
			child.kill("SIGTERM")
			forceKill = setTimeout(() => child.kill("SIGKILL"), 500)
		}, PROCESS_EXIT_TIMEOUT_MS)

		child.once("error", (error) => {
			clearTimeout(timeout)
			if (forceKill) clearTimeout(forceKill)
			rejectPromise(error)
		})
		child.once("exit", (code, signal) => {
			clearTimeout(timeout)
			if (forceKill) clearTimeout(forceKill)
			resolvePromise({ code, signal, stdout, stderr, timedOut })
		})
	})

	child.stdin.end(options.prompt)
	return exit
}
