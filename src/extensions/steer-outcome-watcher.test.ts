import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	resetSteerOutcomeWatches,
	type SteerObservedEvent,
	steerOutcomeWatcherExtension,
	watchSteerOutcome,
} from "./steer-outcome-watcher.js"

type Handler = (...args: unknown[]) => Promise<unknown> | unknown

function makePi() {
	const handlers = new Map<string, Handler[]>()
	const emitted: { channel: string; payload: unknown }[] = []
	const pi = {
		on: vi.fn((event: string, handler: Handler) => {
			const list = handlers.get(event) ?? []
			list.push(handler)
			handlers.set(event, list)
		}),
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
			const ctx = { sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionContext
			for (const handler of handlers.get(event) ?? []) await handler(payload, ctx)
		},
	}
}

const outcomes = (emitted: { channel: string; payload: unknown }[]) =>
	emitted
		.filter((e) => e.channel === "steer:outcome")
		.map((e) => e.payload as { kind: string; outcome: string; steer_id?: string; turns_to_outcome?: number })

describe("steer-outcome-watcher", () => {
	beforeEach(() => {
		resetSteerOutcomeWatches()
	})
	afterEach(() => {
		resetSteerOutcomeWatches()
	})

	it("complied on first classify hit, exactly one outcome, watch removed", async () => {
		const { emitted, fire } = makePi()
		watchSteerOutcome({
			kind: "todo_staleness",
			steerId: "f-1",
			sessionId: "session",
			interactive: true,
			classify: (e: SteerObservedEvent) => (e.toolName === "todo" ? "complied" : undefined),
		})
		await fire("tool_execution_end", { toolName: "bash" })
		expect(outcomes(emitted)).toHaveLength(0)
		await fire("tool_execution_end", { toolName: "todo" })
		await fire("tool_execution_end", { toolName: "bash" })
		expect(outcomes(emitted)).toEqual([
			expect.objectContaining({ kind: "todo_staleness", outcome: "complied", steer_id: "f-1" }),
		])
	})

	it("expired when the tool-call window closes with no classify hit", async () => {
		const { emitted, fire } = makePi()
		watchSteerOutcome({
			kind: "exploration_guard",
			steerId: "f-2",
			sessionId: "session",
			interactive: true,
			windowToolCalls: 2,
			classify: () => undefined,
		})
		await fire("tool_execution_end", { toolName: "read" })
		expect(outcomes(emitted)).toHaveLength(0)
		await fire("tool_execution_end", { toolName: "read" })
		expect(outcomes(emitted)).toEqual([
			expect.objectContaining({ kind: "exploration_guard", outcome: "expired", steer_id: "f-2", turns_to_outcome: 0 }),
		])
	})

	it("expired when the turn window closes; turns_to_outcome counts turns", async () => {
		const { emitted, fire } = makePi()
		watchSteerOutcome({
			kind: "continuation_nudge",
			steerId: "f-3",
			sessionId: "session",
			interactive: true,
			windowTurns: 2,
			classify: () => undefined,
		})
		await fire("turn_end", { message: { role: "assistant", content: [] } })
		await fire("turn_end", { message: { role: "assistant", content: [] } })
		expect(outcomes(emitted)).toEqual([
			expect.objectContaining({ kind: "continuation_nudge", outcome: "expired", turns_to_outcome: 2 }),
		])
	})

	it("a classify hit reports turns_to_outcome relative to the fire", async () => {
		const { emitted, fire } = makePi()
		watchSteerOutcome({
			kind: "planning_stop_nudge",
			steerId: "f-4",
			sessionId: "session",
			interactive: true,
			classify: (e) => (e.type === "tool_execution_end" ? "complied" : undefined),
		})
		await fire("turn_end", { message: { role: "assistant", content: [] } })
		await fire("turn_end", { message: { role: "assistant", content: [] } })
		await fire("tool_execution_end", { toolName: "bash" })
		expect(outcomes(emitted)).toEqual([expect.objectContaining({ outcome: "complied", turns_to_outcome: 2 })])
	})

	it("session_shutdown expires every open watch for that session only (ACP isolation)", async () => {
		const { emitted, fire } = makePi()
		watchSteerOutcome({ kind: "todo_staleness", sessionId: "s1", interactive: true, classify: () => undefined })
		watchSteerOutcome({ kind: "review_write_guard", sessionId: "s2", interactive: true, classify: () => undefined })
		await fire("session_shutdown", {}, "s1")
		expect(outcomes(emitted)).toEqual([expect.objectContaining({ kind: "todo_staleness", outcome: "expired" })])
		// s2's watch is untouched and still live.
		await fire("session_shutdown", {}, "s2")
		expect(outcomes(emitted)).toHaveLength(2)
	})

	it("repeated is emitted when the classifier reports it", async () => {
		const { emitted, fire } = makePi()
		watchSteerOutcome({
			kind: "continuation_nudge",
			steerId: "f-5",
			sessionId: "session",
			interactive: true,
			classify: (e) =>
				e.type === "turn_end" && e.textOnly ? "repeated" : e.type === "tool_execution_end" ? "complied" : undefined,
		})
		await fire("turn_end", { message: { role: "assistant", content: [{ type: "text" }] } })
		expect(outcomes(emitted)).toEqual([expect.objectContaining({ outcome: "repeated" })])
	})

	it("watches without a sessionId use the empty-key session (single-session hosts)", async () => {
		const { emitted, fire } = makePi()
		watchSteerOutcome({ kind: "todo_staleness", classify: () => "complied", interactive: false })
		await fire("tool_execution_end", { toolName: "bash" }, "")
		const found = outcomes(emitted)
		expect(found).toHaveLength(1)
		expect(found[0].outcome).toBe("complied")
		expect(found[0].steer_id).toBeUndefined()
	})
})
