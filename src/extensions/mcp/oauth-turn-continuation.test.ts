import { afterEach, describe, expect, it, vi } from "vitest"
import { McpOAuthTurnContinuation } from "./oauth-turn-continuation.js"

describe("McpOAuthTurnContinuation credential recovery", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("settles a new persisted grant when the adapter drops its terminal status after cleanup", async () => {
		vi.useFakeTimers()
		let persisted = false
		const continuation = new McpOAuthTurnContinuation(() => persisted)
		const pending = continuation.runAuthStart("fixture", undefined, async () => ({
			content: [{ type: "text", text: "authorize in the browser" }],
			details: { mode: "auth-start", server: "fixture", authorizationUrl: "https://authorize.example" },
		}))
		await vi.advanceTimersByTimeAsync(0)

		// This models authenticate() persisting the grant, then manager.close()
		// rejecting so the watcher removes itself without emitting any status.
		persisted = true
		await vi.advanceTimersByTimeAsync(100)
		const outcome = await pending
		expect(outcome).toMatchObject({
			details: { authenticated: true },
			isError: false,
		})
		expect(outcome.content).toEqual([{ type: "text", text: 'OAuth authentication successful for "fixture".' }])

		const next = await continuation.runAuthStart("fixture", undefined, async () => ({
			content: [{ type: "text", text: "the grant is available" }],
			details: { mode: "auth-start", server: "fixture", authenticated: true },
		}))
		expect(next.details).toMatchObject({ authenticated: true })
		expect(next.isError).not.toBe(true)

		// If cleanup was merely slow rather than failed, its eventual status
		// must not escape with triggerTurn and start a duplicate ACP run.
		expect(
			continuation.consumeStatusMessage({
				customType: "mcp-oauth-status",
				content: "OAuth authentication completed",
				display: false,
				details: { server: "fixture", status: "authenticated" },
			}),
		).toBe(true)
	})
})
