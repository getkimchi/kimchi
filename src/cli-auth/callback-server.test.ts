import { describe, expect, it, vi } from "vitest"
import { generateState, startCallbackServer } from "./callback-server.js"

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
	async function request(port: number, path: string, opts?: { remoteAddress?: string }): Promise<Response> {
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
		expect(body).toContain("Authentication Successful")

		const result = await server.result
		expect(result.token).toBe("my-secret-token")
		expect(result.error).toBeUndefined()
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
