import { afterEach, describe, expect, it, vi } from "vitest"
import { McpOAuthTurnContinuation } from "./oauth-turn-continuation.js"

describe("McpOAuthTurnContinuation status correlation", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("settles from its own terminal watcher status", async () => {
		const continuation = new McpOAuthTurnContinuation()
		const pending = startAuthorization(continuation)
		expect(continuation.consumeStatusMessage(statusMessage("authenticated"))).toBe(true)
		await expect(pending).resolves.toMatchObject({ details: { authenticated: true }, isError: false })

		const next = await startAuthorization(continuation, true)
		expect(next.details).toMatchObject({ authenticated: true })
		expect(next.isError).not.toBe(true)
	})

	it("settles same-server sessions only from their own terminal watcher", async () => {
		vi.useFakeTimers()
		const first = new McpOAuthTurnContinuation()
		const second = new McpOAuthTurnContinuation()
		const firstPending = startAuthorization(first)
		const secondPending = startAuthorization(second)
		await vi.advanceTimersByTimeAsync(0)

		first.consumeStatusMessage(statusMessage("authenticated"))
		await expect(firstPending).resolves.toMatchObject({ details: { authenticated: true } })
		await vi.advanceTimersByTimeAsync(100)

		// Another session's completion cannot settle this flow, even for the
		// same server. Each per-session watcher must deliver its own outcome.
		let secondSettled = false
		void secondPending.then(() => {
			secondSettled = true
		})
		await Promise.resolve()
		expect(secondSettled).toBe(false)
		second.consumeStatusMessage(statusMessage("authenticated"))
		await expect(secondPending).resolves.toMatchObject({ details: { authenticated: true } })
	})
})

function startAuthorization(continuation: McpOAuthTurnContinuation, authenticated = false) {
	return continuation.runAuthStart("fixture", undefined, async () => ({
		content: [{ type: "text", text: authenticated ? "the grant is available" : "authorize in the browser" }],
		details: authenticated
			? { mode: "auth-start", server: "fixture", authenticated: true }
			: { mode: "auth-start", server: "fixture", authorizationUrl: "https://authorize.example" },
	}))
}

function statusMessage(status: "authenticated" | "failed") {
	return {
		customType: "mcp-oauth-status",
		content: `OAuth authentication ${status}`,
		display: false,
		details: { server: "fixture", status },
	}
}
