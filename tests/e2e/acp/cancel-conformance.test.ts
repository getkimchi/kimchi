// ACP integration — session/cancel conformance, mirroring acp-tck
// ACP-CANCEL-001/002 (tck/v1/conformance/test_cancel.py): the TCK cancels
// on the first session/update (or ~0.5s after the prompt if none), then
// requires the prompt to resolve with stopReason "cancelled" and no
// content/tool-call updates after the response.

import { setTimeout as delay } from "node:timers/promises"
import type { PromptResponse } from "@agentclientprotocol/sdk"
import { afterEach, describe, expect, it } from "vitest"
import { type AcpFixture, type AcpFixtureOptions, PROMPT_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, waitForSessionUpdate } from "./support/scenarios.js"

const CONTENT_UPDATES = new Set([
	"user_message_chunk",
	"agent_message_chunk",
	"agent_thought_chunk",
	"tool_call",
	"tool_call_update",
])

const QUIET_PERIOD_MS = 2000

/** Send a prompt, cancel per the given trigger, assert CANCEL-001/002. */
async function expectConformantCancel(
	fixture: AcpFixture,
	sessionId: string,
	cancel: () => Promise<void>,
): Promise<void> {
	const promptPromise = fixture.conn.prompt({
		sessionId,
		prompt: [{ type: "text", text: "count from 1 to 1000, slowly" }],
	})

	await cancel()

	// CANCEL-001: success result with stopReason "cancelled", not an error.
	const response: PromptResponse = await promptPromise
	const atResponse = fixture.client.sessionUpdates.length
	expect(response.stopReason).toBe("cancelled")

	// CANCEL-002: no content updates after the response, incl. quiet period.
	await delay(QUIET_PERIOD_MS)
	const late = fixture.client.sessionUpdates
		.slice(atResponse)
		.filter((u) => u.sessionId === sessionId && CONTENT_UPDATES.has(u.update.sessionUpdate))
	expect(late.map((u) => u.update.sessionUpdate)).toEqual([])
}

describe("ACP integration — session/cancel conformance", () => {
	let fixture: AcpFixture | undefined

	afterEach(async () => {
		await fixture?.stop()
		fixture = undefined
	})

	async function start(name: string, responses: AcpFixtureOptions["responses"]): Promise<AcpFixture> {
		fixture = await startAcpFixture({ artifactName: name, responses })
		return fixture
	}

	it(
		"cancel lands mid-stream (cancel on first content update)",
		async () => {
			// Slow stream so the cancel lands well before the turn would finish.
			const fx = await start("cancel-mid-stream", [
				{ stream: Array.from({ length: 60 }, (_, i) => `chunk-${i} `), delayMs: 150 },
			])
			const sessionId = await newSession(fx, fx.workDir)
			const cancelArmed = waitForSessionUpdate(fx, sessionId, (u) => u.sessionUpdate === "agent_message_chunk").then(
				() => fx.conn.cancel({ sessionId }),
			)
			await expectConformantCancel(fx, sessionId, () => cancelArmed)
		},
		PROMPT_TIMEOUT_MS + 20_000,
	)

	it(
		"cancel lands immediately after the prompt request",
		async () => {
			// First token only after ~3s; an early update (e.g.
			// available_commands_update) triggers the cancel within milliseconds
			// of session/prompt, inside pi-mono's pre-run window where
			// session.abort() is dropped.
			const fx = await start("cancel-first-request", [
				{ stream: Array.from({ length: 60 }, (_, i) => `chunk-${i} `), delayMs: 3000 },
			])
			const sessionId = await newSession(fx, fx.workDir)
			await expectConformantCancel(fx, sessionId, async () => {
				await fx.conn.cancel({ sessionId })
			})
		},
		PROMPT_TIMEOUT_MS + 20_000,
	)

	it(
		"cancel lands on the first session/update of any kind (TCK trigger)",
		async () => {
			const fx = await start("cancel-first-update", [
				{ stream: Array.from({ length: 60 }, (_, i) => `chunk-${i} `), textDelayMs: 200, delayMs: 500 },
			])
			const sessionId = await newSession(fx, fx.workDir)
			const cancelArmed = waitForSessionUpdate(fx, sessionId, () => true).then(() => fx.conn.cancel({ sessionId }))
			await expectConformantCancel(fx, sessionId, () => cancelArmed)
		},
		PROMPT_TIMEOUT_MS + 20_000,
	)

	it(
		"cancel lands while a tool call is executing",
		async () => {
			const fx = await start("cancel-during-tool", [
				{
					toolCalls: [{ function: { name: "bash", arguments: JSON.stringify({ command: "sleep 30" }) } }],
				},
				{ stream: ["done after tool"] },
			])
			const sessionId = await newSession(fx, fx.workDir)
			const cancelArmed = waitForSessionUpdate(
				fx,
				sessionId,
				(u) => u.sessionUpdate === "tool_call_update" && (u as { status?: string }).status === "in_progress",
			).then(async () => {
				// Let the tool actually start before cancelling.
				await delay(300)
				await fx.conn.cancel({ sessionId })
			})
			await expectConformantCancel(fx, sessionId, () => cancelArmed)
		},
		PROMPT_TIMEOUT_MS + 20_000,
	)
})
