import { afterEach, describe, expect, it, vi } from "vitest"
import type { AgentRecord } from "../personas/types.js"
import type { AgentHandoff } from "./subagent-handoff.js"
import { abortStagedHandoff, clearHandoff, peekHandoff, stageHandoff, takeHandoffFor } from "./subagent-handoff.js"

function makeHandoff(fromSessionFile: string | undefined): AgentHandoff {
	const record = {
		id: "agent-1",
		type: "general-purpose",
		description: "test agent",
		visibility: "user",
		status: "running",
		toolUses: 0,
		startedAt: Date.now(),
		currentAttemptId: 0,
		lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compactionCount: 0,
	} as AgentRecord
	return {
		fromSessionFile,
		records: [record],
		queued: [],
		activity: [],
	}
}

afterEach(() => {
	clearHandoff()
})

describe("subagent handoff slot", () => {
	it("stages and peeks without claiming", () => {
		const handoff = makeHandoff("/old/session.jsonl")
		stageHandoff(handoff)
		expect(peekHandoff()).toBe(handoff)
	})

	it("claims on a matching previousSessionFile and clears the slot", () => {
		const handoff = makeHandoff("/old/session.jsonl")
		stageHandoff(handoff)
		const claimed = takeHandoffFor("/old/session.jsonl")
		expect(claimed).toBe(handoff)
		expect(peekHandoff()).toBeUndefined()
	})

	it("retains the slot when previousSessionFile does not match", () => {
		const handoff = makeHandoff("/old/session.jsonl")
		stageHandoff(handoff)
		expect(takeHandoffFor("/some/other/session.jsonl")).toBeUndefined()
		expect(peekHandoff()).toBe(handoff)
	})

	it("never claims with an undefined previousSessionFile", () => {
		stageHandoff(makeHandoff("/old/session.jsonl"))
		expect(takeHandoffFor(undefined)).toBeUndefined()
		expect(peekHandoff()).toBeDefined()
	})

	it("never claims a handoff staged without a lineage key", () => {
		// A handoff with no fromSessionFile has no verifiable lineage —
		// it must not be claimed by a boot with no previous file either.
		stageHandoff(makeHandoff(undefined))
		expect(takeHandoffFor(undefined)).toBeUndefined()
		expect(takeHandoffFor("/old/session.jsonl")).toBeUndefined()
	})

	it("replaces a stale handoff on re-stage", () => {
		const first = makeHandoff("/old/session.jsonl")
		stageHandoff(first)
		const second = makeHandoff("/other/session.jsonl")
		stageHandoff(second)
		expect(peekHandoff()).toBe(second)
		// The stale first handoff is gone — the replacement of /old cannot
		// claim it anymore.
		expect(takeHandoffFor("/old/session.jsonl")).toBeUndefined()
		expect(takeHandoffFor("/other/session.jsonl")).toBe(second)
	})

	it("clearHandoff drops any staged handoff", () => {
		stageHandoff(makeHandoff("/old/session.jsonl"))
		clearHandoff()
		expect(peekHandoff()).toBeUndefined()
		expect(takeHandoffFor("/old/session.jsonl")).toBeUndefined()
	})

	it("aborts the evicted handoff's records when staging a new one", () => {
		const evicted = makeHandoff("/old/session.jsonl")
		const abortA = vi.fn()
		const abortB = vi.fn()
		evicted.records = [
			{ ...evicted.records[0]!, id: "r1", abortController: { abort: abortA, signal: undefined } as never },
			{ ...evicted.records[0]!, id: "r2", abortController: { abort: abortB, signal: undefined } as never },
		]
		stageHandoff(evicted)

		// A slot being replaced can never be claimed — the runtime that would
		// match its lineage is gone.
		stageHandoff(makeHandoff("/other/session.jsonl"))

		expect(abortA).toHaveBeenCalledTimes(1)
		expect(abortB).toHaveBeenCalledTimes(1)
		expect(peekHandoff()?.fromSessionFile).toBe("/other/session.jsonl")
	})

	it("abortStagedHandoff aborts and clears whatever is staged", () => {
		const handoff = makeHandoff("/old/session.jsonl")
		const abort = vi.fn()
		handoff.records = [{ ...handoff.records[0]!, abortController: { abort, signal: undefined } as never }]
		stageHandoff(handoff)

		abortStagedHandoff()

		expect(abort).toHaveBeenCalledTimes(1)
		expect(peekHandoff()).toBeUndefined()
	})
})
