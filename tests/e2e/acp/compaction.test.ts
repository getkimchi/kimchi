// ACP integration — client-triggered compaction via extMethods.
//
// Covers the `_kimchi.dev/compact` / `_kimchi.dev/compact_abort` contract end
// to end against the real harness process:
//   1. A client-triggered compaction completes with a structured result while
//      its lifecycle streams through the `_kimchi.dev/agent_activity`
//      notification (compaction_start / compaction_end).
//   2. Prompts submitted while a compaction is in flight are rejected with a
//      structured JSON-RPC error (the prompt gate), not an opaque crash.
//   3. compact_abort cancels an in-flight manual compaction — the blocking
//      compact request resolves {status: "cancelled"}.
//   4. compact_abort also cancels an in-turn AUTOMATIC compaction (usage
//      threshold crossed mid-run): the turn survives and resumes with the
//      un-compacted context.
//   5. Manual compact is refused while a turn is active (upstream compact()
//      would silently abort the running turn).

import { setTimeout as delay } from "node:timers/promises"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, PROMPT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { E2E_WAIT_MS, newSession, waitForSessionUpdate } from "./support/scenarios.js"

const COMPACT_METHOD = "_kimchi.dev/compact"
const COMPACT_ABORT_METHOD = "_kimchi.dev/compact_abort"
const ACTIVITY_NOTIFICATION = "_kimchi.dev/agent_activity"

type ActivityParams = { sessionId: string; kind: string; reason?: string; aborted?: boolean }

async function waitForActivity(
	fixture: AcpFixture,
	kind: string,
	timeoutMs = E2E_WAIT_MS,
): Promise<{ method: string; params: unknown }> {
	const start = Date.now()
	while (Date.now() - start < timeoutMs) {
		const hit = fixture.client.extNotifications.find(
			(n) => n.method === ACTIVITY_NOTIFICATION && (n.params as ActivityParams).kind === kind,
		)
		if (hit) return hit
		await delay(50)
	}
	throw new Error(`waitForActivity(${kind}) timed out after ${timeoutMs}ms`)
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
	return Promise.race([
		promise,
		delay(PROMPT_TIMEOUT_MS).then(() => {
			throw new Error(`${label} timed out after ${PROMPT_TIMEOUT_MS}ms`)
		}),
	])
}

describe("ACP integration — user-triggered compaction", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		// Response 1 answers the prompt; response 2 is the summarization call
		// (slow — the delay window is what the gate/abort tests race against).
		fixture = await startAcpFixture({
			artifactName: "acp-compaction-manual",
			responses: [
				// Chunked + delayed so the active-turn test has a live turn to race
				// compact against; the other tests just wait the extra seconds.
				{ stream: ["Hello back ", "from the ", "agent. "], delayMs: 1_500 },
				{
					stream: ["Compacted summary: ", "the user greeted ", "the agent. "],
					delayMs: 1_500,
				},
				{ stream: ["Follow-up answer."] },
			],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("completes and streams compaction_start/compaction_end via agent_activity", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		await fixture.conn.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] })

		// force bypasses the keep-recent threshold on this tiny session.
		const result = (await withTimeout(
			fixture.conn.extMethod(COMPACT_METHOD, { sessionId, force: true }),
			"compact",
		)) as { status: string; summary?: string; tokensBefore?: number; firstKeptEntryId?: string }

		expect(result.status).toBe("completed")
		expect(result.summary).toContain("Compacted summary")
		expect(result.tokensBefore).toEqual(expect.any(Number))
		expect(result.firstKeptEntryId).toEqual(expect.any(String))

		const activities = fixture.client.extNotifications
			.filter((n) => n.method === ACTIVITY_NOTIFICATION)
			.map((n) => n.params as ActivityParams)
		expect(activities).toContainEqual(
			expect.objectContaining({ sessionId, kind: "compaction_start", reason: "manual" }),
		)
		expect(activities).toContainEqual(expect.objectContaining({ sessionId, kind: "compaction_end", reason: "manual" }))

		// The session is immediately usable afterwards.
		const followUp = await fixture.conn.prompt({ sessionId, prompt: [{ type: "text", text: "and follow up" }] })
		expect((followUp as { stopReason: string }).stopReason).toBe("end_turn")
	})

	it("rejects a prompt while compaction is in flight as a structured JSON-RPC error", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		await fixture.conn.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] })

		// Slow summarization (1.5s/chunk) keeps the compaction window open.
		const compactPromise = fixture.conn.extMethod(COMPACT_METHOD, { sessionId, force: true })
		await waitForActivity(fixture, "compaction_start")

		const error = await fixture.conn
			.prompt({ sessionId, prompt: [{ type: "text", text: "this must be gated" }] })
			.then(() => {
				throw new Error("prompt should have been rejected while compacting")
			})
			.catch((err: unknown) => err as { code?: number; message?: string })

		expect(error.message).toMatch(/compaction is in progress/)
		// JSON-RPC invalidRequest (-32600): a real protocol error, not a silent
		// turn outcome.
		expect(error.code).toBe(-32600)

		// The in-flight compaction still completes cleanly, and prompts are
		// accepted again afterwards.
		const compactResult = (await withTimeout(compactPromise, "compact")) as { status: string }
		expect(compactResult.status).toBe("completed")
		const after = await fixture.conn.prompt({ sessionId, prompt: [{ type: "text", text: "now it works" }] })
		expect((after as { stopReason: string }).stopReason).toBe("end_turn")
	})

	it("compact_abort cancels an in-flight compaction and resolves the blocking compact as cancelled", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		await fixture.conn.prompt({ sessionId, prompt: [{ type: "text", text: "hello" }] })

		const compactPromise = fixture.conn.extMethod(COMPACT_METHOD, { sessionId, force: true })
		await waitForActivity(fixture, "compaction_start")

		const abortResult = (await withTimeout(
			fixture.conn.extMethod(COMPACT_ABORT_METHOD, { sessionId }),
			"compact_abort",
		)) as { status: string }
		expect(abortResult.status).toBe("aborted")

		const compactResult = (await withTimeout(compactPromise, "compact")) as { status: string; error?: string }
		expect(compactResult.status).toBe("cancelled")
		expect(compactResult.error).toContain("Compaction cancelled")

		const endActivity = await waitForActivity(fixture, "compaction_end")
		expect((endActivity.params as ActivityParams).aborted).toBe(true)

		// Nothing was committed: a follow-up prompt responds normally.
		const followUp = await fixture.conn.prompt({ sessionId, prompt: [{ type: "text", text: "and follow up" }] })
		expect((followUp as { stopReason: string }).stopReason).toBe("end_turn")
	})

	it("refuses manual compact while a prompt turn is active", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		// Response 1 streams slowly (1.5s/chunk, 3 chunks), so the turn is still
		// live when compact arrives right after the first chunk.
		const promptPromise = fixture.conn.prompt({ sessionId, prompt: [{ type: "text", text: "go slow" }] })
		await waitForSessionUpdate(fixture, sessionId, (u) => u.sessionUpdate === "agent_message_chunk")

		await expect(fixture.conn.extMethod(COMPACT_METHOD, { sessionId, force: true })).rejects.toThrow(
			/prompt turn is in progress/,
		)

		await fixture.conn.cancel({ sessionId })
		const result = (await withTimeout(
			promptPromise.catch(() => ({ stopReason: "cancelled" as const })),
			"prompt",
		)) as {
			stopReason: string
		}
		expect(result.stopReason).toBe("cancelled")
	})
})

