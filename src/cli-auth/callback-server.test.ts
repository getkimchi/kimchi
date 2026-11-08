import { createServer } from "node:http"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it, vi } from "vitest"
import { generateState, startCallbackServer } from "./callback-server.js"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..")

describe("generateState", () => {
	it("produces a 64-character hex string", () => {
		const state = generateState()
		expect(state).toMatch(/^[0-9a-f]{64}$/)
	})

	it("produces unique values on successive calls", () => {
		const a = generateState()
		const b = generateState()
		expect(a).not.toBe(b)
	})
})

describe("startCallbackServer", () => {
	async function request(port: number, path: string): Promise<Response> {
		const url = `http://127.0.0.1:${port}${path}`
		const res = await fetch(url, { signal: AbortSignal.timeout(1000) })
		return res
	}

	it("binds to an ephemeral localhost port", async () => {
		const state = generateState()
		const server = await startCallbackServer(state)
		expect(server.port).toBeGreaterThan(0)
		expect(server.url).toBe(`http://127.0.0.1:${server.port}/callback`)
		server.close()
	})

	it("resolves with the token on a valid callback", async () => {
		const state = generateState()
		const server = await startCallbackServer(state)

		// Simulate the browser hitting the callback
		const res = await request(server.port, `/callback?token=my-secret-token&state=${state}`)
		expect(res.status).toBe(200)
		const body = await res.text()
		expect(body).toContain("Authentication successful")

		const result = await server.result
		expect(result.token).toBe("my-secret-token")
		expect(result.error).toBeUndefined()
		server.close()
	})

	it("serves the branded success template when KIMCHI_OAUTH_TEMPLATE_DIR is set", async () => {
		const previous = process.env.KIMCHI_OAUTH_TEMPLATE_DIR
		process.env.KIMCHI_OAUTH_TEMPLATE_DIR = resolve(repoRoot, "resources", "oauth")
		try {
			const state = generateState()
			const server = await startCallbackServer(state)
			const res = await request(server.port, `/callback?token=t&state=${state}`)
			const body = await res.text()
			// `bg-svg` / `class="dark"` exist only in resources/oauth/success.html, never
			// in the minimal unbranded fallback, so this proves the Kimchi-account
			// callback now shares the same branded pages as pi's subscription logins,
			// with {{MESSAGE}} substituted.
			expect(body).toContain("bg-svg")
			expect(body).toContain("Your CLI is now connected")
			await server.result
			server.close()
		} finally {
			if (previous === undefined) {
				delete process.env.KIMCHI_OAUTH_TEMPLATE_DIR
			} else {
				process.env.KIMCHI_OAUTH_TEMPLATE_DIR = previous
			}
		}
	})

	it("serves caller-provided success copy instead of the default CLI message", async () => {
		const state = generateState()
		// ACP authenticate() passes copy that doesn't assume the terminal CLI;
		// the terminal default must stay untouched.
		const server = await startCallbackServer(state, {
			successMessage: "You are now connected to Kimchi. You can close this window and start using it.",
		})

		const res = await request(server.port, `/callback?token=t&state=${state}`)
		const body = await res.text()
		expect(body).toContain("You are now connected to Kimchi")
		// The terminal-initiated copy must not leak into the ACP-initiated page.
		expect(body).not.toContain("Your CLI is now connected")

		await server.result
		server.close()
	})

	it("rejects an invalid state parameter", async () => {
		const state = generateState()
		const server = await startCallbackServer(state)

		const res = await request(server.port, "/callback?token=bad&state=wrong-state")
		expect(res.status).toBe(400)
		const body = await res.text()
		expect(body).toContain("Login error")

		const result = await server.result
		expect(result.error).toMatch(/try logging in again/)
		server.close()
	})

	it("rejects a missing state parameter", async () => {
		const state = generateState()
		const server = await startCallbackServer(state)

		const res = await request(server.port, "/callback?token=bad")
		expect(res.status).toBe(400)
		const body = await res.text()
		expect(body).toContain("Login error")

		const result = await server.result
		expect(result.error).toMatch(/try logging in again/)
	})

	it("handles error callbacks", async () => {
		const state = generateState()
		const server = await startCallbackServer(state)

		const res = await request(server.port, `/callback?error=access_denied&error_description=User+denied&state=${state}`)
		expect(res.status).toBe(200)
		const body = await res.text()
		expect(body).toContain("Authentication failed")

		const result = await server.result
		expect(result.error).toBe("User denied")
		server.close()
	})

	it("handles missing token", async () => {
		const state = generateState()
		const server = await startCallbackServer(state)

		const res = await request(server.port, `/callback?state=${state}&success=1`)
		expect(res.status).toBe(400)
		const body = await res.text()
		expect(body).toContain("Missing token")

		const result = await server.result
		expect(result.error).toMatch(/No token/)
		server.close()
	})

	it("returns 404 for non-callback paths", async () => {
		const state = generateState()
		const server = await startCallbackServer(state)

		const res = await request(server.port, `/something-else?state=${state}`)
		expect(res.status).toBe(404)

		server.close()
	})

	it("advertises localhost for OAuth-code flows and binds ::1 as well as 127.0.0.1", async () => {
		const state = generateState()
		const server = await startCallbackServer(state, { mode: "code" })
		expect(server.url).toBe(`http://localhost:${server.port}/callback`)

		// The dual-stack hijack regression: a browser resolving localhost to ::1
		// must reach the same callback handler, not whatever else squats on the
		// port. Skips silently on hosts with no IPv6 loopback.
		try {
			const res = await fetch(`http://[::1]:${server.port}/callback?code=V6&state=${state}`, {
				signal: AbortSignal.timeout(2000),
			})
			expect(res.status).toBe(200)
			expect((await server.result).code).toBe("V6")
		} catch (err) {
			// ECONNREFUSED on ::1 → host has no IPv6 loopback; v4-only is correct there.
			const code = ((err as NodeJS.ErrnoException).cause as NodeJS.ErrnoException | undefined)?.code
			if (code !== "ECONNREFUSED") throw err
			server.close()
		}
	})

	it("fails loudly with the port-in-use message when another process holds ::1 on the fixed port", async () => {
		// Reproduces the production hijack: something else (an MCP browser helper,
		// a stale login) is already listening on the registered loopback port
		// *only* on ::1 — previously invisible to the IPv4-only bind, and the
		// browser-sent code silently 404'd on the foreign server. Now the login
		// must fail at startup with the actionable message.
		const squatter = createServer()
		await new Promise<void>((res) => squatter.listen(0, "::1", res))
		const squatterAddr = squatter.address()
		if (!squatterAddr || typeof squatterAddr === "string") {
			squatter.close()
			throw new Error("This host has no IPv6 loopback — test cannot run")
		}
		try {
			await expect(
				startCallbackServer(generateState(), { mode: "code", port: { kind: "fixed", value: squatterAddr.port } }),
			).rejects.toThrow(/in use/)
		} catch (err) {
			// Hosts without IPv6 loopback: the ::1 squat itself fails to bind on
			// some platforms — the expectation above then can't be meaningful.
			const code = (err as NodeJS.ErrnoException).code
			if (code !== "EADDRNOTAVAIL" && code !== "EAFNOSUPPORT") throw err
		} finally {
			squatter.close()
		}
	})

	it("times out after the configured duration", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true })
		const state = generateState()
		const server = await startCallbackServer(state)

		const resultPromise = server.result

		// Fast-forward past the timeout
		vi.advanceTimersByTime(5 * 60 * 1000 + 100)

		const result = await resultPromise
		expect(result.error).toMatch(/timed out/)

		server.close()
		vi.useRealTimers()
	})

	it("close() resolves the result with a cancellation error", async () => {
		const state = generateState()
		const server = await startCallbackServer(state)

		server.close()

		const result = await server.result
		expect(result.error).toMatch(/cancelled/i)
	})
})
