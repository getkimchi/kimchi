import { afterEach, describe, expect, it } from "vitest"
import type { AgentRecord } from "../personas/types.js"
import type { AgentHandoff } from "./subagent-handoff.js"
import { clearHandoff, peekHandoff, stageHandoff, takeHandoffFor } from "./subagent-handoff.js"

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
})
