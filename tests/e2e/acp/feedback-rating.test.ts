// ACP integration — response rating (`_kimchi.dev/feedback`; contract:
// docs/acp-feedback.md).
//
// Mirrors the TUI's rating flow over the wire: after a response settles
// (prompt resolves end_turn → agent_settled arms the rating window), the
// client submits exactly one rating; an in-progress prompt, a cancel, or a
// terminal error leaves nothing to rate. The reason is stored as a custom
// transcript entry and telemetry — it must never reach the model.

import { setTimeout as delay } from "node:timers/promises"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, PROMPT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, waitForSessionUpdate } from "./support/scenarios.js"

const FEEDBACK_METHOD = "_kimchi.dev/feedback"

/** Distinctive sentinel: lets the "never reaches the model" assertion stand
 * out from any incidental string in prompts or system text. */
const REASON_SENTINEL = "REASON-SENTINEL-9f27b2"

async function rate(
	fixture: AcpFixture,
	sessionId: string,
	params: { sentiment: string; reason?: string },
): Promise<unknown> {
	return fixture.conn.extMethod(FEEDBACK_METHOD, {
		sessionId,
		action: "rate_response",
		...params,
	})
}

describe("ACP integration — settled-response rating", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "feedback-rating-settled",
			responses: [{ stream: ["First answer."] }, { stream: ["Second answer."] }],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("advertises the feedback capability in the initialize _meta", () => {
		const meta = fixture.initializeResponse.agentCapabilities?._meta as Record<string, unknown> | undefined
		const vendor = meta?.["kimchi.dev"] as Record<string, boolean> | undefined
		expect(vendor?.feedback).toBe(true)
		expect(meta?.feedback).toBeUndefined()
	})

	it("rates the settled response once; the reason never reaches the model", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)

		const promptResult = await fixture.conn.prompt({
			sessionId,
			prompt: [{ type: "text", text: "hello" }],
		})
		expect(promptResult.stopReason).toBe("end_turn")

		const result = await rate(fixture, sessionId, { sentiment: "negative", reason: REASON_SENTINEL })
		expect(result).toEqual({ status: "recorded" })

		// One rating per settled response: the window is consumed.
		await expect(rate(fixture, sessionId, { sentiment: "positive", reason: "Solved my task" })).rejects.toMatchObject({
			code: -32600,
		})

		// The next prompt re-arms the window and must not carry the reason to
		// the model — feedback is a custom entry, never LLM context.
		const next = await fixture.conn.prompt({
			sessionId,
			prompt: [{ type: "text", text: "follow-up" }],
		})
		expect(next.stopReason).toBe("end_turn")
		const sentToModel = fixture.fake.requests.map((r) => JSON.stringify(r.body ?? "")).join("\n")
		expect(sentToModel.includes(REASON_SENTINEL)).toBe(false)
	})
})

describe("ACP integration — rating window gating", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		// A slow stream keeps the turn live long enough to exercise the
		// mid-turn gate deterministically (mirrors the steering cancel test).
		fixture = await startAcpFixture({
			artifactName: "feedback-rating-gating",
			responses: [{ stream: ["Still ", "working ", "on ", "it. "], delayMs: 400 }],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("rejects while a prompt is in progress, then accepts after the turn settles", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)

		const promptPromise = fixture.conn.prompt({
			sessionId,
			prompt: [{ type: "text", text: "go" }],
		})
		await waitForSessionUpdate(fixture, sessionId, (u) => u.sessionUpdate === "agent_message_chunk")

		await expect(rate(fixture, sessionId, { sentiment: "positive" })).rejects.toMatchObject({ code: -32600 })

		const promptResult = await Promise.race([
			promptPromise,
			delay(PROMPT_TIMEOUT_MS).then(() => ({ stopReason: "TIMEOUT" as const })),
		])
		expect(promptResult.stopReason, "turn stop reason").toBe("end_turn")

		// The in-progress rejection did not consume the window.
		const result = await rate(fixture, sessionId, { sentiment: "positive", reason: "Fast response" })
		expect(result).toEqual({ status: "recorded" })
	})

	it("leaves nothing to rate after a cancelled turn", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)

		const promptPromise = fixture.conn.prompt({
			sessionId,
			prompt: [{ type: "text", text: "go" }],
		})
		await waitForSessionUpdate(fixture, sessionId, (u) => u.sessionUpdate === "agent_message_chunk")
		await fixture.conn.cancel({ sessionId })

		const promptResult = await Promise.race([
			promptPromise,
			delay(PROMPT_TIMEOUT_MS).then(() => ({ stopReason: "TIMEOUT" as const })),
		])
		expect(promptResult.stopReason, "stop reason after cancel").toBe("cancelled")

		await expect(rate(fixture, sessionId, { sentiment: "positive" })).rejects.toMatchObject({ code: -32600 })
	})
})
