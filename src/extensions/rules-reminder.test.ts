import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SPICY } from "./prompt-construction/variants/spicy.js"
import { rulesBlockFor } from "./prompt-construction/variants/spicy-prompts.js"
import { isHarnessSteer, markHarnessSteer } from "./steer-marker.js"

// ---------------------------------------------------------------------------
// Module mock - controls resolvePromptVariant without touching the REGISTRY
// ---------------------------------------------------------------------------

const mockResolvePromptVariant = vi.fn()

vi.mock("./prompt-construction/variants/index.js", () => ({
	resolvePromptVariant: () => mockResolvePromptVariant(),
}))

// ---------------------------------------------------------------------------
// Pi mock factory
// ---------------------------------------------------------------------------

type Handler = (event: Record<string, unknown>, ctx?: unknown) => unknown

const INTERVAL_MS = SPICY.rulesReminder?.intervalMs ?? 5 * 60 * 1000

function createPiMock() {
	const handlers = new Map<string, Handler[]>()
	const sendMessage = vi.fn()
	const pi = {
		on: (event: string, handler: Handler) => {
			const list = handlers.get(event) ?? []
			list.push(handler)
			handlers.set(event, list)
		},
		sendMessage,
	}
	return { pi, handlers, sendMessage }
}

function sessionCtx(sessionId: string) {
	return { sessionManager: { getSessionId: () => sessionId } }
}

function fire(handlers: Map<string, Handler[]>, event: string, payload: Record<string, unknown>, ctx?: unknown) {
	for (const h of handlers.get(event) ?? []) h(payload, ctx)
}

function firePrompt(handlers: Map<string, Handler[]>, sessionId: string) {
	fire(handlers, "input", { type: "input", text: "hi", source: "interactive" }, sessionCtx(sessionId))
}

/** The reminder only fires for a session whose prompt mode has been recorded. */
async function recordSessionMode(sessionId: string, mode: "single" | "orchestrator" | "subagent") {
	const { setSessionMode } = await import("./session-mode.js")
	setSessionMode(sessionId, mode)
}

async function loadExtension() {
	const { default: rulesReminderExtension } = await import("./rules-reminder.js")
	const mocks = createPiMock()
	rulesReminderExtension(mocks.pi as never)
	return mocks
}

function spicyReminder(intervalMs: number = INTERVAL_MS) {
	return { name: "spicy", rulesReminder: { text: rulesBlockFor, intervalMs } }
}

function deliveredText(sendMessage: ReturnType<typeof vi.fn>, call = 0): string {
	return sendMessage.mock.calls[call][0].content[0].text
}

beforeEach(() => {
	vi.resetModules()
	mockResolvePromptVariant.mockReturnValue(spicyReminder())
})

afterEach(() => {
	vi.useRealTimers()
})

describe("rulesReminderExtension throttling", () => {
	it("appends the rules on the first prompt of a session", async () => {
		await recordSessionMode("rules-first", "single")
		const { handlers, sendMessage } = await loadExtension()

		firePrompt(handlers, "rules-first")

		expect(sendMessage).toHaveBeenCalledOnce()
		const [msg, opts] = sendMessage.mock.calls[0]
		expect(opts).toEqual({ deliverAs: "nextTurn" })
		expect(msg.customType).toBe("rules-reminder")
		expect(msg.content).toEqual([{ type: "text", text: markHarnessSteer(rulesBlockFor("single") as string) }])
	})

	it("stays quiet on a second prompt inside the interval", async () => {
		await recordSessionMode("rules-inside", "single")
		const { handlers, sendMessage } = await loadExtension()
		vi.useFakeTimers()

		firePrompt(handlers, "rules-inside")
		vi.advanceTimersByTime(INTERVAL_MS - 1)
		firePrompt(handlers, "rules-inside")

		expect(sendMessage).toHaveBeenCalledOnce()
	})

	it("appends the rules again once the interval has passed", async () => {
		await recordSessionMode("rules-after", "single")
		const { handlers, sendMessage } = await loadExtension()
		vi.useFakeTimers()

		firePrompt(handlers, "rules-after")
		vi.advanceTimersByTime(INTERVAL_MS)
		firePrompt(handlers, "rules-after")

		expect(sendMessage).toHaveBeenCalledTimes(2)
	})

	it("throttles each session on its own clock", async () => {
		await recordSessionMode("rules-session-a", "single")
		await recordSessionMode("rules-session-b", "single")
		const { handlers, sendMessage } = await loadExtension()
		vi.useFakeTimers()

		firePrompt(handlers, "rules-session-a")
		expect(sendMessage).toHaveBeenCalledTimes(1)

		// Session b has never been reminded, so its first prompt injects even
		// though session a was reminded a moment ago.
		firePrompt(handlers, "rules-session-b")
		expect(sendMessage).toHaveBeenCalledTimes(2)

		firePrompt(handlers, "rules-session-a")
		expect(sendMessage).toHaveBeenCalledTimes(2)
	})

	it("appends the rules on every prompt when the interval is zero", async () => {
		mockResolvePromptVariant.mockReturnValue(spicyReminder(0))
		await recordSessionMode("rules-zero", "single")
		const { handlers, sendMessage } = await loadExtension()

		firePrompt(handlers, "rules-zero")
		firePrompt(handlers, "rules-zero")
		firePrompt(handlers, "rules-zero")

		expect(sendMessage).toHaveBeenCalledTimes(3)
	})

	it("forgets the session's timestamp on session_shutdown", async () => {
		await recordSessionMode("rules-shutdown", "single")
		const { handlers, sendMessage } = await loadExtension()
		vi.useFakeTimers()

		firePrompt(handlers, "rules-shutdown")
		expect(sendMessage).toHaveBeenCalledTimes(1)

		fire(handlers, "session_shutdown", {}, sessionCtx("rules-shutdown"))

		// Without the eviction this prompt would be inside the interval and stay
		// quiet; injecting proves the entry is gone.
		firePrompt(handlers, "rules-shutdown")
		expect(sendMessage).toHaveBeenCalledTimes(2)
	})
})

