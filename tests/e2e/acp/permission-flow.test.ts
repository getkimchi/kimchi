// ACP integration: tool-call permission flows routed through the ACP prompter.
//
// Both scenarios below drive `requestPermission` via the ACP prompter and
// assert on the resulting wire shape. They share enough scaffolding (full
// capabilities, scripted bash tool calls, permission request assertions) that
// keeping them in one file is simpler than two near-identical setups.
//
// Scenarios:
//   1. Compound bash collapses to a single permission card in rpc mode
//      (handleCompoundConfirm's single-card branch — TUI uses per-subcommand
//      pickers; ACP cannot).
//   2. Rejecting a permission opens an elicitation dialog to collect free-text
//      feedback, which surfaces in the agent's tool result as a blocked reason
//      (acp-prompter's deny branch → uiContext.input → unstable_createElicitation).
//
// See:
//   - src/extensions/permissions/index.ts (handleCompoundConfirm + applyApprovalOutcome)
//   - src/modes/acp/acp-prompter.ts (deny branch + uiContext.input)
//   - src/modes/acp/acp-ui-context.ts (input → unstable_createElicitation)

import type { ClientCapabilities } from "@agentclientprotocol/sdk"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ADVERTISED_CAPABILITIES } from "../../../src/modes/acp/capabilities.js"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

const FULL_CAPABILITIES: ClientCapabilities = {
	fs: { readTextFile: false, writeTextFile: false },
	elicitation: { form: {} },
}

const PI_META = { "kimchi.dev": { ...ADVERTISED_CAPABILITIES } } as const

const FEEDBACK_TEXT = "Please don't touch that file — use the editor tool instead."

