import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { fullText, INPUT_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * Extract the browser-login callback coordinates from the terminal buffer.
 * The URL is printed as one OSC-8 link whose visible text wraps across rows,
 * so whitespace must be normalized away before matching. The buffer also holds
 * the truncated `Kimchi login: <url>` status line copy of the same URL, so the
 * state's full 64-hex-char length is pinned to only match a complete URL and
 * never the truncated prefix.
 */
function browserLoginUrl(terminal: Parameters<typeof fullText>[0]): { port: number; state: string } {
	const text = fullText(terminal).replace(/\s+/g, "")
	const match = /callback=http%3A%2F%2F127\.0\.0\.1%3A(\d+)%2Fcallback&state=([0-9a-f]{64})/.exec(text)
	if (!match) throw new Error("browser-login URL not found in terminal output")
	return { port: Number(match[1]), state: match[2] }
}

async function waitForConfigRegion(configPath: string, region: string): Promise<void> {
	const deadline = Date.now() + STREAM_TIMEOUT_MS
	for (;;) {
		try {
			const raw = JSON.parse(readFileSync(configPath, "utf-8")) as { region?: string }
			if (raw.region === region) return
		} catch {
			// config not written yet
		}
		if (Date.now() > deadline) {
			throw new Error(`Timed out waiting for config.json region "${region}"`)
		}
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
}

test("login via Kimchi account offers a region selector and persists the chosen region", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "login-region",
			responses: [],
		},
		async (fixture, trace) => {
			terminal.write("/login")
			await waitForText(terminal, "/login", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("")
			await waitForText(terminal, "Use a Kimchi account", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("")
			trace.step("auth-method selector confirmed")

			// Region selector: the current region (US) first, Europe one row down.
			await waitForText(terminal, "Select region:", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "United States \u2014 current", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "Europe", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("region selector visible")
			terminal.keyDown(1)
			terminal.submit("")

			// The browser flow must target the EU web app.
			await waitForText(terminal, "app.eu.kimchi.dev", { timeoutMs: STREAM_TIMEOUT_MS, full: true })
			trace.step("browser login URL points at the EU web app")

			// Deliver the OAuth token directly to the local callback server (what
			// the browser would do after the EU web app redirects back).
			const { port, state } = browserLoginUrl(terminal)
			const callback = await fetch(`http://127.0.0.1:${port}/callback?state=${state}&token=fake`)
			expect(callback.status).toBe(200)

			// The chosen region is persisted next to the API key.
			await waitForConfigRegion(join(fixture.homeDir, ".config", "kimchi", "config.json"), "eu")
			trace.step("config.json contains region eu")

			await waitForText(terminal, PROMPT_READY, { timeoutMs: STREAM_TIMEOUT_MS })
		},
	)
})
