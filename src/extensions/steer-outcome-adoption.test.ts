/**
 * Cross-site integration tests for the steer-outcome watcher adoptions
 * (Chunk 3): each kind that lacked a comply signal now emits one
 * via the shared watcher. These assert the classify definitions end-to-end —
 * fire a steer through the real emit path, drive the agent's behaviour, see
 * the outcome. Only kinds adopted in this change live here; the three kinds
 * with bespoke trackers keep their own suites.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import explorationGuardExtension from "./exploration-guard.js"
import { resetSteerOutcomeWatches, steerOutcomeWatcherExtension } from "./steer-outcome-watcher.js"
import { TODO_WRITE_TOOL_NAMES } from "./todos/session.js"

type Handler = (...args: unknown[]) => Promise<unknown> | unknown

function makePi() {
	const handlers = new Map<string, Handler[]>()
	const emitted: { channel: string; payload: unknown }[] = []
	const sent: unknown[] = []
	const pi = {
		on: vi.fn((event: string, handler: Handler) => {
			const list = handlers.get(event) ?? []
			list.push(handler)
			handlers.set(event, list)
		}),
		sendMessage: (message: unknown) => {
			sent.push(message)
		},
		events: {
			emit: (channel: string, payload: unknown) => {
				emitted.push({ channel, payload })
			},
		},
	} as unknown as ExtensionAPI
	steerOutcomeWatcherExtension(pi)
	return {
		pi,
		emitted,
		fire: async (event: string, payload: unknown, sessionId = "session") => {
			const ctx = { hasUI: true, sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionContext
			for (const handler of handlers.get(event) ?? []) await handler(payload, ctx)
		},
	}
}

const outcomes = (emitted: { channel: string; payload: unknown }[]) =>
	emitted
		.filter((e) => e.channel === "steer:outcome")
		.map((e) => e.payload as { kind: string; outcome: string; steer_id?: string })

describe("steer outcome watcher — site adoptions", () => {
	beforeEach(() => resetSteerOutcomeWatches())
	afterEach(() => resetSteerOutcomeWatches())

	it("todo_staleness: complied when the next todo write lands inside the window", async () => {
		const { pi, emitted, fire } = makePi()
		const { sendHiddenSteer } = await import("./todos/staleness-steers.js")
		sendHiddenSteer(pi, "todo-staleness", "refresh the list", {}, { steerKind: "todo_staleness", sessionId: "session" })
		expect(emitted.filter((e) => e.channel === "steer:fired")).toHaveLength(1)

		await fire("tool_execution_end", { toolName: "read" })
		expect(outcomes(emitted)).toHaveLength(0)
		await fire("tool_execution_end", { toolName: "mark_todo" })
		expect(outcomes(emitted)).toEqual([expect.objectContaining({ kind: "todo_staleness", outcome: "complied" })])
	})

	// Regression: the classifier must recognize every tool the todos
	// extension actually registers (plus the legacy upstream write_todos
	// name). It previously mirrored upstream-style names ("todo",
	// "todo_write", "todowrite") that kimchi never registers, so real
	// compliance — e.g. a mark_todo call following a staleness steer — was
	// misclassified: the window expired and emitted "expired" instead.
	it.each(TODO_WRITE_TOOL_NAMES)("todo_staleness: a %s write counts as compliance", async (name) => {
		const { pi, emitted, fire } = makePi()
		const { sendHiddenSteer } = await import("./todos/staleness-steers.js")
		sendHiddenSteer(pi, "todo-staleness", "refresh the list", {}, { steerKind: "todo_staleness", sessionId: "session" })

		await fire("tool_execution_end", { toolName: name })
		expect(outcomes(emitted)).toEqual([expect.objectContaining({ kind: "todo_staleness", outcome: "complied" })])
	})

	it("todo_staleness: expired when the window closes on non-todo work", async () => {
		const { pi, emitted, fire } = makePi()
		const { sendHiddenSteer } = await import("./todos/staleness-steers.js")
		sendHiddenSteer(pi, "todo-staleness", "refresh", {}, { steerKind: "todo_staleness", sessionId: "session" })
		for (let i = 0; i < 5; i++) await fire("tool_execution_end", { toolName: "bash" })
		expect(outcomes(emitted)).toEqual([expect.objectContaining({ kind: "todo_staleness", outcome: "expired" })])
	})

	it("exploration_guard: complied on the first write-tool call after the steer", async () => {
		const { pi, emitted, fire } = makePi()
		explorationGuardExtension(pi, { noToolWarnThreshold: 1, noToolSteerThreshold: 2 })
		await fire("session_start", {})
		for (let turn = 0; turn < 2; turn++) {
			await fire("turn_start", {})
			await fire("turn_end", { message: { role: "assistant", stopReason: "stop" } })
		}
		const fired = emitted.filter((event) => event.channel === "steer:fired").at(-1)
		if (!fired || typeof fired.payload !== "object" || fired.payload === null)
			throw new Error("mandatory steer not fired")
		const steerId = (fired.payload as { steer_id?: string }).steer_id
		expect(typeof steerId).toBe("string")

		await fire("tool_execution_end", { toolName: "read" })
		await fire("tool_execution_end", { toolName: "write" })
		expect(outcomes(emitted).filter((outcome) => outcome.steer_id === steerId)).toEqual([
			expect.objectContaining({ kind: "exploration_guard", outcome: "complied", steer_id: steerId }),
		])
	})
})
