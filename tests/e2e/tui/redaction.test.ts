import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import type { KimchiFixture } from "./support/kimchi-fixture.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/** Secret value set via env var. Long enough to pass MIN_SECRET_LENGTH (8). */
const ENV_SECRET_VALUE = "ak_known-test-secret-1234567890"
const ENV_SECRET_NAME = "TEST_API_KEY"

/** A GitHub classic token that matches the pattern catalog but is NOT in the known secrets set. */
const PATTERN_GITHUB_TOKEN = "ghp_0123456789abcdefghij0123456789abcdefghij"

/** Check if any recorded LLM request body contains the given text. */
function anyRequestBodyContains(fixture: KimchiFixture, text: string): boolean {
	return fixture.fake.requests.some((req) => JSON.stringify(req.body ?? "").includes(text))
}

/** Check if any recorded LLM request body contains [REDACTED]. */
function anyRequestBodyContainsRedacted(fixture: KimchiFixture): boolean {
	return anyRequestBodyContains(fixture, "[REDACTED]")
}

/**
 * Find the most recent .jsonl session file under the fixture's home dir.
 * Session files are stored at <agentDir>/sessions/<encoded_cwd>/<timestamp>_<id>.jsonl.
 * We don't know the encoded cwd, so we scan recursively.
 */
function findSessionFile(homeDir: string): string | undefined {
	const sessionsDir = join(homeDir, ".config", "kimchi", "harness", "sessions")
	function findJsonl(dir: string): string | undefined {
		let entries: ReturnType<typeof readdirSync>
		try {
			entries = readdirSync(dir, { withFileTypes: true })
		} catch {
			return undefined
		}
		for (const entry of entries) {
			if (entry.isFile() && entry.name.endsWith(".jsonl")) {
				return join(dir, entry.name)
			}
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				const found = findJsonl(join(dir, entry.name))
				if (found) return found
			}
		}
		return undefined
	}
	return findJsonl(sessionsDir)
}

test("known secret from env is redacted in tool results", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "redaction-known-secret-env",
			env: { [ENV_SECRET_NAME]: ENV_SECRET_VALUE },
			responses: [
				// Turn 1: model calls bash to echo the env var.
				{
					stream: ["Let me check the environment."],
					toolCalls: [
						{
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: `echo $${ENV_SECRET_NAME}` }),
							},
						},
					],
				},
				// Turn 2: model acknowledges the (redacted) result.
				{ stream: ["Done checking."] },
			],
		},
		async (fixture) => {
			terminal.submit("check the env")
			await waitForText(terminal, "Done checking.", { timeoutMs: STREAM_TIMEOUT_MS })

			// The secret value must NOT appear in any LLM request body.
			expect(anyRequestBodyContains(fixture, ENV_SECRET_VALUE)).toBe(false)

			// [REDACTED] must appear in at least one request body (the tool result).
			expect(anyRequestBodyContainsRedacted(fixture)).toBe(true)
		},
	)
})

test("pattern-based secret is redacted without being in known secrets", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "redaction-pattern-based",
			responses: [
				// Turn 1: model calls bash that echoes a GitHub token.
				{
					stream: ["Checking for tokens."],
					toolCalls: [
						{
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: `echo "${PATTERN_GITHUB_TOKEN}"` }),
							},
						},
					],
				},
				// Turn 2: model acknowledges.
				{ stream: ["Done."] },
			],
		},
		async (fixture) => {
			terminal.submit("check for tokens")
			await waitForText(terminal, "Done.", { timeoutMs: STREAM_TIMEOUT_MS })

			// The token must NOT appear in any LLM request body.
			expect(anyRequestBodyContains(fixture, PATTERN_GITHUB_TOKEN)).toBe(false)

			// [REDACTED] must appear (pattern catalog caught it).
			expect(anyRequestBodyContainsRedacted(fixture)).toBe(true)
		},
	)
})

test("secret in tool-call args is scrubbed in subsequent context", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "redaction-tool-call-args",
			env: { [ENV_SECRET_NAME]: ENV_SECRET_VALUE },
			responses: [
				// Turn 1: model calls bash with the literal secret value as an argument.
				{
					stream: ["Running a command with the secret."],
					toolCalls: [
						{
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: `echo "${ENV_SECRET_VALUE}"` }),
							},
						},
					],
				},
				// Turn 2: model acknowledges.
				{ stream: ["Done."] },
			],
		},
		async (fixture) => {
			terminal.submit("run the command")
			await waitForText(terminal, "Done.", { timeoutMs: STREAM_TIMEOUT_MS })

			// The secret value must NOT appear anywhere in any LLM request body —
			// not in tool result content, not in tool-call args.
			expect(anyRequestBodyContains(fixture, ENV_SECRET_VALUE)).toBe(false)

			// [REDACTED] must appear (in both tool result content and scrubbed args).
			expect(anyRequestBodyContainsRedacted(fixture)).toBe(true)
		},
	)
})

test("session file at rest is scrubbed after turn_end", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "redaction-session-file",
			env: { [ENV_SECRET_NAME]: ENV_SECRET_VALUE },
			responses: [
				// Turn 1: model calls bash to echo the env var (secret in output).
				{
					stream: ["Checking the environment."],
					toolCalls: [
						{
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: `echo $${ENV_SECRET_NAME}` }),
							},
						},
					],
				},
				// Turn 2: model acknowledges — turn_end fires after this.
				{ stream: ["Done."] },
			],
		},
		async (fixture) => {
			terminal.submit("check env")
			await waitForText(terminal, "Done.", { timeoutMs: STREAM_TIMEOUT_MS })

			// Give turn_end a moment to fire and scrub the session file.
			await new Promise((resolve) => setTimeout(resolve, 1000))

			// Find the session file on disk.
			const sessionFile = findSessionFile(fixture.homeDir)
			expect(sessionFile).toBeDefined()

			// Read the session file and assert the secret is scrubbed.
			const content = readFileSync(sessionFile!, "utf-8")
			expect(content).not.toContain(ENV_SECRET_VALUE)
			expect(content).toContain("[REDACTED]")
		},
	)
})

test("normal tool output is not redacted (no false positives)", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "redaction-no-false-positives",
			responses: [
				// Turn 1: model calls bash with a simple echo.
				{
					stream: ["Listing files."],
					toolCalls: [
						{
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: 'echo "hello world from test"' }),
							},
						},
					],
				},
				// Turn 2: model acknowledges.
				{ stream: ["Done."] },
			],
		},
		async (fixture) => {
			terminal.submit("list files")
			await waitForText(terminal, "Done.", { timeoutMs: STREAM_TIMEOUT_MS })

			// The normal output must appear in at least one request body
			// (the tool result sent back to the model).
			expect(anyRequestBodyContains(fixture, "hello world from test")).toBe(true)

			// [REDACTED] must NOT appear — no secrets were present.
			expect(anyRequestBodyContainsRedacted(fixture)).toBe(false)
		},
	)
})
