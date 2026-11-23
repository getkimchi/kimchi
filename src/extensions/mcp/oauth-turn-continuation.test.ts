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

	it("allows retry after an aborted execute returns an existing grant", async () => {
		const continuation = new McpOAuthTurnContinuation()
		const controller = new AbortController()

		await expect(
			continuation.runAuthStart("fixture", controller.signal, async () => {
				controller.abort(new Error("authentication setup cancelled"))
				return {
					content: [{ type: "text", text: "the grant is available" }],
					details: { mode: "auth-start", server: "fixture", authenticated: true },
				}
			}),
		).rejects.toThrow("authentication setup cancelled")

		const retry = await startAuthorization(continuation, true)
		expect(retry.details).toMatchObject({ authenticated: true })
		expect(retry.details).not.toMatchObject({ error: "oauth_already_pending" })
	})

	it("allows retry after an aborted execute rejects during setup", async () => {
		const continuation = new McpOAuthTurnContinuation()
		const controller = new AbortController()

		await expect(
			continuation.runAuthStart("fixture", controller.signal, async () => {
				controller.abort(new Error("authentication setup cancelled"))
				throw controller.signal.reason
			}),
		).rejects.toThrow("authentication setup cancelled")

		expect((await startAuthorization(continuation, true)).details).toMatchObject({ authenticated: true })
	})

	it("retains retry fencing for a registered watcher after cancellation", async () => {
		vi.useFakeTimers()
		const continuation = new McpOAuthTurnContinuation()
		const controller = new AbortController()
		const pending = continuation.runAuthStart("fixture", controller.signal, async () => ({
			content: [{ type: "text", text: "authorize in the browser" }],
			details: { mode: "auth-start", server: "fixture", authorizationUrl: "https://authorize.example" },
		}))
		await vi.advanceTimersByTimeAsync(0)
		controller.abort(new Error("authorization cancelled"))
		await expect(pending).rejects.toThrow("authorization cancelled")

		const retry = await startAuthorization(continuation, true)
		expect(retry.details).toMatchObject({ error: "oauth_already_pending" })
		expect(continuation.consumeStatusMessage(statusMessage("failed"))).toBe(true)
		expect((await startAuthorization(continuation, true)).details).toMatchObject({ authenticated: true })
	})

	it("returns a structured manual handoff independently of instruction wording", async () => {
		vi.useFakeTimers()
		const continuation = new McpOAuthTurnContinuation()
		const pending = continuation.runAuthStart("fixture", undefined, async () => ({
			content: [{ type: "text", text: "Instruction wording changed upstream." }],
			details: {
				mode: "auth-start",
				server: "fixture",
				authorizationUrl: "https://authorize.example",
				handoff: "manual",
			},
		}))
		await vi.advanceTimersByTimeAsync(0)
		let settled = false
		void pending.then(() => {
			settled = true
		})
		await Promise.resolve()
		expect(settled).toBe(true)
		await expect(pending).resolves.toMatchObject({ details: { handoff: "manual" } })
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