describe("ACP integration — compact_abort cancels auto-compaction mid turn", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-compaction-auto-abort",
			models: [
				{
					slug: "basic",
					displayName: "Fake Big",
					provider: "openai",
					reasoning: false,
					input: ["text"],
					contextWindow: 262_144,
					maxTokens: 8_192,
				},
			],
			responses: [
				// Turn 1: below threshold.
				{
					stream: ["Working on it. "],
					toolCalls: [{ function: { name: "bash", arguments: JSON.stringify({ command: "echo acp-turn-one" }) } }],
					usage: { prompt_tokens: 30_000, completion_tokens: 500 },
				},
				// Turn 2: usage crosses window − 16,384 → the mid-turn guard fires a
				// compaction summarization call (response 3), kept slow so the abort
				// lands mid-summarization.
				{
					// ~36k tokens: clears prepareCompaction's keepRecentTokens (20k)
					// gate, otherwise the guard fires but immediately no-ops with
					// "Nothing to compact (session too small)".
					stream: [`recent notes ${"kept note ".repeat(12_000)}`],
					toolCalls: [{ function: { name: "bash", arguments: JSON.stringify({ command: "echo acp-turn-two" }) } }],
					usage: { prompt_tokens: 250_000, completion_tokens: 700 },
				},
				{
					stream: ["Summarizing ", "the conversation ", "so far… "],
					delayMs: 2_000,
				},
				// Post-abort continuation turns: usage back below threshold.
				{
					stream: ["Continuing. "],
					toolCalls: [{ function: { name: "bash", arguments: JSON.stringify({ command: "echo acp-turn-three" }) } }],
					usage: { prompt_tokens: 20_000, completion_tokens: 200 },
				},
				{
					stream: ["AUTO_ABORT_FINAL: finished without compaction."],
					usage: { prompt_tokens: 21_000, completion_tokens: 100 },
				},
			],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("aborts the in-turn compaction and lets the turn continue", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		const promptPromise = fixture.conn.prompt({
			sessionId,
			prompt: [{ type: "text", text: "run the three echo steps then finish" }],
		})

		// The threshold guard's compaction announces itself on agent_activity.
		// Note on reason: the guard drives the manual-style (inline) compaction
		// path mid-run, so the live reason is "manual" here, not "threshold" —
		// the distinguished signal is simply that compaction starts while the
		// turn is still streaming, before its final scripted response.
		await waitForActivity(fixture, "compaction_start")
		const textSoFar = fixture.client.agentTextBySession().get(sessionId) ?? ""
		expect(textSoFar).not.toContain("AUTO_ABORT_FINAL")

		const abortResult = (await withTimeout(
			fixture.conn.extMethod(COMPACT_ABORT_METHOD, { sessionId }),
			"compact_abort",
		)) as { status: string }
		expect(abortResult.status).toBe("aborted")

		const endActivity = await waitForActivity(fixture, "compaction_end")
		expect((endActivity.params as ActivityParams).aborted).toBe(true)

		// The turn survives the abort and finishes on its own.
		const result = (await withTimeout(promptPromise, "prompt")) as { stopReason: string }
		expect(result.stopReason).toBe("end_turn")
		const chunks = fixture.client.agentTextBySession().get(sessionId) ?? ""
		expect(chunks).toContain("AUTO_ABORT_FINAL")
	})
})
