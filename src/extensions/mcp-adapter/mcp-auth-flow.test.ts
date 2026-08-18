import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

async function getFreePort(): Promise<number> {
	const server = createServer()
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
	const address = server.address()
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
	if (!address || typeof address === "string") throw new Error("Could not allocate a local test port")
	return address.port
}

async function expectPortCanBind(port: number): Promise<void> {
	const server = createServer()
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(port, "127.0.0.1", resolve)
	})
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
}

async function sendCallback(port: number, path: string, state: string, code: string): Promise<void> {
	const response = await fetch(`http://127.0.0.1:${port}${path}?code=${code}&state=${state}`)
	expect(response.ok).toBe(true)
}

async function loadAuthFlowForPort(port: number, options: { connectGate?: Promise<void> } = {}) {
	const authDir = mkdtempSync(join(tmpdir(), "kimchi-mcp-oauth-test-"))
	vi.resetModules()
	vi.stubEnv("MCP_OAUTH_CALLBACK_PORT", String(port))
	vi.stubEnv("MCP_OAUTH_DIR", authDir)
	const openBrowser = vi.fn(async () => {})
	const connectStarted = vi.fn()
	vi.doMock("open", () => ({ default: openBrowser }))

	vi.doMock("@modelcontextprotocol/sdk/client/auth.js", () => {
		class UnauthorizedError extends Error {}
		return { UnauthorizedError }
	})

	vi.doMock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => {
		class StreamableHTTPClientTransport {
			readonly authProvider?: { redirectToAuthorization?: (url: URL) => void | Promise<void> }

			constructor(
				_url: URL,
				options?: { authProvider?: { redirectToAuthorization?: (url: URL) => void | Promise<void> } },
			) {
				this.authProvider = options?.authProvider
			}

			async finishAuth(): Promise<void> {}

			async close(): Promise<void> {}
		}

		return { StreamableHTTPClientTransport }
	})

	vi.doMock("@modelcontextprotocol/sdk/client/index.js", async () => {
		const { UnauthorizedError } = await import("@modelcontextprotocol/sdk/client/auth.js")

		class Client {
			async connect(transport: { authProvider?: { redirectToAuthorization?: (url: URL) => void | Promise<void> } }) {
				connectStarted()
				await options.connectGate
				await transport.authProvider?.redirectToAuthorization?.(new URL("https://auth.example.test/authorize"))
				throw new UnauthorizedError("authorization required")
			}

			async close(): Promise<void> {}
		}

		return { Client }
	})

	const [flow, callbackServer, authStore, oauthProvider] = await Promise.all([
		import("./mcp-auth-flow.js"),
		import("./mcp-callback-server.js"),
		import("./mcp-auth.js"),
		import("./mcp-oauth-provider.js"),
	])

	return { authDir, authStore, callbackServer, connectStarted, flow, oauthProvider, openBrowser }
}

afterEach(() => {
	vi.unstubAllEnvs()
	vi.doUnmock("@modelcontextprotocol/sdk/client/auth.js")
	vi.doUnmock("@modelcontextprotocol/sdk/client/index.js")
	vi.doUnmock("@modelcontextprotocol/sdk/client/streamableHttp.js")
	vi.doUnmock("open")
})

