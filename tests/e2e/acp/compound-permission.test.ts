// ACP integration: verifies that compound bash commands produce exactly
// one permission card (the single-card branch of handleCompoundConfirm),
// not three (one per subcommand — that path is TUI-only via
// promptForCompoundApproval).
//
// See src/extensions/permissions/index.ts handleCompoundConfirm: the
// `mode !== "tui"` check decides which branch fires; in ACP mode the
// single-card path covers the whole compound call so remembered rules
// are scoped to the suggested scope rather than each segment.

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

describe("ACP integration — compound bash permission", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "compound-permission",
			responses: [
				{ stream: ["hello", " from", " compound", " client."] },
				{
					toolCalls: [
						{
							function: {
								name: "bash",
								arguments: JSON.stringify({
									command: "echo a && touch /tmp/kimchi-acp-marker-compound.txt",
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

	it("issues a single permission card for compound bash in rpc mode (not per-subcommand)", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)

		// Turn 1: text-only response.
		const t1 = await prompt(fixture, sessionId, "Reply with the words: hello world")
		expect(t1.stopReason, "turn 1 stop reason").toBe("end_turn")
		expect(t1.chunks, "turn 1 agent text").toContain("compound")

		// Turn 2: compound bash (echo a && touch ...). `touch` is NOT in the
		// read-only allowlist so the compound call forces a permission card.
		const t2 = await prompt(
			fixture,
			sessionId,
			"Use the bash tool to run exactly `echo a && touch /tmp/kimchi-acp-marker-compound.txt` and reply with the word done",
		)
		expect(t2.stopReason, "turn 2 stop reason").toBe("end_turn")
		expect(t2.chunks, "turn 2 agent text contains tool output").toContain("done")

		// Filter to the compound tool call's permission request. The compound
		// command is the only thing with "&&" in the input.
		const compoundRequests = fixture.client.permissionRequests.filter((req) => {
			const toolCall = req.toolCall as { rawInput?: { command?: string } }
			return toolCall.rawInput?.command?.includes("&&") ?? false
		})

		// Single-card: exactly one permission request for the compound call.
		// TUI mode would issue 3 (parent + echo + touch); ACP mode collapses
		// them into one card.
		expect(compoundRequests.length, "single permission card for compound bash").toBe(1)

		// The single card carries the standard permission choice set so the
		// user can scope remembered rules to the compound call.
		const choiceKinds = compoundRequests[0].options.map((o) => o.kind)
		expect(choiceKinds, "permission card options").toEqual(
			expect.arrayContaining(["allow_once", "allow_always", "reject_once"]),
		)
	})
})
