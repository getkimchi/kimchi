// ACP integration — retry-aware continuation-nudge recovery.
//
// The ACP surface forwards raw streamed text deltas as agent_message_chunk
// session updates. A pending nudge response must blank those deltas —
// including across provider-error retries inside the same agent run — so the
// retried `<done>` acknowledgement never reaches the client, and the
// recovery must end at turn settlement without a second nudge or spurious
// tool work. Mirrors the TUI workflow in
// tests/e2e/tui/continuation-nudge-stop-wait.test.ts (scenario 4).

import { setTimeout as delay } from "node:timers/promises"
import type { ContentChunk } from "@agentclientprotocol/sdk"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, PROMPT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession } from "./support/scenarios.js"

const CONTINUATION_NUDGE_PHRASE = "You ended your turn without calling a tool" // CONTINUATION_NUDGE_TEXT
const SECOND_NUDGE_PHRASE = "MUST call the required tool immediately" // SECOND_NUDGE_TEXT
const EMPTY_TURN_NUDGE_PHRASE = "If you have finished, please summarize the result for the user" // EMPTY_TURN_NUDGE_TEXT

function agentMessageTexts(fixture: AcpFixture, sessionId: string): string[] {
	return fixture.client.sessionUpdates
		.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "agent_message_chunk")
		.map((u) => ((u.update as ContentChunk).content as { type: "text"; text: string }).text)
}

describe("ACP integration — retried nudge acknowledgement", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-continuation-nudge-retry",
			// No retry overrides needed: kimchi's first-run defaults seed pi's
			// settings.json with retries enabled and provider.maxRetries 0, so the
			// scripted 500s surface to the AgentSession layer that fires turn_end
			// and agent_end per attempt — the layer the retry-aware nudge state
			// machine must survive. The 2s/4s default backoffs fit inside the
			// 60s prompt timeout.
			responses: [
				// A real tool cycle arms the session-level tool latch, so the
				// later text-only cycle is nudge-eligible instead of being
				// suppressed by the fresh-session guard.
				{
					stream: ["Running the command."],
					toolCalls: [{ function: { name: "bash", arguments: JSON.stringify({ command: "echo hi" }) } }],
				},
				{ stream: ["The command printed: hi."] },
				// Text-only drift in a fresh user-input cycle: statement-only,
				// no question, no waiting phrase — this must trigger the nudge.
				{ stream: ["I will delegate the implementation to a builder agent next."] },
				// The acknowledgement round errors twice (retryable 500s).
				{ status: 500 },
				{ status: 500 },
				// The retry succeeds with exactly the token, split across deltas.
				{ stream: ["<do", "ne>"] },
			],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("hides the retried token acknowledgement and ends the turn without re-nudging", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)

		// First prompt: a real tool cycle so the session latch is armed.
		let result = await Promise.race([
			fixture.conn.prompt({ sessionId, prompt: [{ type: "text", text: "run echo hi" }] }),
			delay(PROMPT_TIMEOUT_MS).then(() => ({ stopReason: "TIMEOUT" as const })),
		])
		expect(result.stopReason, "tool-cycle prompt stop reason").toBe("end_turn")

		// Second prompt: text-only drift. The continuation nudge fires as a
		// followUp, the acknowledgement round retries through both 500s, and
		// the whole run settles — the prompt resolves only after all of it.
		result = await Promise.race([
			fixture.conn.prompt({ sessionId, prompt: [{ type: "text", text: "continue with the implementation" }] }),
			delay(PROMPT_TIMEOUT_MS).then(() => ({ stopReason: "TIMEOUT" as const })),
		])
		expect(result.stopReason, "drift prompt stop reason").toBe("end_turn")

		// The drift answer was visible to the client...
		const streamed = agentMessageTexts(fixture, sessionId).join("")
		expect(streamed).toContain("delegate the implementation")
		// ...but the retried <done> acknowledgement never reached it: the
		// blanked deltas produce no message chunks for the token.
		expect(streamed).not.toContain("<done>")
		expect(streamed).not.toContain("ne>")

		// The nudge fired exactly once: no second nudge and no empty-turn
		// nudge were injected into any provider request.
		const bodies = fixture.fake.requests.map((request) => JSON.stringify(request.body ?? ""))
		expect(
			bodies.some((body) => body.includes(CONTINUATION_NUDGE_PHRASE)),
			"continuation nudge fired",
		).toBe(true)
		expect(
			bodies.some((body) => body.includes(SECOND_NUDGE_PHRASE)),
			"no second nudge",
		).toBe(false)
		expect(
			bodies.some((body) => body.includes(EMPTY_TURN_NUDGE_PHRASE)),
			"no empty-turn nudge",
		).toBe(false)
		// No spurious work followed the acknowledgement: exactly the six
		// scripted provider requests ran (tool call, answer, drift, two 500
		// retries, token). A guard steer, second nudge, or invented tool call
		// would consume a seventh request the fake server cannot serve.
		const chatRequests = fixture.fake.requests.filter(
			(request) => request.method === "POST" && request.url.startsWith("/openai/v1/chat/completions"),
		)
		expect(chatRequests, "provider request count").toHaveLength(6)
	})
})
