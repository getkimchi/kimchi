/**
 * Unit tests for the background tool-call lifecycle module, focusing on the
 * settle path: the exit outcome must be persisted to the transcript BEFORE
 * the wire flip, or a reload replays a failed process's call as completed.
 */
import type { SessionNotification } from "@agentclientprotocol/sdk"
import { afterEach, describe, expect, it } from "vitest"
import type { ProcessRegistry } from "../../../extensions/bash-background/process-registry.js"
import { type BashSessionState, setSessionState } from "../../../extensions/bash-background/session-registry.js"
import {
	type BackgroundToolCallContext,
	type BashBackgroundSettleOutcome,
	type HeldBackgroundToolCall,
	holdAndWatchBackgroundToolCall,
} from "./background.js"

const SESSION_ID = "background-settle-test"

type PersistedSettle = { piToolCallId: string; outcome: BashBackgroundSettleOutcome; acpToolCallId: string }

function makeCtx(): {
	ctx: BackgroundToolCallContext
	sent: SessionNotification[]
	persisted: PersistedSettle[]
	order: string[]
} {
	const sent: SessionNotification[] = []
	const persisted: PersistedSettle[] = []
	const order: string[] = []
	const ctx: BackgroundToolCallContext = {
		send: (n) => {
			order.push("send")
			sent.push(n)
		},
		displayContent: (_sid, content) => content,
		displayRecord: (_sid, value) => value,
		isCurrent: () => true,
		persistSettle: (piToolCallId, outcome, acpToolCallId) => {
			order.push("persist")
			persisted.push({ piToolCallId, outcome, acpToolCallId })
		},
	}
	return { ctx, sent, persisted, order }
}

function installRegistry(final: { exitCode: number | null; reason: string | null; content: string }): void {
	const registry = {
		whenExited: () => Promise.resolve({ exitCode: final.exitCode }),
		finalSnapshot: () => final,
		displaySnapshot: () => undefined,
		completedSnapshot: () => undefined,
	} as unknown as ProcessRegistry
	setSessionState(SESSION_ID, { registry } as unknown as BashSessionState)
}

const flushWatcher = () => new Promise((resolve) => setImmediate(resolve))

afterEach(() => {
	setSessionState(SESSION_ID, undefined)
})

describe("holdAndWatchBackgroundToolCall settle persistence", () => {
	it("persists the failed exit outcome to the transcript BEFORE the wire flip", async () => {
		installRegistry({ exitCode: 3, reason: null, content: "boom" })
		const { ctx, sent, persisted, order } = makeCtx()
		const held = new Map<string, HeldBackgroundToolCall>()

		holdAndWatchBackgroundToolCall(ctx, SESSION_ID, held, "h-1", {
			acpToolCallId: "acp-1",
			piToolCallId: "pi-1",
		})
		await flushWatcher()

		expect(persisted).toHaveLength(1)
		expect(persisted[0]?.piToolCallId).toBe("pi-1")
		// The ACP id travels with the settle so replay can re-bind the row the
		// live client already holds (wake-replay zombie fix).
		expect(persisted[0]?.acpToolCallId).toBe("acp-1")
		expect(persisted[0]?.outcome).toMatchObject({
			isError: true,
			text: "boom",
			details: { handle: "h-1", exited: true, exitCode: 3, reason: null },
		})
		// Persist before the wire flip: a process dying in between must still
		// leave the outcome in the transcript.
		expect(order).toEqual(["persist", "send"])
		expect((sent[0]?.update as { status?: string }).status).toBe("failed")
	})

	it("persists a successful settle with isError false and status completed", async () => {
		installRegistry({ exitCode: 0, reason: null, content: "done" })
		const { ctx, sent, persisted } = makeCtx()
		const held = new Map<string, HeldBackgroundToolCall>()

		holdAndWatchBackgroundToolCall(ctx, SESSION_ID, held, "h-1", {
			acpToolCallId: "acp-1",
			piToolCallId: "pi-1",
		})
		await flushWatcher()

		expect(persisted[0]?.outcome.isError).toBe(false)
		expect(persisted[0]?.outcome.details.exitCode).toBe(0)
		expect((sent[0]?.update as { status?: string }).status).toBe("completed")
	})

	it("persists the superseded-hold settle when the same handle is handed off twice", () => {
		installRegistry({ exitCode: null, reason: null, content: "" })
		const { ctx, persisted } = makeCtx()
		const held = new Map<string, HeldBackgroundToolCall>()

		holdAndWatchBackgroundToolCall(ctx, SESSION_ID, held, "h-1", {
			acpToolCallId: "acp-1",
			piToolCallId: "pi-1",
		})
		holdAndWatchBackgroundToolCall(ctx, SESSION_ID, held, "h-1", {
			acpToolCallId: "acp-2",
			piToolCallId: "pi-2",
		})

		// The superseded hold settled synchronously and persisted its reason…
		expect(persisted).toHaveLength(1)
		expect(persisted[0]?.piToolCallId).toBe("pi-1")
		expect(persisted[0]?.outcome.isError).toBe(true)
		expect(persisted[0]?.outcome.details.reason).toBe("tracking superseded by a new handoff")
		// …and the new hold now owns the handle.
		expect(held.get("h-1")?.acpToolCallId).toBe("acp-2")
	})
})
