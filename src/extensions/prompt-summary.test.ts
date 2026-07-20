import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "./__mocks__/context.js"
import promptSummaryExtension from "./prompt-summary.js"

type Handler = (event?: unknown, ctx?: unknown) => void | Promise<void>

function createPiHarness() {
	const handlers = new Map<string, Handler[]>()
	const sent: unknown[] = []
	return {
		pi: {
			on(event: string, handler: Handler) {
				const list = handlers.get(event) ?? []
				list.push(handler)
				handlers.set(event, list)
			},
			registerMessageRenderer() {},
			sendMessage(message: unknown) {
				sent.push(message)
			},
		} as unknown as ExtensionAPI,
		async emit(event: string, payload?: unknown, ctxOverride?: Record<string, unknown>) {
			const ctx = createContext(ctxOverride)
			for (const handler of handlers.get(event) ?? []) {
				await handler(payload, ctx)
			}
		},
		sent,
	}
}

/**
 * Harness variant that passes a `ctx` object as the second argument to
 * event handlers, matching how pi-coding-agent's ExtensionRunner.emit()
 * calls handlers. The ctx's `isIdle` is controllable for testing the
 * stale-ctx crash path.
 */
function createStaleCtxHarness() {
	const handlers = new Map<string, Array<(event?: unknown, ctx?: unknown) => void | Promise<void>>>()
	const sent: unknown[] = []
	const ctxOverrides: Record<string, unknown> = {}
	return {
		pi: {
			on(event: string, handler: (event?: unknown, ctx?: unknown) => void | Promise<void>) {
				const list = handlers.get(event) ?? []
				list.push(handler)
				handlers.set(event, list)
			},
			registerMessageRenderer() {},
			sendMessage(message: unknown) {
				sent.push(message)
			},
		} as unknown as ExtensionAPI,
		async emit(event: string, payload?: unknown, ctxOverride?: Record<string, unknown>) {
			const ctx = createContext({
				isIdle: vi.fn().mockReturnValue(false),
				...ctxOverrides,
				...ctxOverride,
			})
			for (const handler of handlers.get(event) ?? []) {
				await handler(payload, ctx)
			}
		},
		sent,
	}
}

describe("prompt summary Agent token accounting", () => {
	afterEach(() => {
		Reflect.deleteProperty(process.env, "KIMCHI_SUBAGENT")
		vi.useRealTimers()
	})

	it("adds deltas for repeated results from the same running Agent", async () => {
		const harness = createPiHarness()
		promptSummaryExtension(harness.pi)

		await harness.emit("agent_start", {})
		await harness.emit("tool_result", {
			toolName: "get_subagent_result",
			details: { agentId: "agent-1", tokenUsage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 1 } },
		})
		await harness.emit("tool_result", {
			toolName: "get_subagent_result",
			details: { agentId: "agent-1", tokenUsage: { input: 18, output: 9, cacheRead: 0, cacheWrite: 3 } },
		})
		await harness.emit("agent_end", {})
		await new Promise((resolve) => setTimeout(resolve, 0))

		const message = harness.sent[0] as { details: Record<string, unknown> }
		expect(message.details.subagents).toEqual({ input: 18, output: 9, cacheRead: 0, cacheWrite: 3 })
	})

	it("drops the optional summary when the extension context is stale", async () => {
		const harness = createPiHarness()
		promptSummaryExtension(harness.pi as never)
		const staleCtx = {
			isIdle: vi.fn(() => {
				throw new Error("This extension ctx is stale after session replacement or reload")
			}),
		}

		await harness.emit("agent_start")
		await harness.emit("tool_result", {
			toolName: "get_subagent_result",
			details: { agentId: "agent-1", tokenUsage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } },
		})
		await expect(harness.emit("agent_end", {}, staleCtx)).resolves.toBeUndefined()

		expect(staleCtx.isIdle).toHaveBeenCalledOnce()
		expect(harness.sent).toEqual([])
	})
})

