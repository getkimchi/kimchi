import type { Model } from "@earendil-works/pi-ai"
import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent"
import type { Component } from "@earendil-works/pi-tui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "./__mocks__/context.js"
import promptSummaryExtension, { holdPromptSummary, promptSummaryRenderer } from "./prompt-summary.js"
import { clearAutoRoutingState, setAutoRoutingState } from "./router/state.js"

type Handler = (event?: unknown, ctx?: unknown) => void | Promise<void>

function createPiHarness() {
	const handlers = new Map<string, Handler[]>()
	const sent: unknown[] = []
	const renderers: Record<
		string,
		| ((message: unknown, options: unknown, theme: unknown) => { render(width: number): string[] } | undefined)
		| undefined
	> = {}
	return {
		pi: {
			on(event: string, handler: Handler) {
				const list = handlers.get(event) ?? []
				list.push(handler)
				handlers.set(event, list)
			},
			registerMessageRenderer(type: string, renderer: never) {
				renderers[type] = renderer
			},
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
		renderers,
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
		await new Promise((resolve) => setTimeout(resolve, 0))

		expect(staleCtx.isIdle).toHaveBeenCalledOnce()
		expect(harness.sent).toEqual([])
	})
})

describe("prompt summary auto-model row", () => {
	afterEach(() => {
		clearAutoRoutingState("test-session")
	})

	it("reports the auto-routed model like the status bar does", async () => {
		const harness = createPiHarness()
		promptSummaryExtension(harness.pi)

		setAutoRoutingState("test-session", {
			status: "resolved",
			model: { id: "glm-5.3", provider: "kimchi-dev", name: "GLM 5.3" } as Model<string>,
		})

		await harness.emit("agent_start")
		await harness.emit("message_end", {
			message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } },
		})
		await harness.emit("agent_end", {}, { model: { id: "auto", provider: "kimchi-dev" } })
		await new Promise((resolve) => setTimeout(resolve, 0))

		const message = harness.sent[0] as { details: { model?: string } }
		expect(message.details.model).toBe("auto (glm-5.3)")
	})

	it("omits the model row when Auto has not resolved a target yet", async () => {
		const harness = createPiHarness()
		promptSummaryExtension(harness.pi)

		setAutoRoutingState("test-session", { status: "unresolved" })

		await harness.emit("agent_start")
		await harness.emit("message_end", {
			message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } },
		})
		await harness.emit("agent_end", {}, { model: { id: "auto", provider: "kimchi-dev" } })
		await new Promise((resolve) => setTimeout(resolve, 0))

		const message = harness.sent[0] as { details: { model?: string } }
		expect(message.details.model).toBeUndefined()
	})

	it("omits the model row for concrete model selections", async () => {
		const harness = createPiHarness()
		promptSummaryExtension(harness.pi)

		await harness.emit("agent_start")
		await harness.emit("message_end", {
			message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } },
		})
		await harness.emit("agent_end", {}, { model: { id: "glm-5.3", provider: "kimchi-dev" } })
		await new Promise((resolve) => setTimeout(resolve, 0))

		const message = harness.sent[0] as { details: { model?: string } }
		expect(message.details.model).toBeUndefined()
	})

	it("renders the model row after the per-model breakdown rows in multi-row summaries", async () => {
		const harness = createPiHarness()
		promptSummaryExtension(harness.pi)

		setAutoRoutingState("test-session", {
			status: "resolved",
			model: { id: "kimi-k2.6", provider: "kimchi-dev", name: "Kimi K2.6" } as Model<string>,
		})

		await harness.emit("agent_start")
		await harness.emit("message_end", {
			message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } },
		})
		await harness.emit("tool_result", {
			toolName: "get_subagent_result",
			details: {
				agentId: "agent-1",
				tokenUsage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
				modelName: "glm-5.3",
			},
		})
		await harness.emit("agent_end", {}, { model: { id: "auto", provider: "kimchi-dev" } })
		await new Promise((resolve) => setTimeout(resolve, 0))

		const renderer = harness.renderers["prompt-summary"]
		expect(renderer).toBeDefined()
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text }
		const lines = renderer?.(harness.sent[0], {}, theme)?.render(120) ?? []

		const subagentRowIndex = lines.findIndex((line) => line.includes("↳ glm-5.3"))
		const modelRowIndex = lines.findIndex((line) => line.includes("auto (kimi-k2.6)"))
		expect(subagentRowIndex).toBeGreaterThanOrEqual(0)
		expect(modelRowIndex).toBeGreaterThan(subagentRowIndex)
		expect(lines[modelRowIndex]).toContain("model")
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

	it("does not turn a slow post-run hook into a queued model steer", async () => {
		const harness = createStaleCtxHarness()
		promptSummaryExtension(harness.pi)
		let idle = false

		await harness.emit("agent_start")
		await harness.emit("message_end", {
			message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } },
		})
		await harness.emit("agent_end", {}, { isIdle: () => idle })

		await vi.advanceTimersByTimeAsync(6_000)
		expect(harness.sent).toHaveLength(0)

		idle = true
		await vi.advanceTimersByTimeAsync(50)
		expect(harness.sent).toHaveLength(1)
	})

	it("waits for an explicit post-run hold before sending", async () => {
		const harness = createStaleCtxHarness()
		promptSummaryExtension(harness.pi)
		const release = holdPromptSummary()

		await harness.emit("agent_start")
		await harness.emit("message_end", {
			message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } },
		})
		await harness.emit("agent_end", {}, { isIdle: () => true })

		await vi.advanceTimersByTimeAsync(500)
		expect(harness.sent).toHaveLength(0)

		release()
		await vi.advanceTimersByTimeAsync(50)
		expect(harness.sent).toHaveLength(1)
	})

	it("drops a pending summary when a continuation starts before the session becomes idle", async () => {
		const harness = createStaleCtxHarness()
		promptSummaryExtension(harness.pi)
		let idle = false

		await harness.emit("agent_start")
		await harness.emit("message_end", {
			message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } },
		})
		await harness.emit("agent_end", {}, { isIdle: () => idle })
		await vi.advanceTimersByTimeAsync(50)

		await harness.emit("agent_start")
		await harness.emit("message_end", {
			message: { role: "assistant", usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 } },
		})
		await harness.emit("agent_end", {}, { isIdle: () => idle })

		idle = true
		await vi.advanceTimersByTimeAsync(50)

		expect(harness.sent).toHaveLength(1)
		expect(harness.sent[0]).toMatchObject({ details: { total: { input: 120, output: 60 } } })
	})

	it("does not send before later agent_end hooks can start a continuation", async () => {
		const harness = createStaleCtxHarness()
		promptSummaryExtension(harness.pi)

		await harness.emit("agent_start")
		await harness.emit("message_end", {
			message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 } },
		})
		await harness.emit("agent_end", {}, { isIdle: () => true })

		await harness.emit("agent_start")
		await harness.emit("message_end", {
			message: { role: "assistant", usage: { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 } },
		})
		await harness.emit("agent_end", {}, { isIdle: () => true })

		await vi.advanceTimersByTimeAsync(0)

		expect(harness.sent).toHaveLength(1)
		expect(harness.sent[0]).toMatchObject({ details: { total: { input: 120, output: 60 } } })
	})
})

describe("prompt summary renderer", () => {
	const theme = {
		fg: (_color: string, s: string) => s,
		bg: (_color: string, s: string) => s,
		bold: (s: string) => s,
		getFgAnsi: (_color: string) => "",
	} as unknown as Theme

	function render(details: Record<string, unknown>): string {
		const component = promptSummaryRenderer(
			{
				customType: "prompt-summary",
				details,
			} as unknown as Parameters<typeof promptSummaryRenderer>[0],
			{ expanded: false, outputPad: 0 },
			theme,
		)
		return (component as Component | undefined)?.render(80).join("\n") ?? ""
	}

	it("renders the feedback invitation line", () => {
		const text = render({
			elapsed: "3.6s",
			orchestrator: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
			subagents: null,
			total: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
		})
		expect(text).toContain("- Rate response: ⏶ Good (Ctrl+1)  ⏷ Bad (Ctrl+2)")
		// The rating line must be fully left-aligned (no indent).
		expect(text).not.toMatch(/^ {2}- Rate response:/m)
	})
})
