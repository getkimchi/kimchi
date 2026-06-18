import { randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * The patched `before_provider_headers` extension hook lets extensions add
 * per-request headers to every LLM call. This test loads a throwaway extension
 * via `--extension`, sends one prompt, and asserts the custom headers land on
 * the HTTP request the fake OpenAI server records.
 *
 * Header names are lower-cased by Node's HTTP server, so we look up
 * `x-kimchi-tui-test-marker`. Telemetry's own `X-Session-Id`/`X-Turn-Index`
 * are not asserted — they're an unrelated always-on extension that should not
 * make this test brittle.
 */
test("extension before_provider_headers hook injects custom headers into LLM requests", async ({ terminal }) => {
	const marker = randomUUID()
	const fixtureRoot = process.env.TMPDIR ?? "/tmp"
	const extensionPath = join(fixtureRoot, `kimchi-tui-headers-${marker}.js`)

	writeFileSync(
		extensionPath,
		// jiti-loader reads this as a CommonJS-compatible module; `module.exports`
		// is the extension factory the runtime expects.
		`module.exports = function (pi) {
\tpi.on("before_provider_headers", function (event) {
\t\treturn Object.assign({}, event.headers, {
\t\t\t"X-Kimchi-Tui-Test-Marker": ${JSON.stringify(marker)},
\t\t});
\t});
};
`,
		"utf-8",
	)

	try {
		await runKimchiSession(
			terminal,
			{
				artifactName: "extension-custom-headers",
				responses: [{ stream: ["Hello", " from", " fake", " Kimchi."] }],
				extraArgs: ["--extension", extensionPath],
			},
			async (fixture, trace) => {
				terminal.submit("Say hello")
				trace.step("submitted prompt")

				await expect(terminal.getByText("Hello from fake Kimchi.", { full: true })).toBeVisible()
				trace.step("response rendered")

				const chatRequests = fixture.fake.requests.filter((request) =>
					request.url.startsWith("/openai/v1/chat/completions"),
				)
				expect(chatRequests.length).toBeGreaterThan(0)

				// Header lookup is case-insensitive on the receiving side; Node lower-cases all
				// incoming header names, so we mirror that here instead of asserting the original case.
				const headerValue = chatRequests[0].headers["x-kimchi-tui-test-marker"]
				expect(headerValue).toBe(marker)
			},
		)
	} finally {
		// Best-effort cleanup; the file lives in the OS temp dir and won't accumulate.
		try {
			const { unlinkSync } = await import("node:fs")
			unlinkSync(extensionPath)
		} catch {
			// ignore — cleanup is best-effort
		}
	}
})
