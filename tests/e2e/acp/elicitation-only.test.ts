// ACP integration: client advertises `elicitation.form` but NO
// `_kimchi.dev/pi_*` methods. Expected: basic ACP flows (text, tool calls,
// permissions) still work via `requestPermission`; fire-and-forget UI calls
// are sent unconditionally via `_kimchi.dev/pi_notify` (no capability gate,
// no `[ACP]` warnings).

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

	it("sends fire-and-forget UI calls via pi_notify even without pi_* capabilities advertised", async () => {
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

		// Fire-and-forget UI calls (notify + setStatus) are sent
		// unconditionally via pi_notify — no capability gate.
		const piNotifications = fixture.client.extNotifications.filter((n) => n.method.startsWith("_kimchi.dev/pi_"))
		expect(
			piNotifications.length,
			"pi_notify extNotifications arrive even without advertised capabilities",
		).toBeGreaterThanOrEqual(2)
		expect(fixture.client.acpWarnings(), "no [ACP] warnings (capability gate removed)").toEqual([])
	})
})