describe("prompt summary stale-ctx crash prevention", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("does not crash when ctx.isIdle() throws stale-ctx error from setTimeout callback", async () => {
		const harness = createStaleCtxHarness()
		promptSummaryExtension(harness.pi)

		let isIdleCallCount = 0
		const staleError = new Error(
			"This extension ctx is stale after session replacement or reload. Do not use a captured pi or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload().",
		)
		const statefulIsIdle = () => {
			isIdleCallCount++
			if (isIdleCallCount === 1) return false // schedule setTimeout(trySend, 50)
			throw staleError // timer fires → ctx is now stale → throw
		}

		await harness.emit("agent_start")
		await harness.emit("message_end", {
			message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } },
		})
		await harness.emit("agent_end", {}, { isIdle: statefulIsIdle })

		vi.advanceTimersByTime(50)

		expect(harness.sent).toHaveLength(0)
		expect(isIdleCallCount).toBe(2)
	})

	it("drops a delayed summary when a newer agent turn starts", async () => {
		const harness = createStaleCtxHarness()
		promptSummaryExtension(harness.pi)
		const isIdle = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)

		await harness.emit("agent_start")
		await harness.emit("message_end", {
			message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } },
		})
		await harness.emit("agent_end", {}, { isIdle })
		await harness.emit("agent_start")
		await vi.advanceTimersByTimeAsync(50)

		expect(harness.sent).toHaveLength(0)
		expect(isIdle).toHaveBeenCalledOnce()
	})

	it("drops the summary when the agent stays busy past the polling budget", async () => {
		const harness = createStaleCtxHarness()
		promptSummaryExtension(harness.pi)

		await harness.emit("agent_start")
		await harness.emit("message_end", {
			message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } },
		})
		await harness.emit("agent_end", {}, { isIdle: () => false })
		await vi.runAllTimersAsync()

		expect(harness.sent).toHaveLength(0)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("silently bails when pi.sendMessage throws stale-ctx error (isIdle returned true)", async () => {
		const harness = createStaleCtxHarness()
		const staleError = new Error("This extension ctx is stale after session replacement or reload.")
		const piWithThrowingSend = {
			...harness.pi,
			sendMessage() {
				throw staleError
			},
		}
		promptSummaryExtension(piWithThrowingSend)

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		await harness.emit("agent_start")
		await harness.emit("message_end", {
			message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } },
		})
		await harness.emit("agent_end", {}, { isIdle: () => true })

		await vi.advanceTimersByTimeAsync(0)

		expect(harness.sent).toHaveLength(0)
		expect(errorSpy).not.toHaveBeenCalled()
		errorSpy.mockRestore()
	})

	it("logs non-stale errors to console.error", async () => {
		const harness = createStaleCtxHarness()
		const nonStaleError = new Error("something went wrong")
		const piWithThrowingSend = {
			...harness.pi,
			sendMessage() {
				throw nonStaleError
			},
		}
		promptSummaryExtension(piWithThrowingSend)

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		await harness.emit("agent_start")
		await harness.emit("message_end", {
			message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } },
		})
		await harness.emit("agent_end", {}, { isIdle: () => true })

		await vi.advanceTimersByTimeAsync(0)

		expect(errorSpy).toHaveBeenCalledWith("[prompt-summary] Failed to send:", nonStaleError)
		errorSpy.mockRestore()
	})

	it("polls until isIdle returns true, then sends the summary", async () => {
		vi.useRealTimers()
		const harness = createStaleCtxHarness()
		promptSummaryExtension(harness.pi)

		let idleCalls = 0
		await harness.emit("agent_start")
		await harness.emit("message_end", {
			message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } },
		})
		await harness.emit(
			"agent_end",
			{},
			{
				isIdle: () => {
					idleCalls++
					return idleCalls >= 3 // false twice, then true on third call
				},
			},
		)

		// Wait for polling to complete (2 retries × 50ms + buffer)
		await new Promise((resolve) => setTimeout(resolve, 200))

		expect(harness.sent).toHaveLength(1)
		expect(idleCalls).toBe(3)
		const message = harness.sent[0] as { customType: string }
		expect(message.customType).toBe("prompt-summary")
	})
})
