import {
	constants,
	accessSync,
	copyFileSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { BINARY_PATH, getAgentDir, runBinary } from "./harness.js"

describe("binary smoke tests", () => {
	it("binary exists and is executable", () => {
		accessSync(BINARY_PATH, constants.X_OK)
	})

	it("--version exits cleanly", () => {
		const result = runBinary({
			args: ["--version"],
			extraEnv: { KIMCHI_API_KEY: "smoke-test-dummy" },
		})
		expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/)
	})

	it("--help exits cleanly", () => {
		const result = runBinary({
			args: ["--help"],
			extraEnv: { KIMCHI_API_KEY: "smoke-test-dummy" },
		})
		expect(result.stdout).toContain("Usage")
	})

	it("--help shows kimchi subcommands, harness flags, and env vars (no pi internals)", () => {
		const result = runBinary({
			args: ["--help"],
			extraEnv: { KIMCHI_API_KEY: "smoke-test-dummy" },
		})
		// Subcommand catalogue
		expect(result.stdout).toContain("Subcommands:")
		expect(result.stdout).toContain("kimchi setup")
		expect(result.stdout).toContain("kimchi claude")
		expect(result.stdout).toContain("kimchi opencode")
		expect(result.stdout).toContain("kimchi cursor")
		expect(result.stdout).toContain("kimchi openclaw")
		expect(result.stdout).toContain("kimchi gsd2")
		// Curated harness flags forwarded to pi
		expect(result.stdout).toContain("--provider")
		expect(result.stdout).toContain("--mode")
		expect(result.stdout).toContain("--continue")
		expect(result.stdout).toContain("--resume, -r [id]")
		// Kimchi-only env vars
		expect(result.stdout).toContain("KIMCHI_API_KEY")
		// Pi-internal extension management commands and provider-specific env
		// vars must not leak into kimchi's help screen.
		expect(result.stdout).not.toContain("install <source>")
		expect(result.stdout).not.toContain("ANTHROPIC_API_KEY")
		expect(result.stdout).not.toContain("OPENAI_API_KEY")
	})

	it("version subcommand prints version + platform without launching the harness", () => {
		const result = runBinary({
			args: ["version"],
			extraEnv: { KIMCHI_API_KEY: "smoke-test-dummy" },
		})
		expect(result.stdout).toMatch(/^kimchi (?:dev|\d+\.\d+\.\d+)/)
		expect(result.stdout).toContain("platform:")
	})

	it("unknown arg falls through to the harness (pi prints the unrecognised-flag warning)", () => {
		// Pi treats unknown flags as extension flags and surfaces a diagnostic.
		// We just need to assert the dispatcher didn't intercept — the easiest
		// signal is that the harness session attempts to run (stderr contains
		// pi's startup diagnostics, not our "not implemented" stub message).
		const result = runBinary({
			args: ["--definitely-not-a-real-flag=value"],
			extraEnv: { KIMCHI_API_KEY: "smoke-test-dummy" },
			throwOnError: false,
			timeoutMs: 5_000,
		})
		expect(result.stdout + result.stderr).not.toContain("not implemented yet on this branch")
	})

	it("-r with an id is treated as a session selector", () => {
		const missingSessionId = "019f1780-8034-7435-85aa-3e86037676ee"
		const result = runBinary({
			args: ["-r", missingSessionId],
			extraEnv: { KIMCHI_API_KEY: "smoke-test-dummy" },
			throwOnError: false,
			timeoutMs: 5_000,
		})
		expect(result.status).not.toBe(0)
		expect(result.stdout + result.stderr).toContain(`No session found matching '${missingSessionId}'`)
	})

	it("prompt templates are embedded in binary (no extension errors on startup)", () => {
		const result = runBinary({
			args: ["-p", "hello"],
			extraEnv: { KIMCHI_API_KEY: "smoke-test-dummy" },
			throwOnError: false,
		})
		// The orchestration extension fires "input" and "before_agent_start" events, triggering template loading. If templates are missing from the compiled binary, the extension runner reports ENOENT via "Extension error" on stderr.
		expect(result.stderr).not.toContain("Extension error")
	})

	it("auto-names persisted sessions from the first user prompt", () => {
		const before = new Set(listSessionFiles())
		const prompt = "Explore 3 random files"
		runBinary({
			args: ["--debug-prompts", "-p", prompt],
			extraEnv: { KIMCHI_API_KEY: "smoke-test-dummy" },
			throwOnError: false,
			timeoutMs: 10_000,
		})

		const newEntries = listSessionFiles()
			.filter((file) => !before.has(file))
			.flatMap(readSessionEntries)

		expect(newEntries).toContainEqual(expect.objectContaining({ type: "session_info", name: prompt }))
	})

	describe("--export", () => {
		const fixtureSrc = resolve("tests/smoke/fixtures/session.jsonl")
		let workDir: string

		beforeEach(() => {
			workDir = mkdtempSync(join(tmpdir(), "kimchi-smoke-export-"))
		})

		afterEach(() => {
			rmSync(workDir, { recursive: true, force: true })
		})

		it("exports a session to HTML using staged template assets", () => {
			// Copy the fixture into a scratch dir — the binary rewrites the jsonl on load to populate IDs, which would mutate the checked-in file.
			const sessionPath = join(workDir, "session.jsonl")
			copyFileSync(fixtureSrc, sessionPath)
			const outPath = join(workDir, "session.html")
			const result = runBinary({
				args: ["--export", sessionPath, outPath],
				extraEnv: { KIMCHI_API_KEY: "smoke-test-dummy" },
			})
			expect(result.stdout).toContain(outPath)
			// Output must load the template + vendor bundle (marked + highlight ≈ 200KB), so 10KB is a safe regression floor.
			expect(statSync(outPath).size).toBeGreaterThan(10_000)
			const html = readFileSync(outPath, "utf-8")
			expect(html).toContain("window.__KIMCHI_VERSION")
			expect(html).toContain('class="info-label">Version:')
		})
	})

	it.skipIf(!process.env.KIMCHI_API_KEY)("sends a request to a model via -p flag", { retry: 2 }, () => {
		const result = runBinary({
			args: ["--debug-prompts", "-p", "respond with only the word hello"],
			extraEnv: { KIMCHI_API_KEY: process.env.KIMCHI_API_KEY as string },
		})
		expect(result.stdout.trim()).not.toBe("")
	})
})

function listSessionFiles(dir = join(getAgentDir(), "sessions")): string[] {
	if (!existsSync(dir)) return []

	const files: string[] = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) {
			files.push(...listSessionFiles(path))
		} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
			files.push(path)
		}
	}
	return files
}

function readSessionEntries(file: string): Array<Record<string, unknown>> {
	return readFileSync(file, "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
}