describe("MCP OAuth callback lifecycle", () => {
	it("does not bind the callback port during idle initialization", async () => {
		const port = await getFreePort()
		const { authDir, callbackServer, flow } = await loadAuthFlowForPort(port)

		try {
			await flow.initializeOAuth()

			await expectPortCanBind(port)
			expect(callbackServer.isCallbackServerRunning()).toBe(false)
		} finally {
			await flow.shutdownOAuth()
			rmSync(authDir, { recursive: true, force: true })
		}
	})

	it("shares one callback listener across concurrent authentications and releases it after the last one", async () => {
		const port = await getFreePort()
		const { authDir, authStore, callbackServer, flow, oauthProvider, openBrowser } = await loadAuthFlowForPort(port)

		try {
			const first = flow.authenticate("first", "https://first.example.test/mcp")
			const second = flow.authenticate("second", "https://second.example.test/mcp")
			await vi.waitFor(() => expect(openBrowser).toHaveBeenCalledTimes(2))

			const firstState = await authStore.getOAuthState("first")
			if (!firstState) throw new Error("Missing first OAuth state")
			await sendCallback(port, oauthProvider.OAUTH_CALLBACK_PATH, firstState, "first-code")
			await expect(first).resolves.toBe("authenticated")
			expect(callbackServer.isCallbackServerRunning()).toBe(true)

			const secondState = await authStore.getOAuthState("second")
			if (!secondState) throw new Error("Missing second OAuth state")
			await sendCallback(port, oauthProvider.OAUTH_CALLBACK_PATH, secondState, "second-code")
			await expect(second).resolves.toBe("authenticated")
			expect(callbackServer.isCallbackServerRunning()).toBe(false)
			await expectPortCanBind(port)
		} finally {
			await flow.shutdownOAuth()
			rmSync(authDir, { recursive: true, force: true })
		}
	})

	it("waits for an in-progress close before starting a new authentication", async () => {
		const port = await getFreePort()
		const { authDir, authStore, callbackServer, flow, oauthProvider, openBrowser } = await loadAuthFlowForPort(port)

		try {
			await callbackServer.ensureCallbackServer({ strictPort: true })
			const stopping = callbackServer.stopCallbackServer()
			const authenticating = flow.authenticate("rovo", "https://rovo.example.test/mcp")

			await stopping
			await vi.waitFor(() => expect(openBrowser).toHaveBeenCalledOnce())
			expect(callbackServer.isCallbackServerRunning()).toBe(true)

			const state = await authStore.getOAuthState("rovo")
			if (!state) throw new Error("Missing Rovo OAuth state")
			await sendCallback(port, oauthProvider.OAUTH_CALLBACK_PATH, state, "rovo-code")
			await expect(authenticating).resolves.toBe("authenticated")
			expect(callbackServer.isCallbackServerRunning()).toBe(false)
		} finally {
			await flow.shutdownOAuth()
			rmSync(authDir, { recursive: true, force: true })
		}
	})

	it("cancels authentication when shutdown follows callback server startup", async () => {
		const port = await getFreePort()
		let resumeConnect = () => {}
		const connectGate = new Promise<void>((resolve) => {
			resumeConnect = resolve
		})
		const { authDir, callbackServer, connectStarted, flow } = await loadAuthFlowForPort(port, { connectGate })
		const authenticating = flow.authenticate("rovo", "https://rovo.example.test/mcp")

		try {
			await vi.waitFor(() => expect(connectStarted).toHaveBeenCalledOnce())
			expect(callbackServer.isCallbackServerRunning()).toBe(true)

			await flow.shutdownOAuth()
			resumeConnect()

			const outcome = await Promise.race([
				authenticating.then(
					() => "authenticated",
					(error: unknown) => (error instanceof Error ? error.message : String(error)),
				),
				new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), 1_000)),
			])
			expect(outcome).toBe("OAuth callback server stopped")
			expect(callbackServer.isCallbackServerRunning()).toBe(false)
		} finally {
			resumeConnect()
			await flow.shutdownOAuth()
			await authenticating.catch(() => {})
			rmSync(authDir, { recursive: true, force: true })
		}
	})

	it("releases callback ownership when the browser cannot open", async () => {
		const port = await getFreePort()
		const { authDir, callbackServer, flow, openBrowser } = await loadAuthFlowForPort(port)
		openBrowser.mockRejectedValueOnce(new Error("browser unavailable"))

		try {
			await expect(flow.authenticate("rovo", "https://rovo.example.test/mcp")).rejects.toThrow("Could not open browser")
			expect(callbackServer.isCallbackServerRunning()).toBe(false)
			await expectPortCanBind(port)
		} finally {
			await flow.shutdownOAuth()
			rmSync(authDir, { recursive: true, force: true })
		}
	})
})
