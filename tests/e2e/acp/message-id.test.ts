// ACP integration: stable `messageId` across chunks within a content block.
//
// ACP's ContentChunk contract (node_modules/@agentclientprotocol/sdk/dist/
// schema/types.gen.d.ts ~870) says: "All chunks belonging to the same
// message share the same messageId. A change in messageId indicates a new
// message has started." pi-mono streams a content block as multiple
// text_delta / thinking_delta events that share the block's contentIndex, so
// the ACP server can collapse them onto a single messageId without
// coordinating across events. This test drives a real binary end-to-end and
// asserts the contract on the wire shape the client observes.
//
// Note: the fixture loads test-ui-extension.js, which exercises fire-and-
// forget UI methods (notify / setStatus / setWidget). Because this test
// doesn't advertise the corresponding `_kimchi.dev/pi_*` client capabilities,
// the harness emits `[ACP]` warning chunks as a fallback. Those go through a
// different code path than LLM-streamed deltas (so they have no messageId),
// and `isAcpWarning` filters them out so the assertion is only on streamed
// chunks.

import type { ContentChunk } from "@agentclientprotocol/sdk"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

/** True for `[ACP]` UI fallback warnings, which come from a non-streaming code path. */
function isAcpWarning(update: ContentChunk): boolean {
	return update.content?.type === "text" && (update.content.text?.startsWith("[ACP]") ?? false)
}

describe("ACP integration — messageId stability across chunks", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		// Script streams thinking then text in many small chunks so pi-mono
		// emits several deltas per content block rather than coalescing.
		fixture = await startAcpFixture({
			artifactName: "message-id",
			responses: [
				{
					thinking: ["Hmm, ", "let me ", "think ", "about ", "this."],
					stream: ["Sure, ", "here is ", "the ", "answer."],
				},
			],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("shares one messageId per block and uses a distinct messageId across blocks", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		const result = await prompt(fixture, sessionId, "Answer with a short sentence")
		expect(result.stopReason, "turn stop reason").toBe("end_turn")
		expect(result.chunks, "streamed text reached the client").toContain("answer")

		const streamedIds = (sessionUpdate: string): Array<string | null | undefined> =>
			fixture.client.sessionUpdates
				.filter(
					(u) =>
						u.sessionId === sessionId &&
						u.update.sessionUpdate === sessionUpdate &&
						!isAcpWarning(u.update as ContentChunk),
				)
				.map((u) => (u.update as ContentChunk).messageId)

		const thoughtIds = streamedIds("agent_thought_chunk")
		const textIds = streamedIds("agent_message_chunk")

		expect(thoughtIds.length, "thought block streamed multiple chunks").toBeGreaterThanOrEqual(2)
		expect(textIds.length, "text block streamed multiple chunks").toBeGreaterThanOrEqual(2)
		expect(new Set(thoughtIds).size, "all thought chunks share one messageId").toBe(1)
		expect(new Set(textIds).size, "all text chunks share one messageId").toBe(1)
		expect(thoughtIds[0], "thought and text blocks carry distinct messageIds").not.toBe(textIds[0])
	})
})

// Regression guard for the in-turn message boundary bug: a single turn can
// produce multiple assistant messages (e.g. thinking → text → toolCall → new
// message → thinking). Without message_start clearing the per-message
// contentIndex map, the second thinking block at contentIndex=0 would inherit
// the first thinking block's messageId and a client would merge two separate
// "thinking" bubbles.
describe("ACP integration — messageId across assistant message boundaries within one turn", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "message-id-multi-message",
			responses: [
				// First assistant message: thinking + text + toolCall. `echo` is
				// in the read-only bash allowlist so it auto-approves (no
				// request_permission round-trip needed).
				{
					thinking: ["First ", "think"],
					stream: ["Calling echo. "],
					toolCalls: [
						{
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: "echo hi" }),
							},
						},
					],
				},
				// Second assistant message: another thinking block + text, after
				// the tool result is fed back to the model.
				{
					thinking: ["Second ", "think"],
					stream: ["Done."],
				},
			],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("uses a fresh messageId for the second assistant message's thinking block", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		const result = await prompt(fixture, sessionId, "Run echo and continue")
		expect(result.stopReason, "turn stop reason").toBe("end_turn")
		expect(result.chunks, "second message text reached the client").toContain("Done")

		const thoughtIds = fixture.client.sessionUpdates
			.filter(
				(u) =>
					u.sessionId === sessionId &&
					u.update.sessionUpdate === "agent_thought_chunk" &&
					!isAcpWarning(u.update as ContentChunk),
			)
			.map((u) => (u.update as ContentChunk).messageId)

		// Two assistant messages in one turn = two thought blocks at
		// contentIndex=0 = two distinct messageIds. The pre-fix bug had both
		// blocks sharing the same id.
		expect(thoughtIds.length, "two thought blocks streamed across two messages").toBeGreaterThanOrEqual(2)
		expect(new Set(thoughtIds).size, "second thinking block has a distinct messageId from the first").toBe(2)
	})
})
