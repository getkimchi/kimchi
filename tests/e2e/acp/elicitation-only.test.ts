// ACP integration: client advertises `elicitation.form` but NO
// `_kimchi.dev/pi_*` methods. Expected: basic ACP flows (text, tool calls,
// permissions) still work via `requestPermission`; fire-and-forget UI calls
// surface as `[ACP]` agent_message_chunk warnings instead of vanishing.
// (The elicitation capability is not on the permission path in ACP mode —
// it would only matter for explicit `ctx.ui.confirm`/`select`/`input`
// calls, which the harness doesn't issue in these scenarios.)

import type { ClientCapabilities } from "@agentclientprotocol/sdk"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

const ELICITATION_ONLY_CAPABILITIES: ClientCapabilities = {
	fs: { readTextFile: false, writeTextFile: false },
	elicitation: { form: {} },
}

describe("ACP integration — elicitation only", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "elicitation-only",
			responses: [
				{ stream: ["hello", " from", " elicitation-only", " client."] },
				{
					stream: ["I'll run that command."],
					toolCalls: [
						{
							function: {
								name: "bash",
								arguments: JSON.stringify({
									command: "touch /tmp/kimchi-acp-marker-elicit.txt",
								}),
							},
						},
					],
				},
				{ stream: ["done"] },
			],
			clientCapabilities: ELICITATION_ONLY_CAPABILITIES,
			// No clientMeta — the client did NOT advertise any _kimchi.dev/pi_* methods.
		})
	})

	afterEach(async () => {
		await fixture.stop()
	})

	it("surfaces fire-and-forget UI calls as agent_message_chunk warnings instead of dropping them", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)

		const t1 = await prompt(fixture, sessionId, "Reply with the words: hello world")
		expect(t1.stopReason, "turn 1 stop reason").toBe("end_turn")
		expect(t1.chunks, "turn 1 agent text").toContain("hello")
		expect(t1.chunks, "turn 1 agent text").toContain("elicitation-only")

		// `touch` is NOT in the read-only bash allowlist (see
		// src/extensions/permissions/taxonomy.ts) so it forces a permission
		// request on every mode — unlike `echo` which auto-approves.
		const t2 = await prompt(
			fixture,
			sessionId,
			"Use the bash tool to run exactly `touch /tmp/kimchi-acp-marker-elicit.txt` and reply with the word done",
		)
		expect(t2.stopReason, "turn 2 stop reason").toBe("end_turn")
		// The ACP prompter always routes permissions through `requestPermission`.
		expect(fixture.client.permissionRequests.length, "request_permission call").toBeGreaterThanOrEqual(1)
		expect(t2.chunks, "turn 2 agent text contains tool output").toContain("done")

		const piNotifications = fixture.client.extNotifications.filter((n) => n.method.startsWith("_kimchi.dev/pi_"))
		expect(piNotifications, "no _kimchi.dev/pi_* extNotifications").toEqual([])

		const warnings = fixture.client.acpWarnings()
		expect(warnings.length, "at least one [ACP] warning").toBeGreaterThanOrEqual(2)

		const notifyWarning = warnings.find((w) => /notify/i.test(w))
		const setStatusWarning = warnings.find((w) => /setStatus/i.test(w))
		expect(notifyWarning, "notify method named in warning text").toBeDefined()
		expect(setStatusWarning, "setStatus method named in warning text").toBeDefined()
		// Dedup means the first notify survives in the single emitted warning.
		expect(notifyWarning, "notify warning includes the message body").toContain("test-notify")
	})
})
