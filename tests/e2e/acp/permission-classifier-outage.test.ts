// ACP integration: the permission classifier fails (provider-side errors) in
// an auto-mode session. Expected: the gate still asks via a permission card
// (prompt path), the trip warning reaches the client as a
// `_kimchi.dev/pi_notify` notification, and no provider diagnostic leaks
// anywhere on the wire. The card itself carries no classifier subtitle —
// acp-prompter drops it (documented caveat in docs/permission-classifier.md).
//
// Wiring notes (mirrors tests/e2e/tui/permission-classifier-outage.test.ts):
//   - The classifier ladder tries three models with up to three attempts
//     each; every classifier request is answered with an SSE error chunk via
//     a `match` predicate on the classifier's system prompt, so the scripts
//     can never consume the main model's scripted turns.
//   - `--auto` overrides the fixture's yolo env (flag > env) so the
//     classifier actually runs.

import type { ClientCapabilities } from "@agentclientprotocol/sdk/unstable"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

const FULL_CAPABILITIES: ClientCapabilities = {
	fs: { readTextFile: false, writeTextFile: false },
}

const MAIN_MODEL = {
	slug: "basic",
	displayName: "Fake Basic",
	provider: "ai-enabler",
	contextWindow: 200_000,
	maxTokens: 8192,
}
const CLASSIFIER_MODEL = {
	slug: "deepseek-v4-flash-0731",
	displayName: "DeepSeek V4 Flash",
	provider: "ai-enabler",
	contextWindow: 200_000,
	maxTokens: 8192,
}

const CLASSIFIER_ERROR = "upstream unavailable"

/** Only the classifier's requests carry this system prompt opening. */
function isClassifierRequest(body: unknown): boolean {
	if (!body || typeof body !== "object") return false
	const messages = (body as { messages?: unknown }).messages
	if (!Array.isArray(messages) || messages.length === 0) return false
	const first = messages[0] as { role?: unknown; content?: unknown }
	return (
		first?.role === "system" &&
		typeof first?.content === "string" &&
		first.content.startsWith("You are a security gate")
	)
}

/** Worst case: three models × three attempts, all failing. */
const CLASSIFIER_ERROR_SCRIPTS = Array.from({ length: 9 }, () => ({
	match: (request: { body: unknown }) => isClassifierRequest(request.body),
	streamError: CLASSIFIER_ERROR,
}))

const WRITE_ARGS = JSON.stringify({ path: "output.txt", content: "hello world" })

describe("ACP integration — classifier outage", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "permission-classifier-outage",
			providerId: "kimchi-dev",
			defaultProvider: "kimchi-dev",
			defaultModel: "basic",
			models: [MAIN_MODEL, CLASSIFIER_MODEL],
			extraArgs: ["--auto"],
			clientCapabilities: FULL_CAPABILITIES,
			clientMeta: { "kimchi.dev": { pi_notify: true } },
			responses: [
				{
					stream: ["I'll create the file."],
					toolCalls: [{ function: { name: "write", arguments: WRITE_ARGS } }],
				},
				...CLASSIFIER_ERROR_SCRIPTS,
				{ stream: ["File written successfully."] },
			],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("asks via a permission card and warns through pi_notify without leaking provider text", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		const t = await prompt(fixture, sessionId, "Use the write tool to create output.txt containing: hello world")
		expect(t.stopReason, "turn completes after the card is approved").toBe("end_turn")

		// The failed classification became a permission card (prompt path),
		// auto-approved by the fixture client.
		expect(
			fixture.client.permissionRequests.length,
			"permission card for the failed classification",
		).toBeGreaterThanOrEqual(1)

		// The trip warning reached the client as a pi_notify notification.
		const notifyMessages = fixture.client.extNotifications
			.filter((n) => n.method === "_kimchi.dev/pi_notify")
			.map((n) => (n.params as { message?: string }).message ?? "")
		expect(
			notifyMessages.some((message) => message.includes("Permissions classifier unavailable")),
			"trip warning routed through pi_notify",
		).toBe(true)

		// No provider diagnostic anywhere on the notification wire.
		for (const message of notifyMessages) {
			expect(message, "no provider diagnostic in notifications").not.toContain(CLASSIFIER_ERROR)
		}
	})
})
