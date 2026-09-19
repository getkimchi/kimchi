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

// Drives the mode the reminder derives when the session has none recorded yet.
const mockMultiModelEnabled = vi.fn()

vi.mock("./multi-model.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./multi-model.js")>()),
	getMultiModelEnabled: () => mockMultiModelEnabled(),
}))

// The ferment the reminder sees; the real status predicate stays in play.
const mockActiveFerment = vi.fn()

vi.mock("./ferment/state.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./ferment/state.js")>()),
	getActive: () => mockActiveFerment(),
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

/** Stands in for the prompt build that records the session's mode. */
async function recordPromptMode(sessionId: string, mode: "single" | "orchestrator" | "subagent") {
	const { setPromptMode } = await import("./prompt-mode-cache.js")
	setPromptMode(sessionId, mode)
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
	mockMultiModelEnabled.mockReturnValue(false)
	mockActiveFerment.mockReturnValue(undefined)
})

afterEach(() => {
	vi.useRealTimers()
})

describe("rulesReminderExtension throttling", () => {
	it("appends the rules on the first prompt of a session, before any prompt build", async () => {
		const { handlers, sendMessage } = await loadExtension()

		firePrompt(handlers, "rules-first")

		expect(sendMessage).toHaveBeenCalledOnce()
		const [msg, opts] = sendMessage.mock.calls[0]
		expect(opts).toEqual({ deliverAs: "nextTurn" })
		expect(msg.customType).toBe("rules-reminder")
		expect(msg.content).toEqual([{ type: "text", text: markHarnessSteer(rulesBlockFor("single") as string) }])
	})

	it("stays quiet on a second prompt inside the interval", async () => {
		await recordPromptMode("rules-inside", "single")
		const { handlers, sendMessage } = await loadExtension()
		vi.useFakeTimers()

		firePrompt(handlers, "rules-inside")
		vi.advanceTimersByTime(INTERVAL_MS - 1)
		firePrompt(handlers, "rules-inside")

		expect(sendMessage).toHaveBeenCalledOnce()
	})

	it("appends the rules again once the interval has passed", async () => {
		await recordPromptMode("rules-after", "single")
		const { handlers, sendMessage } = await loadExtension()
		vi.useFakeTimers()

		firePrompt(handlers, "rules-after")
		vi.advanceTimersByTime(INTERVAL_MS)
		firePrompt(handlers, "rules-after")

		expect(sendMessage).toHaveBeenCalledTimes(2)
	})

	it("throttles each session on its own clock", async () => {
		await recordPromptMode("rules-session-a", "single")
		await recordPromptMode("rules-session-b", "single")
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
		await recordPromptMode("rules-zero", "single")
		const { handlers, sendMessage } = await loadExtension()

		firePrompt(handlers, "rules-zero")
		firePrompt(handlers, "rules-zero")
		firePrompt(handlers, "rules-zero")

		expect(sendMessage).toHaveBeenCalledTimes(3)
	})

	it("forgets the session's timestamp on session_shutdown", async () => {
		await recordPromptMode("rules-shutdown", "single")
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
		await recordPromptMode("rules-marked", "single")
		const { handlers, sendMessage } = await loadExtension()

		firePrompt(handlers, "rules-marked")

		const [msg] = sendMessage.mock.calls[0]
		expect(isHarnessSteer(msg.content[0].text)).toBe(true)
		expect(msg.display).toBe(false)
	})

	it("sends the single-mode list, delegation bullet included", async () => {
		await recordPromptMode("rules-single", "single")
		const { handlers, sendMessage } = await loadExtension()

		firePrompt(handlers, "rules-single")

		expect(deliveredText(sendMessage)).toContain("- Delegate implementation, testing, and review to focused subagents")
	})

	it("leaves the delegation bullet out while a ferment is in progress", async () => {
		await recordPromptMode("rules-ferment", "single")
		mockActiveFerment.mockReturnValue({ status: "running" })
		const { handlers, sendMessage } = await loadExtension()

		firePrompt(handlers, "rules-ferment")

		expect(deliveredText(sendMessage)).not.toContain(
			"- Delegate implementation, testing, and review to focused subagents",
		)
	})

	// A draft ferment counts as in progress here, even though the planner rules
	// only reach a draft in one-shot mode.
	it("leaves the delegation bullet out while a ferment is still a draft", async () => {
		await recordPromptMode("rules-ferment-draft", "single")
		mockActiveFerment.mockReturnValue({ status: "draft" })
		const { handlers, sendMessage } = await loadExtension()

		firePrompt(handlers, "rules-ferment-draft")

		expect(deliveredText(sendMessage)).not.toContain(
			"- Delegate implementation, testing, and review to focused subagents",
		)
	})

	it("sends the delegation bullet again once the ferment is finished", async () => {
		await recordPromptMode("rules-ferment-done", "single")
		mockActiveFerment.mockReturnValue({ status: "complete" })
		const { handlers, sendMessage } = await loadExtension()

		firePrompt(handlers, "rules-ferment-done")

		expect(deliveredText(sendMessage)).toContain("- Delegate implementation, testing, and review to focused subagents")
	})

	it("sends the orchestrator list: no delegation bullet, review by the Reviewer and Fixer personas", async () => {
		await recordPromptMode("rules-orch", "orchestrator")
		const { handlers, sendMessage } = await loadExtension()

		firePrompt(handlers, "rules-orch")

		const text = deliveredText(sendMessage)
		expect(text).not.toContain("- Delegate implementation, testing, and review to focused subagents")
		expect(text).toContain("use the Reviewer and Fixer personas")
	})

	it("derives the mode from the multi-model setting until a prompt build records one", async () => {
		mockMultiModelEnabled.mockReturnValue(true)
		const { handlers, sendMessage } = await loadExtension()

		firePrompt(handlers, "rules-derived-orch")

		expect(deliveredText(sendMessage)).toContain("use the Reviewer and Fixer personas")
	})

	it("uses the recorded mode instead of the derived one", async () => {
		await recordPromptMode("rules-recorded-wins", "orchestrator")
		mockMultiModelEnabled.mockReturnValue(false)
		const { handlers, sendMessage } = await loadExtension()

		firePrompt(handlers, "rules-recorded-wins")

		expect(deliveredText(sendMessage)).toContain("use the Reviewer and Fixer personas")
	})
})

