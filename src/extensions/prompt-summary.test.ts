import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import promptSummaryExtension from "./prompt-summary.js"

type Handler = (event?: unknown) => void | Promise<void>

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
		},
		async emit(event: string, payload?: unknown) {
			for (const handler of handlers.get(event) ?? []) {
				await handler(payload)
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
		},
		async emit(event: string, payload?: unknown, ctxOverride?: Record<string, unknown>) {
			const ctx = {
				isIdle: () => false,
				...ctxOverrides,
				...ctxOverride,
			}
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
		promptSummaryExtension(harness.pi as never)

		await harness.emit("agent_start")
		await harness.emit("tool_result", {
			toolName: "get_subagent_result",
			details: { agentId: "agent-1", tokenUsage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 1 } },
		})
		await harness.emit("tool_result", {
			toolName: "get_subagent_result",
			details: { agentId: "agent-1", tokenUsage: { input: 18, output: 9, cacheRead: 0, cacheWrite: 3 } },
		})
		await harness.emit("agent_end")
		await new Promise((resolve) => setTimeout(resolve, 0))

		const message = harness.sent[0] as {
			details: { subagents: { input: number; output: number; cacheRead: number; cacheWrite: number } }
		}
		expect(message.details.subagents).toEqual({ input: 18, output: 9, cacheRead: 0, cacheWrite: 3 })
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
		promptSummaryExtension(harness.pi as never)

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

	it("silently bails when pi.sendMessage throws stale-ctx error (isIdle returned true)", async () => {
		const harness = createStaleCtxHarness()
		const staleError = new Error("This extension ctx is stale after session replacement or reload.")
		const piWithThrowingSend = {
			...harness.pi,
			sendMessage() {
				throw staleError
			},
		}
		promptSummaryExtension(piWithThrowingSend as never)

		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

		await harness.emit("agent_start")
		await harness.emit("message_end", {
			message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } },
		})
		await harness.emit("agent_end")

		await vi.advanceTimersByTimeAsync(0)

		expect(harness.sent).toHaveLength(0)
		expect(errorSpy).not.toHaveBeenCalled()
		errorSpy.mockRestore()
	})
})
