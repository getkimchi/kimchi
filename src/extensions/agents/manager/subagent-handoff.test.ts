import { afterEach, describe, expect, it, vi } from "vitest"
import type { AgentRecord } from "../personas/types.js"
import type { AgentHandoff } from "./subagent-handoff.js"
import {
	abortAllStagedHandoffs,
	abortStagedHandoff,
	clearHandoff,
	peekHandoff,
	stageHandoff,
	takeHandoffFor,
} from "./subagent-handoff.js"

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
		midResumeIds: new Set(),
		activity: [],
	}
}

function withAbort(handoff: AgentHandoff, abort: () => void): AgentHandoff {
	handoff.records = [
		{
			...(handoff.records[0] as NonNullable<(typeof handoff.records)[0]>),
			abortController: { abort, signal: undefined } as never,
		},
	]
	return handoff
}

afterEach(() => {
	clearHandoff()
})

describe("subagent handoff slot", () => {
	it("stages and peeks without claiming", () => {
		const handoff = makeHandoff("/old/session.jsonl")
		stageHandoff(handoff)
		expect(peekHandoff("/old/session.jsonl")).toBe(handoff)
	})

	it("claims on a matching previousSessionFile and clears the slot", () => {
		const handoff = makeHandoff("/old/session.jsonl")
		stageHandoff(handoff)
		const claimed = takeHandoffFor("/old/session.jsonl")
		expect(claimed).toBe(handoff)
		expect(peekHandoff("/old/session.jsonl")).toBeUndefined()
	})

	it("retains the slot when previousSessionFile does not match", () => {
		const handoff = makeHandoff("/old/session.jsonl")
		stageHandoff(handoff)
		expect(takeHandoffFor("/some/other/session.jsonl")).toBeUndefined()
		expect(peekHandoff("/old/session.jsonl")).toBe(handoff)
	})

	it("never claims with an undefined previousSessionFile", () => {
		stageHandoff(makeHandoff("/old/session.jsonl"))
		expect(takeHandoffFor(undefined)).toBeUndefined()
		expect(peekHandoff("/old/session.jsonl")).toBeDefined()
	})

	it("refuses to stage a handoff without a lineage key and aborts its records", () => {
		const abort = vi.fn()
		stageHandoff(withAbort(makeHandoff(undefined), abort))

		// No lineage key → no replacement can ever claim it: abort instead of
		// staging an unclaimable handoff.
		expect(abort).toHaveBeenCalledTimes(1)
		expect(takeHandoffFor("/old/session.jsonl")).toBeUndefined()
	})

	it("replaces and aborts a stale handoff only on SAME-key re-stage", () => {
		const abortOld = vi.fn()
		stageHandoff(withAbort(makeHandoff("/old/session.jsonl"), abortOld))

		// A slot being replaced can never be claimed — the runtime that would
		// match its lineage is gone.
		const newer = makeHandoff("/old/session.jsonl")
		stageHandoff(newer)
		expect(abortOld).toHaveBeenCalledTimes(1)
		expect(peekHandoff("/old/session.jsonl")).toBe(newer)
	})

	it("keeps sessions' handoffs independent across lineage keys", () => {
		const abortOld = vi.fn()
		const handoffB = makeHandoff("/other/session.jsonl")
		stageHandoff(withAbort(makeHandoff("/old/session.jsonl"), abortOld))
		stageHandoff(handoffB)

		// Staging session B's handoff must NOT evict or abort session A's —
		// the ACP server hosts several sessions at once.
		expect(abortOld).not.toHaveBeenCalled()
		expect(peekHandoff("/old/session.jsonl")?.fromSessionFile).toBe("/old/session.jsonl")
		expect(peekHandoff("/other/session.jsonl")).toBe(handoffB)
		expect(takeHandoffFor("/old/session.jsonl")).toBeDefined()
		expect(takeHandoffFor("/other/session.jsonl")).toBe(handoffB)
	})

	it("clearHandoff drops every staged handoff", () => {
		stageHandoff(makeHandoff("/old/session.jsonl"))
		stageHandoff(makeHandoff("/other/session.jsonl"))
		clearHandoff()
		expect(peekHandoff("/old/session.jsonl")).toBeUndefined()
		expect(peekHandoff("/other/session.jsonl")).toBeUndefined()
	})

	it("abortStagedHandoff aborts only the named session's handoff", () => {
		const abortA = vi.fn()
		const abortB = vi.fn()
		stageHandoff(withAbort(makeHandoff("/a/session.jsonl"), abortA))
		stageHandoff(withAbort(makeHandoff("/b/session.jsonl"), abortB))

		abortStagedHandoff("/a/session.jsonl")

		expect(abortA).toHaveBeenCalledTimes(1)
		expect(abortB).not.toHaveBeenCalled()
		expect(peekHandoff("/a/session.jsonl")).toBeUndefined()
		expect(peekHandoff("/b/session.jsonl")).toBeDefined()
	})

	it("abortAllStagedHandoffs aborts across all sessions (process quit)", () => {
		const abortA = vi.fn()
		const abortB = vi.fn()
		stageHandoff(withAbort(makeHandoff("/a/session.jsonl"), abortA))
		stageHandoff(withAbort(makeHandoff("/b/session.jsonl"), abortB))

		abortAllStagedHandoffs()

		expect(abortA).toHaveBeenCalledTimes(1)
		expect(abortB).toHaveBeenCalledTimes(1)
		expect(peekHandoff("/a/session.jsonl")).toBeUndefined()
		expect(peekHandoff("/b/session.jsonl")).toBeUndefined()
	})
})
