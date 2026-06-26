// ACP integration: client advertises every `_kimchi.dev/pi_*` method and
// `elicitation.form`. Expected: fire-and-forget UI calls route through
// extNotifications (no `[ACP]` warnings), and tool-call permissions go
// through `requestPermission` (the ACP prompter always uses that, regardless
// of elicitation capability — `ctx.ui.confirm` is not on this path).

import type { ClientCapabilities } from "@agentclientprotocol/sdk"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ADVERTISED_CAPABILITIES } from "../../../src/modes/acp/capabilities.js"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

const FULL_CAPABILITIES: ClientCapabilities = {
	fs: { readTextFile: false, writeTextFile: false },
	elicitation: { form: {} },
}

// Spread the kimchi source of truth so this stays in sync when a method is added.
const PI_META = { "kimchi.dev": { ...ADVERTISED_CAPABILITIES } } as const

describe("ACP integration — all capabilities", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "all-capabilities",
			responses: [
				{ stream: ["hello", " from", " full-cap", " client."] },
				{
					// Each ACP prompt starts a new agent run (turnIndex resets to 0).
					// Emit orientation text before the tool call so first-turn-orientation
					// does not block before permissions run.
					stream: ["I'll run that command."],
					toolCalls: [
						{
							function: {
								name: "bash",
								arguments: JSON.stringify({
									command: "touch /tmp/kimchi-acp-marker-all.txt",
								}),
							},
						},
					],
				},
				{ stream: ["done"] },
			],
			clientCapabilities: FULL_CAPABILITIES,
			clientMeta: PI_META,
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("drives a text reply, a tool call, and a permission request through the full ACP surface", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)

		// Turn 1: text-only response.
		const t1 = await prompt(fixture, sessionId, "Reply with the words: hello world")
		expect(t1.stopReason, "turn 1 stop reason").toBe("end_turn")
		expect(t1.chunks, "turn 1 agent text").toContain("hello")
		expect(t1.chunks, "turn 1 agent text").toContain("full-cap")

		// Turn 2: tool call + permission + follow-up text.
		// `touch` is NOT in the read-only bash allowlist (see
		// src/extensions/permissions/taxonomy.ts) so it forces a permission
		// request on every mode — unlike `echo` which auto-approves.
		const t2 = await prompt(
			fixture,
			sessionId,
			"Use the bash tool to run exactly `touch /tmp/kimchi-acp-marker-all.txt` and reply with the word done",
		)
		expect(t2.stopReason, "turn 2 stop reason").toBe("end_turn")

		const toolCalls = fixture.client.sessionUpdates.filter(
			(u) =>
				u.sessionId === sessionId &&
				(u.update.sessionUpdate === "tool_call" || u.update.sessionUpdate === "tool_call_update"),
		)
		expect(toolCalls.length, "tool_call + tool_call_update notifications").toBeGreaterThanOrEqual(2)
		const completed = toolCalls.filter((u) => u.update.sessionUpdate === "tool_call_update")
		expect(completed.length, "at least one completed tool_call_update").toBeGreaterThanOrEqual(1)

		// The ACP prompter always routes tool-call permissions through
		// `requestPermission` (see src/modes/acp/acp-prompter.ts) — the
		// elicitation capability is irrelevant on this path.
		expect(fixture.client.permissionRequests.length, "request_permission call").toBeGreaterThanOrEqual(1)
		expect(t2.chunks, "turn 2 agent text contains tool output").toContain("done")

		// session_start fires on newSession, so both notifications arrive
		// before turn 1's prompt resolves.
		expect(
			fixture.client.hasNotification("_kimchi.dev/pi_notify"),
			`_kimchi.dev/pi_notify extNotification arrived (saw: ${fixture.client.extNotifications.map((n) => n.method).join(", ")})`,
		).toBe(true)
		expect(
			fixture.client.hasNotification("_kimchi.dev/pi_setStatus"),
			"_kimchi.dev/pi_setStatus extNotification arrived",
		).toBe(true)
		expect(fixture.client.acpWarnings(), "no [ACP] warnings when client advertises every pi_* method").toEqual([])
	})
})
