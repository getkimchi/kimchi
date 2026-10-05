import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { fullText, INPUT_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/** The base URL the self-hosted login flow is driven with. */
const SELF_HOSTED_BASE = "https://kimchi-self-hosted.example.com"

/**
 * Extract the browser-login callback coordinates from the terminal buffer.
 * Same normalization as login-region.test.ts: the OSC-8 link wraps across
 * rows, so whitespace is stripped before matching, and the state's full
 * 64-hex-char length is pinned so only the complete URL matches.
 */
function browserLoginUrl(terminal: Parameters<typeof fullText>[0]): { port: number; state: string } {
	const text = fullText(terminal).replace(/\s+/g, "")
	const match = /callback=http%3A%2F%2F127\.0\.0\.1%3A(\d+)%2Fcallback&state=([0-9a-f]{64})/.exec(text)
	if (!match) throw new Error("browser-login URL not found in terminal output")
	return { port: Number(match[1]), state: match[2] }
}

async function waitForConfigField(configPath: string, expected: Record<string, unknown>): Promise<void> {
	const deadline = Date.now() + STREAM_TIMEOUT_MS
	for (;;) {
		try {
			const raw = JSON.parse(readFileSync(configPath, "utf-8")) as Record<string, unknown>
			const matches = Object.entries(expected).every(([key, value]) => raw[key] === value)
			if (matches && raw.region !== undefined) return
		} catch {
			// config not written yet
		}
		if (Date.now() > deadline) {
			throw new Error(`Timed out waiting for config.json ${JSON.stringify(expected)}`)
		}
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
}

test("login via Kimchi account offers Self-hosted behind the experimental flag and persists region + base URL", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "login-self-hosted",
			responses: [],
			// Self-hosted is gated behind the experimental flag like eu.
			extraArgs: ["--enable-experimental-features"],
		},
		async (fixture, trace) => {
			terminal.write("/login")
			await waitForText(terminal, "/login", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("")
			await waitForText(terminal, "Use a Kimchi account", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("")
			trace.step("auth-method selector confirmed")

			// Region selector: US (current) first, Europe, then Self-hosted.
			await waitForText(terminal, "Select region:", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "United States \u2014 current", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "Self-hosted", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("region selector lists Self-hosted")
			terminal.keyDown(2)
			terminal.submit("")

			// The base URL prompt appears before the browser flow starts.
			await waitForText(terminal, "Self-hosted Kimchi base URL:", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("base URL prompt visible")
			terminal.submit(SELF_HOSTED_BASE)

			// The browser flow must target the self-hosted web app (the base URL
			// itself, /cli-auth appended).
			await waitForText(terminal, `${SELF_HOSTED_BASE}/cli-auth`, { timeoutMs: STREAM_TIMEOUT_MS, full: true })
			trace.step("browser login URL points at the self-hosted web app")

			// Deliver the OAuth token directly to the local callback server (what
			// the browser would do after the self-hosted web app redirects back).
			const { port, state } = browserLoginUrl(terminal)
			const callback = await fetch(`http://127.0.0.1:${port}/callback?state=${state}&token=fake`)
			expect(callback.status).toBe(200)

			// The chosen region and the base URL are persisted next to the API key.
			const configPath = join(fixture.homeDir, ".config", "kimchi", "config.json")
			await waitForConfigField(configPath, { region: "self-hosted", selfHostedUrl: SELF_HOSTED_BASE })
			trace.step("config.json contains region self-hosted + selfHostedUrl")

			await waitForText(terminal, PROMPT_READY, { timeoutMs: STREAM_TIMEOUT_MS })
		},
	)
})
