/**
 * Manual preview of the OAuth callback page shown in the browser after an MCP
 * server (Rovo, Slack, …) redirects back to the local listener.
 *
 * Disabled by default. Run explicitly with:
 *
 *   KIMCHI_SHOW_OAUTH_PAGE=1 pnpm vitest run src/extensions/mcp-adapter/mcp-callback-server.preview.test.ts
 *
 * The test starts the real callback server and prints the URLs to open in a
 * browser. It stays up until the success URL is visited (or the 5-minute
 * callback timeout from mcp-callback-server.ts elapses).
 */
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"

// Mirrors DEFAULT_OAUTH_CALLBACK_PORT in mcp-oauth-provider.ts. When the port
// is busy the callback server scans forward, so always use the printed URL.
const PREVIEW_PORT = 19876

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

afterEach(() => {
	vi.unstubAllEnvs()
})

describe("MCP OAuth callback page preview", () => {
	it.runIf(process.env.KIMCHI_SHOW_OAUTH_PAGE === "1")(
		"serves the callback page for manual browser inspection",
		async () => {
			vi.resetModules()
			vi.stubEnv("MCP_OAUTH_CALLBACK_PORT", String(PREVIEW_PORT))
			vi.stubEnv("KIMCHI_OAUTH_TEMPLATE_DIR", resolve(repoRoot, "resources", "oauth"))
			const callbackServer = await import("./mcp-callback-server.js")
			const { getOAuthCallbackPort, OAUTH_CALLBACK_PATH } = await import("./mcp-oauth-provider.js")

			try {
				const { callbackPromise } = await callbackServer.prepareCallback("demo-state")
				const base = `http://127.0.0.1:${getOAuthCallbackPort()}${OAUTH_CALLBACK_PATH}`

				console.log("\n  Open in your browser to view the callback pages:")
				console.log(`    success: ${base}?code=demo-code&state=demo-state`)
				console.log(
					`    error:   ${base}?error=access_denied&error_description=The+user+denied+the+request&state=anything`,
				)
				console.log("  The server shuts down once the success URL is visited (5-minute timeout otherwise).\n")

				const code = await callbackPromise
				console.log(`  Received authorization code "${code}" — callback flow completed.`)
				expect(code).toBe("demo-code")
			} finally {
				await callbackServer.stopCallbackServer()
			}
		},
		6 * 60 * 1000,
	)
})
