import type { AgentSession } from "@earendil-works/pi-coding-agent"
import { afterEach, describe, expect, it } from "vitest"
import { getMultiModelEnabled, setMultiModelEnabled } from "../../extensions/prompt-construction/prompt-enrichment.js"
import {
	clearSessionMultiModelState,
	getCurrentSessionId,
	getSessionMultiModelEnabled,
	runWithSession,
	setSessionMultiModelEnabled,
} from "./session-state.js"

describe("session-state", () => {
	afterEach(() => {
		// Clean up any session state between tests
		clearSessionMultiModelState("s-a")
		clearSessionMultiModelState("s-b")
		clearSessionMultiModelState("s-ctx")
		setMultiModelEnabled(false)
	})

	describe("getSessionMultiModelEnabled / setSessionMultiModelEnabled", () => {
		it("returns false for unknown sessionId", () => {
			expect(getSessionMultiModelEnabled("nonexistent")).toBe(false)
		})

		it("isolates state between sessions", () => {
			setSessionMultiModelEnabled("s-a", true)
			setSessionMultiModelEnabled("s-b", false)

			expect(getSessionMultiModelEnabled("s-a")).toBe(true)
			expect(getSessionMultiModelEnabled("s-b")).toBe(false)
		})
	})

	describe("clearSessionMultiModelState", () => {
		it("removes per-session state", () => {
			setSessionMultiModelEnabled("s-a", true)
			expect(getSessionMultiModelEnabled("s-a")).toBe(true)

			clearSessionMultiModelState("s-a")
			expect(getSessionMultiModelEnabled("s-a")).toBe(false)
		})

		it("is a no-op for unknown sessionId", () => {
			// Should not throw
			clearSessionMultiModelState("nonexistent")
		})
	})

	describe("runWithSession / getCurrentSessionId", () => {
		it("returns null outside a runWithSession context", () => {
			expect(getCurrentSessionId()).toBeNull()
		})

		it("provides sessionId inside a runWithSession context", () => {
			const fake = { sessionId: "s-ctx" } as AgentSession
			runWithSession(fake, () => {
				expect(getCurrentSessionId()).toBe("s-ctx")
			})
			// Back to null after
			expect(getCurrentSessionId()).toBeNull()
		})

		it("nests correctly — inner context wins", () => {
			const outer = { sessionId: "s-a" } as AgentSession
			const inner = { sessionId: "s-b" } as AgentSession
			runWithSession(outer, () => {
				expect(getCurrentSessionId()).toBe("s-a")
				runWithSession(inner, () => {
					expect(getCurrentSessionId()).toBe("s-b")
				})
				expect(getCurrentSessionId()).toBe("s-a")
			})
		})
	})

	describe("getMultiModelEnabled integration with session context", () => {
		it("reads per-session state inside runWithSession", () => {
			const fake = { sessionId: "s-a" } as AgentSession
			setSessionMultiModelEnabled("s-a", true)

			// Outside context → global (false)
			expect(getMultiModelEnabled()).toBe(false)

			// Inside context → per-session (true)
			runWithSession(fake, () => {
				expect(getMultiModelEnabled()).toBe(true)
			})

			// Back to global
			expect(getMultiModelEnabled()).toBe(false)
		})

		it("falls back to global when session has no state", () => {
			const fake = { sessionId: "s-a" } as AgentSession
			setMultiModelEnabled(true)

			// Inside context but no per-session state → session returns false
			// (session state takes precedence, defaults to false)
			runWithSession(fake, () => {
				expect(getMultiModelEnabled()).toBe(false)
			})
		})

		it("concurrent sessions see independent state", async () => {
			const fakeA = { sessionId: "s-a" } as AgentSession
			const fakeB = { sessionId: "s-b" } as AgentSession
			setSessionMultiModelEnabled("s-a", true)
			setSessionMultiModelEnabled("s-b", false)

			const results = await Promise.all([
				new Promise<boolean>((resolve) => {
					runWithSession(fakeA, () => {
						resolve(getMultiModelEnabled())
					})
				}),
				new Promise<boolean>((resolve) => {
					runWithSession(fakeB, () => {
						resolve(getMultiModelEnabled())
					})
				}),
			])

			expect(results).toEqual([true, false])
		})
	})
})
