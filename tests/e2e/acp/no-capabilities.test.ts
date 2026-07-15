// ACP integration: client advertises neither `elicitation.form` nor any
// `_kimchi.dev/pi_*` method. Expected: basic ACP flows still work; tool-call
// permissions fall back to `requestPermission`; fire-and-forget UI calls
// are sent unconditionally via `_kimchi.dev/pi_notify` (no capability gate,
// no `[ACP]` warnings).

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

describe("ACP integration — no capabilities", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "no-capabilities",
			responses: [
				{ stream: ["hello", " from", " minimal", " client."] },
				{
					stream: ["I'll run that command."],
					toolCalls: [
						{
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: "touch /tmp/kimchi-acp-marker-none.txt" }),
							},
						},
					],
				},
				{ stream: ["done"] },
			],
			// Baseline capabilities only (fs.read/write off); no elicitation, no _meta.
		})
	})

	afterEach(async () => {
		await fixture.stop()
	})

	it("drives text + tool calls + permissions even with no UI capabilities advertised", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)

		const t1 = await prompt(fixture, sessionId, "Reply with the words: hello world")
		expect(t1.stopReason, "turn 1 stop reason").toBe("end_turn")
		expect(t1.chunks, "turn 1 agent text").toContain("hello")
		expect(t1.chunks, "turn 1 agent text").toContain("minimal")

		// `touch` is NOT in the read-only bash allowlist (see
		// src/extensions/permissions/taxonomy.ts) so it forces a permission
		// request on every mode — unlike `echo` which auto-approves. With
		// no elicitation advertised, the UI context falls back to
		// `requestPermission` (ACP-native, always available).
		const t2 = await prompt(
			fixture,
			sessionId,
			"Use the bash tool to run exactly `touch /tmp/kimchi-acp-marker-none.txt` and reply with the word done",
		)
		expect(t2.stopReason, "turn 2 stop reason").toBe("end_turn")
		expect(
			fixture.client.permissionRequests.length,
			"request_permission call (no-capabilities fallback)",
		).toBeGreaterThanOrEqual(1)
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
