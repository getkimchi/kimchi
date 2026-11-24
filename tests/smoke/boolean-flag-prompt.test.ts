import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { expect, it } from "vitest"
import { DEFAULT_MODEL, type FakeOpenAiServer, startFakeOpenAiServer } from "../e2e/tui/support/fake-openai-server.js"
import { writeKimchiConfig } from "./print-config.js"

const BINARY_PATH = resolve("dist/bin/kimchi")
const PACKAGE_DIR = resolve("dist/share/kimchi")
const PROCESS_EXIT_TIMEOUT_MS = 12_000

interface RunResult {
	code: number | null
	stdout: string
	stderr: string
	timedOut: boolean
}

function runKimchi(homeDir: string, workDir: string, sessionPath: string, argvTail: string[]): Promise<RunResult> {
	return new Promise((resolvePromise) => {
		const child = spawn(
			BINARY_PATH,
			["--provider", "fake", "--model", DEFAULT_MODEL.slug, "--session", sessionPath, ...argvTail],
			{
				cwd: workDir,
				env: {
					PATH: process.env.PATH ?? "",
					HOME: homeDir,
					PI_PACKAGE_DIR: PACKAGE_DIR,
					KIMCHI_API_KEY: "fake",
					KIMCHI_TELEMETRY_ENABLED: "0",
				},
			},
		)
		let stdout = ""
		let stderr = ""
		let timedOut = false
		child.stdout.setEncoding("utf-8").on("data", (chunk) => (stdout += chunk))
		child.stderr.setEncoding("utf-8").on("data", (chunk) => (stderr += chunk))
		child.stdin.on("error", () => {})
		child.stdin.end()
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

function contentText(content: unknown): string {
	if (typeof content === "string") return content
	if (!Array.isArray(content)) return ""
	return content
		.map((part) =>
			part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string"
				? (part as { text: string }).text
				: "",
		)
		.join("")
}

function fakeModelSawPrompt(fake: FakeOpenAiServer, prompt: string): boolean {
	return fake.requests
		.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
		.some((request) => {
			const messages = (request.body as { messages?: Array<{ role?: string; content?: unknown }> } | undefined)
				?.messages
			return (messages ?? []).some(
				(message) => message.role === "user" && contentText(message.content).includes(prompt),
			)
		})
}

function readJsonLines(path: string): unknown[] {
	if (!existsSync(path)) return []
	return parseJsonLines(readFileSync(path, "utf-8"))
}

function parseJsonLines(text: string): unknown[] {
	const entries: unknown[] = []
	for (const line of text.split("\n")) {
		if (line.trim().length === 0) continue
		try {
			entries.push(JSON.parse(line))
		} catch {
			// Non-JSON lines are ignored.
		}
	}
	return entries
}

function mainSessionHasUserPrompt(sessionPath: string, prompt: string): boolean {
	return readJsonLines(sessionPath).some((entry) => {
		const e = entry as { type?: string; message?: { role?: string; content?: unknown } }
		return e.type === "message" && e.message?.role === "user" && contentText(e.message.content) === prompt
	})
}

function isAssistantMessageEvent(entry: unknown): boolean {
	const e = entry as { type?: string; message?: { role?: string } }
	return e.type === "message_end" && e.message?.role === "assistant"
}

async function withFake(
	finalText: string,
	body: (ctx: { fake: FakeOpenAiServer; homeDir: string; workDir: string; sessionPath: string }) => Promise<void>,
): Promise<void> {
	const tempRoot = mkdtempSync(join(tmpdir(), "kimchi-boolean-prompt-"))
	let fake: FakeOpenAiServer | undefined
	try {
		fake = await startFakeOpenAiServer({ responses: [{ stream: [finalText] }] })
		const homeDir = join(tempRoot, "home")
		const workDir = join(tempRoot, "work")
		mkdirSync(homeDir, { recursive: true })
		mkdirSync(workDir, { recursive: true })
		writeKimchiConfig(homeDir, fake.baseUrl)
		await body({ fake, homeDir, workDir, sessionPath: join(tempRoot, "main.jsonl") })
	} finally {
		await fake?.stop().catch(() => {})
		rmSync(tempRoot, { recursive: true, force: true })
	}
}

function describeFailure(result: RunResult): string {
	return `timedOut=${result.timedOut} code=${result.code}\nstdout=${result.stdout}\nstderr=${result.stderr}`
}

it("preserves a text-mode positional prompt after --auto", { timeout: 25_000 }, async () => {
	const prompt = "Prompt after auto in text mode."
	const finalText = "Text mode after auto answered."
	await withFake(finalText, async ({ fake, homeDir, workDir, sessionPath }) => {
		const result = await runKimchi(homeDir, workDir, sessionPath, ["--print", "--mode", "text", "--auto", prompt])
		const failure = describeFailure(result)
		expect(result.code, failure).toBe(0)
		expect(result.timedOut, failure).toBe(false)
		expect(result.stdout, failure).toContain(finalText)
		expect(fakeModelSawPrompt(fake, prompt), failure).toBe(true)
		expect(mainSessionHasUserPrompt(sessionPath, prompt), failure).toBe(true)
	})
})

it("preserves a JSON-mode positional prompt after --yolo", { timeout: 25_000 }, async () => {
	const prompt = "Prompt after yolo in JSON mode."
	await withFake("JSON mode after yolo answered.", async ({ fake, homeDir, workDir, sessionPath }) => {
		const result = await runKimchi(homeDir, workDir, sessionPath, ["--print", "--mode", "json", "--yolo", prompt])
		const failure = describeFailure(result)
		expect(result.code, failure).toBe(0)
		expect(parseJsonLines(result.stdout).some(isAssistantMessageEvent), failure).toBe(true)
		expect(fakeModelSawPrompt(fake, prompt), failure).toBe(true)
		expect(mainSessionHasUserPrompt(sessionPath, prompt), failure).toBe(true)
	})
})

it("preserves a prompt placed before --auto", { timeout: 25_000 }, async () => {
	const prompt = "Prompt placed before auto."
	const finalText = "Prompt-first control answered."
	await withFake(finalText, async ({ fake, homeDir, workDir, sessionPath }) => {
		const result = await runKimchi(homeDir, workDir, sessionPath, ["--print", prompt, "--mode", "text", "--auto"])
		const failure = describeFailure(result)
		expect(result.code, failure).toBe(0)
		expect(result.stdout, failure).toContain(finalText)
		expect(fakeModelSawPrompt(fake, prompt), failure).toBe(true)
		expect(mainSessionHasUserPrompt(sessionPath, prompt), failure).toBe(true)
	})
})
