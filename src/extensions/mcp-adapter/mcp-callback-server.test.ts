/**
 * Tests for the OAuth callback page served to the browser after an MCP server
 * (Rovo, Slack, …) redirects back to the local listener.
 *
 * The page is rendered by the shared Kimchi-branded renderer in
 * `src/utils/oauth-page.ts` using the templates in resources/oauth/
 * (addressed via KIMCHI_OAUTH_TEMPLATE_DIR). Without that env var the callback
 * server must fall back to a minimal *unbranded* page — never a Pi-branded one.
 */
import { createServer } from "node:http"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it, vi } from "vitest"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

// The Kimchi logo SVG in both templates uses this exact orange — proof the
// branded template rendered rather than the unbranded fallback.
const KIMCHI_LOGO_ORANGE = "#FF521D"

async function getFreePort(): Promise<number> {
	const server = createServer()
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const address = server.address()
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
	if (!address || typeof address === "string") throw new Error("Could not allocate a local test port")
	return address.port
}

async function loadCallbackServerForPort(port: number) {
	vi.resetModules()
	vi.stubEnv("MCP_OAUTH_CALLBACK_PORT", String(port))
	return import("./mcp-callback-server.js")
}

afterEach(() => {
	vi.unstubAllEnvs()
})

describe("MCP OAuth callback page", () => {
	it("serves the branded authorization-success page after the provider redirects back", async () => {
		const port = await getFreePort()
		vi.stubEnv("KIMCHI_OAUTH_TEMPLATE_DIR", resolve(repoRoot, "resources", "oauth"))
		const callbackServer = await loadCallbackServerForPort(port)

		try {
			const { callbackPromise } = await callbackServer.prepareCallback("state-success")

			const response = await fetch(`http://127.0.0.1:${port}/mcp/oauth/callback?code=test-code&state=state-success`)
			const body = await response.text()

			expect(response.status).toBe(200)
			expect(response.headers.get("content-type")).toBe("text/html")
			await expect(callbackPromise).resolves.toBe("test-code")
			expect(body).toContain("bg-svg")
			expect(body).toContain(KIMCHI_LOGO_ORANGE)
			expect(body).toContain("<title>MCP Authorization Successful</title>")
			expect(body).toContain("<h1>MCP Authorization Successful</h1>")
			expect(body).toContain("You can close this window and return to Kimchi.")
			expect(body).not.toContain("Pi -")
		} finally {
			await callbackServer.stopCallbackServer()
		}
	})

	it("serves the branded authorization-failure page when the provider reports an error", async () => {
		const port = await getFreePort()
		vi.stubEnv("KIMCHI_OAUTH_TEMPLATE_DIR", resolve(repoRoot, "resources", "oauth"))
		const callbackServer = await loadCallbackServerForPort(port)

		try {
			const { callbackPromise } = await callbackServer.prepareCallback("state-error")
			// Attach the rejection assertion before the fetch: the server rejects the
			// pending auth in a deferred setTimeout after sending the response.
			const rejection = expect(callbackPromise).rejects.toThrow("The user denied the authorization request")

			const response = await fetch(
				`http://127.0.0.1:${port}/mcp/oauth/callback?error=access_denied&error_description=The%20user%20denied%20the%20authorization%20request&state=state-error`,
			)
			const body = await response.text()

			expect(response.status).toBe(200)
			await rejection
			expect(body).toContain("bg-svg")
			expect(body).toContain(KIMCHI_LOGO_ORANGE)
			expect(body).toContain("<title>MCP Authorization Failed</title>")
			expect(body).toContain("<h1>MCP Authorization Failed</h1>")
			expect(body).toContain("An error occurred during MCP authorization.")
			expect(body).toContain("The user denied the authorization request")
			expect(body).not.toContain("Pi -")
		} finally {
			await callbackServer.stopCallbackServer()
		}
	})

	it("rejects the pending auth when the callback has a state but no authorization code", async () => {
		const port = await getFreePort()
		const callbackServer = await loadCallbackServerForPort(port)

		try {
			const { callbackPromise } = await callbackServer.prepareCallback("state-no-code")
			// Fail fast instead of waiting for the 5-minute callback timeout.
			const rejection = expect(callbackPromise).rejects.toThrow("No authorization code provided")

			const response = await fetch(`http://127.0.0.1:${port}/mcp/oauth/callback?state=state-no-code`)
			const body = await response.text()

			expect(response.status).toBe(400)
			expect(body).toContain("<title>MCP Authorization Failed</title>")
			await rejection
		} finally {
			await callbackServer.stopCallbackServer()
		}
	})

	it("HTML-escapes provider-controlled error text", async () => {
		const port = await getFreePort()
		vi.stubEnv("KIMCHI_OAUTH_TEMPLATE_DIR", resolve(repoRoot, "resources", "oauth"))
		const callbackServer = await loadCallbackServerForPort(port)

		try {
			const { callbackPromise } = await callbackServer.prepareCallback("state-xss")
			const rejection = expect(callbackPromise).rejects.toThrow("alert(1)")

			const response = await fetch(
				`http://127.0.0.1:${port}/mcp/oauth/callback?error=access_denied&error_description=%3Cscript%3Ealert(1)%3C/script%3E&state=state-xss`,
			)
			const body = await response.text()

			expect(response.status).toBe(200)
			await rejection
			expect(body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;")
			expect(body).not.toContain("<script>alert(1)</script>")
		} finally {
			await callbackServer.stopCallbackServer()
		}
	})

	it("falls back to a minimal unbranded page when KIMCHI_OAUTH_TEMPLATE_DIR is unset", async () => {
		const port = await getFreePort()
		vi.stubEnv("KIMCHI_OAUTH_TEMPLATE_DIR", "")
		const callbackServer = await loadCallbackServerForPort(port)

		try {
			const { callbackPromise } = await callbackServer.prepareCallback("state-fallback")

			const response = await fetch(`http://127.0.0.1:${port}/mcp/oauth/callback?code=test-code&state=state-fallback`)
			const body = await response.text()

			expect(response.status).toBe(200)
			await expect(callbackPromise).resolves.toBe("test-code")
			expect(body).toContain("<title>MCP Authorization Successful</title>")
			expect(body).not.toContain("bg-svg")
			expect(body).not.toContain(KIMCHI_LOGO_ORANGE)
			expect(body).not.toContain("Pi -")
		} finally {
			await callbackServer.stopCallbackServer()
		}
	})
})
