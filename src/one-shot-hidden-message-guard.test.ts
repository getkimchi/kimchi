import { AgentSession, type AgentSessionEvent, type ExtensionContext } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { type AssistantMessage, createAssistantEntry } from "./extensions/__mocks__/session-entries.js"
import { installOneShotHiddenMessageGuard } from "./one-shot-hidden-message-guard.js"

type SessionMessage = Extract<
	AgentSessionEvent,
	{ type: "message_start" | "message_end" | "message_update" }
>["message"]
type CustomMessage = Extract<SessionMessage, { role: "custom" }>
type StopReason = AssistantMessage["stopReason"]

function assistantEnd(stopReason: StopReason = "stop"): AgentSessionEvent {
	return { type: "message_end", message: createAssistantEntry([], { stopReason }).message }
}

function customMessage(display = false, customType = "memory-recall"): CustomMessage {
	return { role: "custom", customType, content: "context", display, timestamp: Date.now() }
}

function createHarness(mode: ExtensionContext["mode"] = "print") {
	const appended: CustomMessage[] = []
	const emitted: AgentSessionEvent[] = []
	let runStarts = 0
	let continuations = 0
	let disposals = 0
	const appendsAtContinue: number[] = []
	const proto = {
		_extensionMode: mode,
		agent: {
			async continue(..._args: unknown[]) {
				continuations++
				appendsAtContinue.push(appended.length)
			},
		},
		_emit(event: AgentSessionEvent) {
			emitted.push(event)
		},
		async _startRun(..._args: unknown[]) {
			runStarts++
		},
		_appendCustomMessage(message: CustomMessage) {
			appended.push(message)
		},
		dispose() {
			disposals++
		},
	}
	installOneShotHiddenMessageGuard({ prototype: proto })
	const session = Object.create(proto) as typeof proto
	return {
		session,
		appended,
		emitted,
		runStarts: () => runStarts,
		continuations: () => continuations,
		disposals: () => disposals,
		appendsAtContinue,
		startRun: () => session._startRun({}),
		continueRun: () => session.agent.continue(),
		dispose: () => session.dispose(),
	}
}

describe("one-shot hidden-message guard", () => {
	it.each(["print", "json"] as const)("holds every hidden custom message after a final answer in %s mode", (mode) => {
		const h = createHarness(mode)
		h.session._emit(assistantEnd())

		h.session._appendCustomMessage(customMessage(false, "memory-recall"))
		h.session._appendCustomMessage(customMessage(false, "todo-state"))
		h.session._appendCustomMessage(customMessage(false, "ferment-lifecycle"))
		h.session._appendCustomMessage(customMessage(false, "remote_plan_result"))

		expect(h.appended).toEqual([])
		expect(h.emitted).toHaveLength(1)
	})

	it("preserves visible custom messages at the terminal tail", () => {
		const h = createHarness()
		h.session._emit(assistantEnd())
		const visible = customMessage(true)

		h.session._appendCustomMessage(visible)

		expect(h.appended).toEqual([visible])
	})

	it("keeps hidden steers delivered after an assistant tool turn", () => {
		const h = createHarness()
		h.session._emit(assistantEnd("toolUse"))
		const recall = customMessage()

		h.session._appendCustomMessage(recall)

		expect(h.appended).toEqual([recall])
	})

	it("buffers hidden messages after error, length, and aborted assistant messages", () => {
		const h = createHarness()
		for (const stopReason of ["error", "length", "aborted"] as const) {
			h.session._emit(assistantEnd(stopReason))
			h.session._appendCustomMessage(customMessage(false, stopReason))
		}

		expect(h.appended).toEqual([])
	})

	it("replays buffered messages in order before the next run, including custom-triggered runs", async () => {
		const h = createHarness()
		h.session._emit(assistantEnd())
		const late = customMessage(false, "late")
		h.session._appendCustomMessage(late)
		h.session._emit({ type: "agent_settled", aborted: false })
		await h.startRun()
		const nextTurnRecall = customMessage(false, "next-turn")

		h.session._appendCustomMessage(nextTurnRecall)

		expect(h.runStarts()).toBe(1)
		expect(h.appended).toEqual([late, nextTurnRecall])
	})

	it("replays ordered buffered messages exactly once before retry and compaction continuations", async () => {
		const h = createHarness()
		await h.startRun()
		h.session._emit(assistantEnd("error"))
		const first = customMessage(false, "first")
		const second = customMessage(false, "second")
		h.session._appendCustomMessage(first)
		h.session._appendCustomMessage(second)
		expect(h.appended).toEqual([])

		await h.continueRun()

		expect(h.continuations()).toBe(1)
		expect(h.appendsAtContinue).toEqual([2])
		expect(h.appended).toEqual([first, second])

		const active = customMessage(false, "active-after-replay")
		h.session._appendCustomMessage(active)
		await h.continueRun()
		expect(h.appendsAtContinue).toEqual([2, 3])
		expect(h.appended).toEqual([first, second, active])
	})

	it("discards a genuinely final buffer only on dispose", async () => {
		const h = createHarness()
		await h.startRun()
		h.session._emit(assistantEnd())
		h.session._appendCustomMessage(customMessage())
		h.session._emit({ type: "agent_settled", aborted: false })
		expect(h.appended).toEqual([])

		h.dispose()
		await h.continueRun()

		expect(h.disposals()).toBe(1)
		expect(h.appended).toEqual([])
	})

	it.each(["tui", "rpc"] as const)("does not change hidden delivery in %s mode", (mode) => {
		const h = createHarness(mode)
		h.session._emit(assistantEnd())
		const state = customMessage(false, "todo-state")

		h.session._appendCustomMessage(state)

		expect(h.appended).toEqual([state])
	})

	it("is idempotent", () => {
		const appended: CustomMessage[] = []
		const proto: {
			_extensionMode: "print"
			_emit: (event: AgentSessionEvent) => void
			_startRun: (...args: unknown[]) => Promise<void>
			_appendCustomMessage: (message: CustomMessage) => void
			dispose: () => void
			_kimchiOneShotHiddenMessageGuard?: boolean
		} = {
			_extensionMode: "print",
			_emit() {},
			async _startRun() {},
			_appendCustomMessage(message) {
				appended.push(message)
			},
			dispose() {},
		}
		installOneShotHiddenMessageGuard({ prototype: proto })
		installOneShotHiddenMessageGuard({ prototype: proto })
		const session = Object.create(proto) as typeof proto
		session._emit(assistantEnd("toolUse"))
		const recall = customMessage()

		session._appendCustomMessage(recall)

		expect(appended).toEqual([recall])
	})

	it("targets the pinned AgentSession append and run lifecycle methods", () => {
		const proto = AgentSession.prototype as unknown as Record<string, unknown>
		for (const method of ["_emit", "_startRun", "_appendCustomMessage", "dispose"]) {
			expect(typeof proto[method], method).toBe("function")
		}
	})
})