describe("rulesReminderExtension message content", () => {
	it("marks the rules as harness-injected and hides them from the transcript", async () => {
		await recordSessionMode("rules-marked", "single")
		const { handlers, sendMessage } = await loadExtension()

		firePrompt(handlers, "rules-marked")

		const [msg] = sendMessage.mock.calls[0]
		expect(isHarnessSteer(msg.content[0].text)).toBe(true)
		expect(msg.display).toBe(false)
	})

	it("sends the single-mode list, delegation bullet included", async () => {
		await recordSessionMode("rules-single", "single")
		const { handlers, sendMessage } = await loadExtension()

		firePrompt(handlers, "rules-single")

		expect(deliveredText(sendMessage)).toContain("- Delegate implementation, testing, and review to focused subagents")
	})

	it("sends the orchestrator list: no delegation bullet, review by the Reviewer and Fixer personas", async () => {
		await recordSessionMode("rules-orch", "orchestrator")
		const { handlers, sendMessage } = await loadExtension()

		firePrompt(handlers, "rules-orch")

		const text = deliveredText(sendMessage)
		expect(text).not.toContain("- Delegate implementation, testing, and review to focused subagents")
		expect(text).toContain("use the Reviewer and Fixer personas")
	})
})

describe("rulesReminderExtension quiet cases", () => {
	it("sends nothing while the session's prompt mode is still unknown", async () => {
		const { handlers, sendMessage } = await loadExtension()

		firePrompt(handlers, "rules-unrecorded-session")

		expect(sendMessage).not.toHaveBeenCalled()
	})

	it("sends nothing for input that carries no session", async () => {
		const { handlers, sendMessage } = await loadExtension()

		fire(handlers, "input", { type: "input", text: "hi", source: "interactive" }, { sessionManager: undefined })

		expect(sendMessage).not.toHaveBeenCalled()
	})

	it("sends nothing for input generated by another extension", async () => {
		await recordSessionMode("rules-ext-input", "single")
		const { handlers, sendMessage } = await loadExtension()

		fire(handlers, "input", { type: "input", text: "hi", source: "extension" }, sessionCtx("rules-ext-input"))

		expect(sendMessage).not.toHaveBeenCalled()
	})

	it("is inert for agent workers", async () => {
		await recordSessionMode("rules-worker", "single")
		const savedSubagent = process.env.KIMCHI_SUBAGENT
		process.env.KIMCHI_SUBAGENT = "1"
		try {
			const { handlers, sendMessage } = await loadExtension()

			firePrompt(handlers, "rules-worker")

			expect(sendMessage).not.toHaveBeenCalled()
			expect(handlers.get("input")).toBeUndefined()
		} finally {
			if (savedSubagent === undefined) {
				Reflect.deleteProperty(process.env, "KIMCHI_SUBAGENT")
			} else {
				process.env.KIMCHI_SUBAGENT = savedSubagent
			}
		}
	})

	it("is inert when the variant defines no rules reminder", async () => {
		mockResolvePromptVariant.mockReturnValue({ name: "default" })
		await recordSessionMode("rules-default-variant", "single")
		const { handlers, sendMessage } = await loadExtension()

		firePrompt(handlers, "rules-default-variant")

		expect(sendMessage).not.toHaveBeenCalled()
		expect(handlers.get("input")).toBeUndefined()
	})
})
