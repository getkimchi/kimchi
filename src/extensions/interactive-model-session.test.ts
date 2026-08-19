import { expect, it, vi } from "vitest"
import { registerInteractiveModelSession, startNewInteractiveSessionWithModel } from "./interactive-model-session.js"

it("starts a fresh interactive session before selecting the requested model", async () => {
	vi.useFakeTimers()
	const sessionManager = {}
	const setModel = vi.fn(async () => undefined)
	const showStatus = vi.fn()
	registerInteractiveModelSession({
		sessionManager,
		runtimeHost: { newSession: vi.fn(async () => ({ cancelled: false })) },
		session: { setModel },
		showError: vi.fn(),
		showStatus,
	})
	const model = {
		id: "minimax-m2.7",
		provider: "kimchi-dev",
		name: "MiniMax M2.7",
		api: "openai-completions" as const,
		baseUrl: "https://example.test",
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100_000,
		maxTokens: 8192,
	}

	expect(await startNewInteractiveSessionWithModel(sessionManager, model)).toBe(true)
	expect(setModel).not.toHaveBeenCalled()
	await vi.runAllTimersAsync()
	expect(setModel).toHaveBeenCalledWith(model)
	expect(showStatus).toHaveBeenCalledWith("Started a new session with kimchi-dev/minimax-m2.7.")
	vi.useRealTimers()
})
