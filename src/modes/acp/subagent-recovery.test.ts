import { describe, expect, it } from "vitest"
import { collectRecoveredSubagents, type RecoveredSubagent, recoveredSubagentState } from "./subagent-recovery.js"

const PARENT = {
	sessionId: "parent-new",
	sessionFile: "/sessions/parent-new.jsonl",
	previousSessionFile: "/sessions/parent-old.jsonl",
}

function record(overrides: Record<string, unknown> = {}): unknown {
	return {
		type: "custom",
		customType: "subagents:record",
		data: {
			id: "run-one",
			agentId: "run-one",
			sessionId: "child-native",
			parentSessionId: "parent-old",
			parentSessionFile: "/sessions/parent-old.jsonl",
			toolCallId: "provider-spawn",
			prompt: "Inspect the fixture.",
			description: "Inspect fixture",
			cwd: "/worktree/child",
			visibility: "user",
			remote: false,
			background: false,
			status: "running",
			sessionFile: "/sessions/child-native.jsonl",
			...overrides,
		},
	}
}

describe("recovered subagent associations", () => {
	it("remaps a cloned parent while preserving native child, prompt, and tool-call identity", () => {
		const [child] = collectRecoveredSubagents([record()], PARENT)
		expect(child).toMatchObject({
			agentId: "run-one",
			sessionId: "child-native",
			parentSessionId: "parent-new",
			toolCallId: "provider-spawn",
			prompt: "Inspect the fixture.",
		})
	})

	it("keeps multiple roots isolated and excludes opaque or non-local records", () => {
		expect(
			collectRecoveredSubagents(
				[
					record({ parentSessionId: "other-root", parentSessionFile: "/sessions/other-root.jsonl" }),
					record({ sessionId: "remote-child", remote: true }),
					record({ sessionId: "system-child", visibility: "system" }),
				],
				PARENT,
			),
		).toEqual([])
	})

	it("accepts only file-backed local metadata and protects against malformed entries", () => {
		expect(
			collectRecoveredSubagents(
				[
					record({ sessionFile: 42 }),
					record({ toolCallId: "" }),
					record({ sessionId: PARENT.sessionId }),
					record({ agentId: undefined, id: undefined }),
					null,
					{ type: "custom", customType: "subagents:record" },
				],
				PARENT,
			),
		).toEqual([])
	})

	it("uses the latest durable state for a recovered running association", () => {
		const children = collectRecoveredSubagents([record(), record({ status: "stopped" })], PARENT)
		expect(children).toHaveLength(1)
		expect(children[0]?.status).toBe("stopped")
	})
})

describe("recovered subagent states", () => {
	function child(status: RecoveredSubagent["status"]): RecoveredSubagent {
		const result = collectRecoveredSubagents([record({ status, abortReason: "max_duration" })], PARENT)[0]
		if (!result) throw new Error("Expected a recovered child")
		return result
	}

	it.each(["queued", "running", "reconnecting"] as const)("does not invent an outcome for %s", (status) => {
		expect(recoveredSubagentState(child(status))).toEqual({ state: "unknown" })
	})

	it("maps only observed terminal outcomes, without a cancelled tool status", () => {
		expect(recoveredSubagentState(child("stopped"))).toEqual({ state: "idle", stopReason: "cancelled" })
		expect(recoveredSubagentState(child("steered"))).toEqual({ state: "idle", stopReason: "cancelled" })
		expect(recoveredSubagentState(child("completed"))).toEqual({ state: "idle", stopReason: "end_turn" })
		expect(recoveredSubagentState(child("aborted"))).toMatchObject({
			state: "idle",
			stopReason: "error",
			error: { code: "subagent_aborted", message: "max_duration" },
		})
		expect(recoveredSubagentState(child("error"))).toMatchObject({ state: "idle", stopReason: "error" })
	})
})