describe("ACP integration — permission flow", () => {
	describe("compound bash in rpc mode", () => {
		let fixture: AcpFixture

		beforeEach(async () => {
			fixture = await startAcpFixture({
				artifactName: "permission-flow-compound",
				responses: [
					{ stream: ["hello", " from", " compound", " client."] },
					{
						stream: ["I'll run that command."],
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

		it("issues a single permission card for compound bash (not per-subcommand)", async () => {
			const sessionId = await newSession(fixture, fixture.workDir)

			// Turn 1: text-only response.
			const t1 = await prompt(fixture, sessionId, "Reply with the words: hello world")
			expect(t1.stopReason, "turn 1 stop reason").toBe("end_turn")
			expect(t1.chunks, "turn 1 agent text").toContain("compound")

			// Turn 2: compound bash (echo a && touch ...). `touch` is NOT in
			// the read-only allowlist so the compound call forces a permission
			// card.
			const t2 = await prompt(
				fixture,
				sessionId,
				"Use the bash tool to run exactly `echo a && touch /tmp/kimchi-acp-marker-compound.txt` and reply with the word done",
			)
			expect(t2.stopReason, "turn 2 stop reason").toBe("end_turn")
			expect(t2.chunks, "turn 2 agent text contains tool output").toContain("done")

			// Filter to the compound tool call's permission request. The
			// compound command is the only thing with "&&" in the input.
			const compoundRequests = fixture.client.permissionRequests.filter((req) => {
				const toolCall = req.toolCall as { rawInput?: { command?: string } }
				return toolCall.rawInput?.command?.includes("&&") ?? false
			})

			// Single-card: exactly one permission request for the compound
			// call. TUI mode would issue 3 (parent + echo + touch); ACP mode
			// collapses them into one card so remembered rules are scoped to
			// the suggested rule rather than each segment.
			expect(compoundRequests.length, "single permission card for compound bash").toBe(1)

			// The single card carries the standard permission choice set.
			const choiceKinds = compoundRequests[0].options.map((o) => o.kind)
			expect(choiceKinds, "permission card options").toEqual(
				expect.arrayContaining(["allow_once", "allow_always", "reject_once"]),
			)
		})
	})

	describe("deny-with-feedback", () => {
		let fixture: AcpFixture

		beforeEach(async () => {
			fixture = await startAcpFixture({
				artifactName: "permission-flow-deny-feedback",
				responses: [
					{ stream: ["sure,", " denying", " now."] },
					{
						stream: ["I'll run that command."],
						toolCalls: [
							{
								function: {
									name: "bash",
									arguments: JSON.stringify({
										command: "touch /tmp/kimchi-acp-marker-deny.txt",
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

		it("collects free-text feedback via elicitation when the user rejects a permission", async () => {
			// Stage the wire responses BEFORE the agent fires the tool call:
			// 1. requestPermission → return the reject_once option
			// 2. unstable_createElicitation → return the feedback text
			fixture.client.answerNextPermissionWith({ kind: "reject_once" })
			fixture.client.answerNextElicitationWith({
				action: "accept",
				content: { value: FEEDBACK_TEXT },
			})

			const sessionId = await newSession(fixture, fixture.workDir)

			// Turn 1: baseline text reply so the agent transcript is established.
			const t1 = await prompt(fixture, sessionId, "Reply with the words: hello world")
			expect(t1.stopReason, "turn 1 stop reason").toBe("end_turn")

			// Turn 2: trigger a bash tool that needs permission. The agent
			// script will request permission, get denied, see the feedback,
			// then send a final "done" stream.
			const t2 = await prompt(
				fixture,
				sessionId,
				"Use the bash tool to run exactly `touch /tmp/kimchi-acp-marker-deny.txt` and reply with the word done",
			)
			expect(t2.stopReason, "turn 2 stop reason").toBe("end_turn")

			// Exactly one request_permission call. The reject_once option is
			// among the choices offered to the client.
			expect(fixture.client.permissionRequests.length, "request_permission call count").toBe(1)
			const req = fixture.client.permissionRequests[0]
			const rejectOption = req.options.find((o) => o.kind === "reject_once")
			expect(rejectOption, "reject_once option exists").toBeDefined()
			expect(rejectOption?.name, "reject_once option label").toMatch(/tell the assistant/i)

			// Exactly one elicitation dialog — the feedback prompt the
			// prompter opened via uiContext.input. The schema is the input
			// shape (single `value` string field). `description` is omitted
			// from the wire because the caller passed no placeholder
			// (`acp-prompter.ts` calls input(title) without a second arg,
			// and undefined fields are stripped during JSON serialization).
			expect(fixture.client.elicitationRequests.length, "elicitation call count").toBe(1)
			const elicitation = fixture.client.elicitationRequests[0]
			expect(elicitation.method).toBe("elicitation/create")
			const elicitParams = elicitation.params as {
				sessionId: string
				message: string
				requestedSchema: { type: string; properties: Record<string, unknown>; required: string[] }
			}
			expect(elicitParams.requestedSchema).toEqual({
				type: "object",
				properties: {
					value: { type: "string" },
				},
				required: ["value"],
			})

			// The tool was blocked; the failed tool_call_update carries the
			// user feedback in its content so the agent sees what the user
			// said. The wire shape is `update.content[0].content.text`
			// (a nested content block, not a flat text block).
			const failedUpdate = fixture.client.sessionUpdates.find(
				(u) =>
					u.sessionId === sessionId &&
					u.update.sessionUpdate === "tool_call_update" &&
					(u.update as { status?: string }).status === "failed",
			)
			expect(failedUpdate, "failed tool_call_update emitted").toBeDefined()
			const updateText = blockedReasonText(failedUpdate?.update)
			expect(updateText, "blocked reason surfaces the user feedback").toContain(FEEDBACK_TEXT)
			expect(updateText, "blocked reason names the decline").toMatch(/declined/i)
		})
	})
})

/** Extract concatenated text from a tool_call_update content field. */
function textOf(content: unknown): string {
	if (!Array.isArray(content)) return ""
	return content
		.filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "text")
		.map((c) => (c as { text?: string }).text ?? "")
		.join("")
}

/**
 * Extract the blocked-reason text from a failed tool_call_update. The shape is
 * `update.content[0].content.text` (a nested content block), not the flatter
 * agent_message_chunk shape used elsewhere.
 */
function blockedReasonText(update: unknown): string {
	if (!update || typeof update !== "object") return ""
	const content = (update as { content?: unknown }).content
	if (!Array.isArray(content)) return ""
	return content
		.filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "content")
		.map((c) => (c as { content?: { text?: string } }).content?.text ?? "")
		.join("")
}
