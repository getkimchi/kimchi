import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DISCIPLINE_REMINDER_TYPE, DisciplineReminder } from "./discipline-reminder.js"
import { DISCIPLINE_NUDGE_TEXT, SPICY } from "./prompt-construction/variants/spicy.js"
import { clearSessionMode, setSessionMode } from "./session-mode.js"

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

type Handler = (event: Record<string, unknown>) => unknown

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

function fire(handlers: Map<string, Handler[]>, event: string, payload: Record<string, unknown> = {}) {
	for (const h of handlers.get(event) ?? []) h(payload)
}

// ---------------------------------------------------------------------------
// DISCIPLINE_NUDGE_TEXT content coverage
// ---------------------------------------------------------------------------

describe("DISCIPLINE_NUDGE_TEXT content anchors", () => {
	it("nudge text covers the key discipline anchors", () => {
		expect(DISCIPLINE_NUDGE_TEXT).toContain("Working-discipline")
		expect(DISCIPLINE_NUDGE_TEXT).toMatch(/default to delegating/i)
		expect(DISCIPLINE_NUDGE_TEXT).toMatch(/delegate|agents/i)
		expect(DISCIPLINE_NUDGE_TEXT).toContain("architecture")
		expect(DISCIPLINE_NUDGE_TEXT).toContain("TL;DR")
		expect(DISCIPLINE_NUDGE_TEXT).toContain("never delete or bend")
		expect(DISCIPLINE_NUDGE_TEXT).toMatch(/over-engineer/i)
		expect(DISCIPLINE_NUDGE_TEXT).toMatch(/push back/i)
		expect(DISCIPLINE_NUDGE_TEXT).toMatch(/do not stop until/i)
		expect(DISCIPLINE_NUDGE_TEXT).toMatch(/original requirements/i)
		expect(DISCIPLINE_NUDGE_TEXT).toMatch(/extensive todo list/i)
		expect(DISCIPLINE_NUDGE_TEXT).toMatch(/do not reply to it/i)
		expect(DISCIPLINE_NUDGE_TEXT).toMatch(/coordinator and architect altitude/i)
		expect(DISCIPLINE_NUDGE_TEXT).toMatch(/own the corner cases/i)
	})

	it("SPICY.disciplineReminder.text('single') equals the exported DISCIPLINE_NUDGE_TEXT", () => {
		const text = SPICY.disciplineReminder?.text
		const result = typeof text === "function" ? text("single") : text
		expect(result).toBe(DISCIPLINE_NUDGE_TEXT)
	})
})

// ---------------------------------------------------------------------------
// DisciplineReminder class tests
// ---------------------------------------------------------------------------

// The production everyPrompts cadence (4), sourced from SPICY descriptor
// SPICY.disciplineReminder is always defined; fall back to 4 satisfies TypeScript without a non-null assertion
const EVERY_PROMPTS = SPICY.disciplineReminder?.everyPrompts ?? 4

describe("DisciplineReminder", () => {
	it("starts with zero completed runs", () => {
		const reminder = new DisciplineReminder()
		expect(reminder.getCompletedRuns()).toBe(0)
	})

	it("returns true on run 1, false on runs 2 and 3", () => {
		const reminder = new DisciplineReminder()
		expect(reminder.noteRunEnd(EVERY_PROMPTS)).toBe(true) // run 1
		expect(reminder.noteRunEnd(EVERY_PROMPTS)).toBe(false) // run 2
		expect(reminder.noteRunEnd(EVERY_PROMPTS)).toBe(false) // run 3
	})

	it("returns true on run 4 (everyPrompts = 4), counter is monotonic (no reset)", () => {
		const reminder = new DisciplineReminder()
		for (let i = 0; i < EVERY_PROMPTS - 1; i++) reminder.noteRunEnd(EVERY_PROMPTS)
		expect(reminder.noteRunEnd(EVERY_PROMPTS)).toBe(true) // run 4
		expect(reminder.getCompletedRuns()).toBe(EVERY_PROMPTS)
	})

	it("fires at runs 1, 4, 8, 12 across 12 calls (4 total)", () => {
		const reminder = new DisciplineReminder()
		let fires = 0
		for (let i = 0; i < 12; i++) {
			if (reminder.noteRunEnd(EVERY_PROMPTS)) fires++
		}
		expect(fires).toBe(4)
	})

	it("cadence is parametric: fires at runs 1, 3, 6 when everyPrompts=3", () => {
		const reminder = new DisciplineReminder()
		const fired: number[] = []
		for (let i = 1; i <= 6; i++) {
			if (reminder.noteRunEnd(3)) fired.push(i)
		}
		expect(fired).toEqual([1, 3, 6])
	})
})

