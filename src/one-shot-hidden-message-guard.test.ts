import {
	AgentSession,
	type AgentSessionEvent,
	AgentSessionRuntime,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
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

type ModeBinding = Pick<Parameters<AgentSession["bindExtensions"]>[0], "mode">

function createHarness(
	mode: ExtensionContext["mode"] = "print",
	appendFailure?: Error,
	bindings: ModeBinding = { mode },
) {
	const appended: CustomMessage[] = []
	let branch = [createAssistantEntry([], { id: "original" })]
	const emitted: AgentSessionEvent[] = []
	let runStarts = 0
	let continuations = 0
	let disposals = 0
	const appendsAtContinue: number[] = []
	const proto = {
		_extensionMode: "print" as ExtensionContext["mode"],
		async bindExtensions({ mode }: ModeBinding) {
			if (mode !== undefined) this._extensionMode = mode
		},
		sessionManager: {
			getLeafId: () => branch.at(-1)?.id ?? null,
			getBranch: () => branch,
		},
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
			if (appendFailure) throw appendFailure
			appended.push(message)
		},
		dispose() {
			disposals++
		},
	}
	const session = Object.create(proto) as typeof proto
	const runtimeProto = {
		session,
		async dispose() {
			this.session.dispose()
		},
	}
	installOneShotHiddenMessageGuard({ prototype: proto }, { prototype: runtimeProto })
	void session.bindExtensions(bindings)
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
		shutdown: () => runtimeProto.dispose(),
		selectBranch: (...entryIds: string[]) => {
			branch = entryIds.map((id) => createAssistantEntry([], { id }))
		},
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

	it("discards buffered messages on direct session disposal during replacement", async () => {
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

	it("persists buffered messages once on final runtime disposal", async () => {
		const h = createHarness()
		await h.startRun()
		h.session._emit(assistantEnd())
		const first = customMessage(false, "first")
		const second = customMessage(false, "second")
		h.session._appendCustomMessage(first)
		h.session._appendCustomMessage(second)
		h.session._emit({ type: "agent_settled", aborted: false })
		expect(h.appended).toEqual([])

		await h.shutdown()
		await h.continueRun()

		expect(h.disposals()).toBe(1)
		expect(h.appended).toEqual([first, second])
	})

	it("persists only messages from the selected branch at final shutdown", async () => {
		const h = createHarness()
		h.session._emit(assistantEnd())
		h.session._appendCustomMessage(customMessage(false, "original-only"))

		h.selectBranch("sibling")
		const sibling = customMessage(false, "sibling-only")
		h.session._appendCustomMessage(sibling)
		h.selectBranch("sibling", "metadata")

		await h.shutdown()

		expect(h.appended).toEqual([sibling])
	})

	it("keeps buffered context on its original branch across subsequent runs", async () => {
		const h = createHarness()
		h.session._emit(assistantEnd())
		const original = customMessage(false, "original-only")
		h.session._appendCustomMessage(original)

		h.selectBranch("sibling")
		await h.startRun()
		expect(h.appended).toEqual([])

		h.selectBranch("original")
		await h.startRun()
		expect(h.appended).toEqual([original])
	})

	it.each([0, 74])("completes teardown after a terminal append fails with exit code %s", async (exitCode) => {
		const h = createHarness("print", new Error("ENOSPC"))
		const previousExitCode = process.exitCode
		const stderr = vi.spyOn(console, "error").mockImplementation(() => {})
		try {
			process.exitCode = exitCode
			h.session._emit(assistantEnd())
			h.session._appendCustomMessage(customMessage())

			await h.shutdown()

			expect(h.disposals()).toBe(1)
			expect(process.exitCode).toBe(exitCode || 1)
			expect(stderr).toHaveBeenCalledWith("Failed to persist buffered session messages:", expect.any(Error))
		} finally {
			process.exitCode = previousExitCode
			stderr.mockRestore()
		}
	})

	it("propagates an append failure before the next model request", async () => {
		const failure = new Error("ENOSPC")
		const h = createHarness("print", failure)
		h.session._emit(assistantEnd())
		h.session._appendCustomMessage(customMessage())

		await expect(h.startRun()).rejects.toBe(failure)
		expect(h.runStarts()).toBe(0)
	})

	it.each(["tui", "rpc"] as const)("does not change hidden delivery in %s mode", (mode) => {
		const h = createHarness(mode)
		h.session._emit(assistantEnd())
		const state = customMessage(false, "todo-state")

		h.session._appendCustomMessage(state)

		expect(h.appended).toEqual([state])
	})

	it("journals hidden messages immediately when extensions bind without a mode", () => {
		const h = createHarness("print", undefined, {})
		h.session._emit(assistantEnd())
		const state = customMessage(false, "todo-state")

		h.session._appendCustomMessage(state)
		expect(h.appended).toEqual([state])

		h.dispose()
		expect(h.appended).toEqual([state])
	})

	it("is idempotent", () => {
		const appended: CustomMessage[] = []
		const proto: {
			_extensionMode: "print"
			bindExtensions: AgentSession["bindExtensions"]
			sessionManager: { getBranch: () => []; getLeafId: () => null }
			_emit: (event: AgentSessionEvent) => void
			_startRun: (...args: unknown[]) => Promise<void>
			_appendCustomMessage: (message: CustomMessage) => void
			dispose: () => void
			_kimchiOneShotHiddenMessageGuard?: boolean
		} = {
			_extensionMode: "print",
			async bindExtensions() {},
			sessionManager: { getBranch: () => [], getLeafId: () => null },
			_emit() {},
			async _startRun() {},
			_appendCustomMessage(message) {
				appended.push(message)
			},
			dispose() {},
		}
		const runtimeProto = { async dispose() {} }
		installOneShotHiddenMessageGuard({ prototype: proto }, { prototype: runtimeProto })
		installOneShotHiddenMessageGuard({ prototype: proto }, { prototype: runtimeProto })
		const session = Object.create(proto) as typeof proto
		session._emit(assistantEnd("toolUse"))
		const recall = customMessage()

		session._appendCustomMessage(recall)

		expect(appended).toEqual([recall])
	})

	it("targets the pinned AgentSession append and run lifecycle methods", () => {
		const proto = AgentSession.prototype as unknown as Record<string, unknown>
		for (const method of ["bindExtensions", "_emit", "_startRun", "_appendCustomMessage", "dispose"]) {
			expect(typeof proto[method], method).toBe("function")
		}
		expect(typeof AgentSessionRuntime.prototype.dispose).toBe("function")
	})
})
