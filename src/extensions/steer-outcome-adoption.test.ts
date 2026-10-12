/**
 * Cross-site integration tests for the steer-outcome watcher adoptions
 * (Chunk 3, LLM-3079): each kind that lacked a comply signal now emits one
 * via the shared watcher. These assert the classify definitions end-to-end —
 * fire a steer through the real emit path, drive the agent's behaviour, see
 * the outcome. Only kinds adopted in this change live here; the three kinds
 * with bespoke trackers keep their own suites.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetSteerOutcomeWatches, steerOutcomeWatcherExtension } from "./steer-outcome-watcher.js"

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
		await fire("tool_execution_end", { toolName: "todo" })
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
		const { emitted, fire } = makePi()
		// Fire the steer the way the guard does — classify against a write tool,
		// complied when one lands.
		const { watchSteerOutcome } = await import("./steer-outcome-watcher.js")
		watchSteerOutcome({
			kind: "exploration_guard",
			steerId: "eg-1",
			sessionId: "session",
			interactive: true,
			windowToolCalls: 3,
			classify: (event) => (event.type === "tool_execution_end" && event.toolName === "write" ? "complied" : undefined),
		})
		await fire("tool_execution_end", { toolName: "read" })
		await fire("tool_execution_end", { toolName: "write" })
		expect(outcomes(emitted)).toEqual([
			expect.objectContaining({ kind: "exploration_guard", outcome: "complied", steer_id: "eg-1" }),
		])
	})

	it("review_write_guard: repeated when a write lands inside the guard window (via regression path)", async () => {
		const { emitted, fire } = makePi()
		const { watchSteerOutcome } = await import("./steer-outcome-watcher.js")
		const impl = new Set(["edit", "write"])
		watchSteerOutcome({
			kind: "review_write_guard",
			steerId: "rwg-1",
			sessionId: "session",
			interactive: true,
			windowToolCalls: 3,
			classify: (event) =>
				event.type === "tool_execution_end" && event.toolName !== undefined && impl.has(event.toolName)
					? "repeated"
					: undefined,
		})
		await fire("tool_execution_end", { toolName: "edit" })
		expect(outcomes(emitted)).toEqual([
			expect.objectContaining({ kind: "review_write_guard", outcome: "repeated", steer_id: "rwg-1" }),
		])
	})
})
