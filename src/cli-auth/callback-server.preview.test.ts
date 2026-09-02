/**
 * Manual preview of the branded OAuth callback pages shown in the browser
 * during Kimchi-account login (the same templates pi's subscription providers,
 * e.g. OpenAI Codex, serve via the patched pi-ai renderer).
 *
 * Disabled by default. Run explicitly with:
 *
 *   KIMCHI_SHOW_OAUTH_PAGE=1 pnpm vitest run src/cli-auth/callback-server.preview.test.ts
 *
 * Starts two real callback servers — one serving the success page, one the
 * error page — and prints the URLs to open in a browser. Each server closes
 * after its callback is visited; the test completes once the success URL has
 * been visited (or after the 5-minute callback timeout).
 *
 * Note: the success page has no auto-close script, so it stays open in the
 * browser for inspection.
 */
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"
import { generateState, startCallbackServer } from "./callback-server.js"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

afterEach(() => {
	vi.unstubAllEnvs()
})

describe("cli-auth OAuth callback page preview", () => {
	it.runIf(process.env.KIMCHI_SHOW_OAUTH_PAGE === "1")(
		"serves the branded callback pages for manual browser inspection",
		async () => {
			vi.stubEnv("KIMCHI_OAUTH_TEMPLATE_DIR", resolve(repoRoot, "resources", "oauth"))

			const successState = generateState()
			const errorState = generateState()
			const success = await startCallbackServer(successState)
			const error = await startCallbackServer(errorState)

			try {
				console.log("\n  Open in your browser to view the branded callback pages:")
				console.log(`    success: http://127.0.0.1:${success.port}/callback?token=demo-token&state=${successState}`)
				console.log(
					`    error:   http://127.0.0.1:${error.port}/callback?error=access_denied&error_description=The+user+denied+the+request&state=${errorState}`,
				)
				console.log("  Visit the error page first — each listener closes after serving its page once.")
				console.log("  The test completes once the success URL is visited (5-minute timeout otherwise).\n")

				const result = await success.result
				console.log(`  Received token "${result.token}" — callback flow completed.`)
				expect(result.token).toBe("demo-token")
			} finally {
				error.close()
				success.close()
			}
		},
		7 * 60 * 1000,
	)
})