// ---------------------------------------------------------------------------
// Extension integration tests
// ---------------------------------------------------------------------------

describe("disciplineReminderExtension - every everyPrompts runs (agent_end)", () => {
	beforeEach(() => {
		vi.resetModules()
	})

	it("sends on the first agent_end event (run 1); does not send on runs 2 and 3", async () => {
		mockResolvePromptVariant.mockReturnValue({
			name: "spicy",
			disciplineReminder: { text: DISCIPLINE_NUDGE_TEXT, everyPrompts: EVERY_PROMPTS },
		})
		const { default: disciplineReminderExtension } = await import("./discipline-reminder.js")
		const { pi, handlers, sendMessage } = createPiMock()

		disciplineReminderExtension(pi as never)

		fire(handlers, "agent_end")
		expect(sendMessage).toHaveBeenCalledOnce()

		for (let i = 0; i < EVERY_PROMPTS - 2; i++) fire(handlers, "agent_end")
		expect(sendMessage).toHaveBeenCalledOnce()
	})

	it("sends exactly 3 nudges across 8 agent_end events (at runs 1, 4, and 8)", async () => {
		mockResolvePromptVariant.mockReturnValue({
			name: "spicy",
			disciplineReminder: { text: DISCIPLINE_NUDGE_TEXT, everyPrompts: EVERY_PROMPTS },
		})
		const { default: disciplineReminderExtension } = await import("./discipline-reminder.js")
		const { pi, handlers, sendMessage } = createPiMock()

		disciplineReminderExtension(pi as never)

		for (let i = 0; i < 8; i++) fire(handlers, "agent_end")
		expect(sendMessage).toHaveBeenCalledTimes(3)
	})

	it("sent message has correct shape: customType, content, display:false, deliverAs:nextTurn", async () => {
		mockResolvePromptVariant.mockReturnValue({
			name: "spicy",
			disciplineReminder: { text: DISCIPLINE_NUDGE_TEXT, everyPrompts: EVERY_PROMPTS },
		})
		const { default: disciplineReminderExtension } = await import("./discipline-reminder.js")
		const { pi, handlers, sendMessage } = createPiMock()

		disciplineReminderExtension(pi as never)

		fire(handlers, "agent_end") // fires on run 1

		expect(sendMessage).toHaveBeenCalledOnce()
		const [msg, opts] = sendMessage.mock.calls[0]
		expect(opts).toEqual({ deliverAs: "nextTurn" })
		expect(msg.customType).toBe(DISCIPLINE_REMINDER_TYPE)
		expect(msg.display).toBe(false)
		expect(msg.content).toEqual([{ type: "text", text: DISCIPLINE_NUDGE_TEXT }])
	})

	it("is inert when variant lacks disciplineReminder (undefined)", async () => {
		mockResolvePromptVariant.mockReturnValue({ name: "default" })
		const { default: disciplineReminderExtension } = await import("./discipline-reminder.js")
		const { pi, handlers, sendMessage } = createPiMock()

		disciplineReminderExtension(pi as never)

		for (let i = 0; i < 10; i++) fire(handlers, "agent_end")

		expect(sendMessage).not.toHaveBeenCalled()
		expect(handlers.get("agent_end")).toBeUndefined()
	})

	it("with mode=orchestrator the delivered text does NOT contain 'default to delegating'", async () => {
		const SESSION_ID = "test-dr-session-orch"
		mockResolvePromptVariant.mockReturnValue({
			name: "spicy",
			disciplineReminder: { text: SPICY.disciplineReminder?.text, everyPrompts: EVERY_PROMPTS },
		})
		const { default: disciplineReminderExtension } = await import("./discipline-reminder.js")
		// Import session-mode from the same module registry as discipline-reminder
		const { setSessionMode: setMode, clearSessionMode: clearMode } = await import("./session-mode.js")
		setMode(SESSION_ID, "orchestrator")
		try {
			const { pi, handlers, sendMessage } = createPiMock()
			disciplineReminderExtension(pi as never)

			const ctx = { sessionManager: { getSessionId: () => SESSION_ID } }
			for (const h of handlers.get("agent_end") ?? []) (h as (...a: unknown[]) => unknown)({}, ctx)

			expect(sendMessage).toHaveBeenCalledOnce()
			const [msg] = sendMessage.mock.calls[0]
			expect(msg.content[0].text).not.toContain("default to delegating")
			expect(msg.content[0].text).toMatch(/^Working-discipline check:/)
		} finally {
			clearMode(SESSION_ID)
		}
	})

	it("with mode=single the delivered text is the full DISCIPLINE_NUDGE_TEXT", async () => {
		const SESSION_ID = "test-dr-session-single"
		mockResolvePromptVariant.mockReturnValue({
			name: "spicy",
			disciplineReminder: { text: SPICY.disciplineReminder?.text, everyPrompts: EVERY_PROMPTS },
		})
		const { default: disciplineReminderExtension } = await import("./discipline-reminder.js")
		const { setSessionMode: setMode, clearSessionMode: clearMode } = await import("./session-mode.js")
		setMode(SESSION_ID, "single")
		try {
			const { pi, handlers, sendMessage } = createPiMock()
			disciplineReminderExtension(pi as never)

			const ctx = { sessionManager: { getSessionId: () => SESSION_ID } }
			for (const h of handlers.get("agent_end") ?? []) (h as (...a: unknown[]) => unknown)({}, ctx)

			expect(sendMessage).toHaveBeenCalledOnce()
			const [msg] = sendMessage.mock.calls[0]
			expect(msg.content[0].text).toBe(DISCIPLINE_NUDGE_TEXT)
		} finally {
			clearMode(SESSION_ID)
		}
	})

	it("cache miss (no setSessionMode) falls back to full DISCIPLINE_NUDGE_TEXT", async () => {
		mockResolvePromptVariant.mockReturnValue({
			name: "spicy",
			disciplineReminder: { text: SPICY.disciplineReminder?.text, everyPrompts: EVERY_PROMPTS },
		})
		const { default: disciplineReminderExtension } = await import("./discipline-reminder.js")
		const { pi, handlers, sendMessage } = createPiMock()
		disciplineReminderExtension(pi as never)

		const ctx = { sessionManager: { getSessionId: () => "unregistered-session-xyz" } }
		for (const h of handlers.get("agent_end") ?? []) (h as (...a: unknown[]) => unknown)({}, ctx)

		expect(sendMessage).toHaveBeenCalledOnce()
		const [msg] = sendMessage.mock.calls[0]
		expect(msg.content[0].text).toBe(DISCIPLINE_NUDGE_TEXT)
	})

	it("is inert for agent workers", async () => {
		mockResolvePromptVariant.mockReturnValue({
			name: "spicy",
			disciplineReminder: { text: DISCIPLINE_NUDGE_TEXT, everyPrompts: EVERY_PROMPTS },
		})
		const savedSubagent = process.env.KIMCHI_SUBAGENT
		process.env.KIMCHI_SUBAGENT = "1"
		try {
			const { default: disciplineReminderExtension } = await import("./discipline-reminder.js")
			const { pi, handlers, sendMessage } = createPiMock()

			disciplineReminderExtension(pi as never)

			for (let i = 0; i < 10; i++) fire(handlers, "agent_end")

			expect(sendMessage).not.toHaveBeenCalled()
		} finally {
			if (savedSubagent === undefined) {
				Reflect.deleteProperty(process.env, "KIMCHI_SUBAGENT")
			} else {
				process.env.KIMCHI_SUBAGENT = savedSubagent
			}
		}
	})
})