describe("rulesReminderExtension quiet cases", () => {
	it("sends nothing for input that carries no session", async () => {
		const { handlers, sendMessage } = await loadExtension()

		fire(handlers, "input", { type: "input", text: "hi", source: "interactive" }, { sessionManager: undefined })

		expect(sendMessage).not.toHaveBeenCalled()
	})

	it("sends nothing for input generated by another extension", async () => {
		await recordPromptMode("rules-ext-input", "single")
		const { handlers, sendMessage } = await loadExtension()

		fire(handlers, "input", { type: "input", text: "hi", source: "extension" }, sessionCtx("rules-ext-input"))

		expect(sendMessage).not.toHaveBeenCalled()
	})

	it("sends nothing when the session's recorded prompt mode is subagent", async () => {
		// A variant whose rules text is non-empty for every mode, so the message
		// staying unsent proves the subagent check is what stopped it.
		mockResolvePromptVariant.mockReturnValue({
			name: "spicy",
			rulesReminder: { text: () => "Working rules, always follow:", intervalMs: INTERVAL_MS },
		})
		await recordPromptMode("rules-subagent-mode", "subagent")
		const { handlers, sendMessage } = await loadExtension()

		firePrompt(handlers, "rules-subagent-mode")

		expect(sendMessage).not.toHaveBeenCalled()
	})

	it("is inert for agent workers, whose mode is never recorded", async () => {
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
		const { handlers, sendMessage } = await loadExtension()

		firePrompt(handlers, "rules-default-variant")

		expect(sendMessage).not.toHaveBeenCalled()
		expect(handlers.get("input")).toBeUndefined()
	})
})

describe("rulesReminderExtension debug trace", () => {
	let savedDebugPrompts: string | undefined

	beforeEach(() => {
		savedDebugPrompts = process.env.KIMCHI_DEBUG_PROMPTS
	})

	afterEach(() => {
		if (savedDebugPrompts === undefined) {
			Reflect.deleteProperty(process.env, "KIMCHI_DEBUG_PROMPTS")
		} else {
			process.env.KIMCHI_DEBUG_PROMPTS = savedDebugPrompts
		}
	})

	it("traces the injection while prompt debugging is on", async () => {
		process.env.KIMCHI_DEBUG_PROMPTS = "1"
		const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {})
		try {
			await recordPromptMode("rules-debug-on", "single")
			const { handlers } = await loadExtension()

			firePrompt(handlers, "rules-debug-on")

			expect(debugSpy).toHaveBeenCalledOnce()
			expect(String(debugSpy.mock.calls[0][0])).toContain("rules-debug-on")
		} finally {
			debugSpy.mockRestore()
		}
	})

	it("writes nothing to the terminal while prompt debugging is off", async () => {
		Reflect.deleteProperty(process.env, "KIMCHI_DEBUG_PROMPTS")
		const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {})
		try {
			await recordPromptMode("rules-debug-off", "single")
			const { handlers, sendMessage } = await loadExtension()

			firePrompt(handlers, "rules-debug-off")

			expect(sendMessage).toHaveBeenCalledOnce()
			expect(debugSpy).not.toHaveBeenCalled()
		} finally {
			debugSpy.mockRestore()
		}
	})
})
