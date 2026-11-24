// ACP integration — subagent classifier-outage escalation: a subagent has no
// prompt surface of its own, so when its classifier fails the permission
// card lands on the PARENT session as `session/request_permission`, naming
// the subagent in both the card title and `_meta["kimchi.dev"].subagent`.
// Approving runs the call; cancelling fails the call closed. The client never
// gets a tool_call stream for the child's call, so the card's status is sent
// from what happens to the call itself: in_progress when an allowed call
// starts, completed or failed when it has ended, failed when it never runs.
//
// Wiring notes (mirrors tests/e2e/acp/permission-classifier-outage.test.ts):
//   - `match` predicates reserve each script for its intended request —
//     interleaved classifier/title requests must not steal FIFO turns.
//   - `--auto` overrides the fixture's yolo env. The parent's live policy is
//     forwarded to each worker role instead of per-child mode env keys.

import { existsSync } from "node:fs"
import { join } from "node:path"
import type { ClientCapabilities, RequestPermissionRequest } from "@agentclientprotocol/sdk/unstable"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt, waitForSessionUpdate } from "./support/scenarios.js"

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

const AGENT_CALL = {
	function: {
		name: "Agent",
		arguments: JSON.stringify({
			prompt: "use the write tool to create output.txt containing hello world",
			description: "write the file",
			subagent_type: "general-purpose",
		}),
	},
}

function bodyIncludes(needle: string) {
	return (request: { body: unknown }) => JSON.stringify(request.body ?? {}).includes(needle)
}

const TURN_SCRIPTS = {
	parentTurn1: {
		match: bodyIncludes("delegate a file write"),
		stream: ["Delegating."],
		toolCalls: [AGENT_CALL],
	},
	childTurn1: {
		match: bodyIncludes("hello world"),
		stream: ["Writing."],
		toolCalls: [{ function: { name: "write", arguments: WRITE_ARGS } }],
	},
}

/** The child's first turn, for any request that is not the classifier's. */
const CHILD_WRITE_TURN = {
	...TURN_SCRIPTS.childTurn1,
	match: (request: { body: unknown }) => !isClassifierRequest(request.body) && bodyIncludes("hello world")(request),
}

function escalatedRequests(fixture: AcpFixture): RequestPermissionRequest[] {
	return fixture.client.permissionRequests.filter((req) => req.toolCall.title?.startsWith("Subagent General-Purpose: "))
}

function findEscalatedRequest(fixture: AcpFixture): RequestPermissionRequest | undefined {
	return escalatedRequests(fixture)[0]
}

/** Every status the client was sent for one card, in wire order. */
function cardStatuses(fixture: AcpFixture, sessionId: string, toolCallId: string | undefined): string[] {
	return fixture.client.sessionUpdates
		.filter((u) => u.sessionId === sessionId)
		.map((u) => u.update)
		.filter((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === toolCallId)
		.map((u) => String((u as { status?: unknown }).status))
}

describe("ACP integration — subagent escalated permission card", () => {
	describe("client approves", () => {
		let fixture: AcpFixture

		beforeEach(async () => {
			fixture = await startAcpFixture({
				artifactName: "subagent-permission-escalation-allow",
				providerId: "kimchi-dev",
				defaultProvider: "kimchi-dev",
				defaultModel: "basic",
				models: [MAIN_MODEL, CLASSIFIER_MODEL],
				extraArgs: ["--auto"],
				clientCapabilities: FULL_CAPABILITIES,
				clientMeta: { "kimchi.dev": { pi_notify: true } },
				responses: [
					TURN_SCRIPTS.parentTurn1,
					TURN_SCRIPTS.childTurn1,
					...CLASSIFIER_ERROR_SCRIPTS,
					{ match: bodyIncludes("Successfully wrote"), stream: ["The file is in place."] },
					{ match: bodyIncludes("The file is in place"), stream: ["Done — the subagent wrote it."] },
				],
			})
		}, STARTUP_TIMEOUT_MS)

		afterEach(async () => {
			await fixture.stop()
		})

		it("names the subagent on the parent's card and runs the call when approved", async () => {
			const sessionId = await newSession(fixture, fixture.workDir)
			const turn = await prompt(fixture, sessionId, "delegate a file write to a subagent")
			expect(turn.stopReason, "turn completes after approval").toBe("end_turn")
			expect(turn.chunks).toContain("Done — the subagent wrote it.")

			const escalated = findEscalatedRequest(fixture)
			expect(escalated, "escalated permission request").toBeDefined()
			expect(escalated?.toolCall._meta?.["kimchi.dev"]).toMatchObject({
				subagent: { persona: "General-Purpose", agentId: expect.any(String) },
			})
			// Remember choices are subagent-scoped: the rule lands in the worker's
			// session memory, so the labels say so.
			expect(escalated?.options.some((option) => option.name.includes("for this subagent"))).toBe(true)

			// Approving is not completing: the card moves to in_progress when the
			// child starts the call and to completed only after the write succeeded.
			const updates = fixture.client.sessionUpdates.filter((u) => u.sessionId === sessionId).map((u) => u.update)
			expect(cardStatuses(fixture, sessionId, escalated?.toolCall.toolCallId), "card follows the call").toEqual([
				"in_progress",
				"completed",
			])
			expect(existsSync(join(fixture.workDir, "output.txt")), "the approved write ran").toBe(true)

			// The outage never leaks provider text onto the wire. This path sends
			// no pi_notify, so the permission request and the session updates are
			// what has to be read; the notification check stays for the day it does.
			expect(
				JSON.stringify(fixture.client.permissionRequests),
				"no provider diagnostic in permission requests",
			).not.toContain(CLASSIFIER_ERROR)
			expect(JSON.stringify(updates), "no provider diagnostic in session updates").not.toContain(CLASSIFIER_ERROR)
			const notifyMessages = fixture.client.extNotifications
				.filter((n) => n.method === "_kimchi.dev/pi_notify")
				.map((n) => (n.params as { message?: string }).message ?? "")
			for (const message of notifyMessages) {
				expect(message, "no provider diagnostic in notifications").not.toContain(CLASSIFIER_ERROR)
			}
		})
	})

	describe("classifier requires confirmation", () => {
		let fixture: AcpFixture

		beforeEach(async () => {
			fixture = await startAcpFixture({
				artifactName: "subagent-permission-requires-confirmation",
				providerId: "kimchi-dev",
				defaultProvider: "kimchi-dev",
				defaultModel: "basic",
				models: [MAIN_MODEL, CLASSIFIER_MODEL],
				extraArgs: ["--auto"],
				clientCapabilities: FULL_CAPABILITIES,
				clientMeta: { "kimchi.dev": { pi_notify: true } },
				responses: [
					TURN_SCRIPTS.parentTurn1,
					TURN_SCRIPTS.childTurn1,
					{
						match: (request) => isClassifierRequest(request.body),
						stream: [
							'{"verdict":"requires-confirmation","reason":"This writes a new file to disk","riskScore":"high"}',
						],
					},
					{ match: bodyIncludes("Successfully wrote"), stream: ["The file is in place."] },
					{ match: bodyIncludes("The file is in place"), stream: ["Done — the subagent wrote it."] },
				],
			})
		}, STARTUP_TIMEOUT_MS)

		afterEach(async () => {
			await fixture.stop()
		})

		it("asks after classifying, then runs and closes the approved call", async () => {
			const sessionId = await newSession(fixture, fixture.workDir)
			const turn = await prompt(fixture, sessionId, "delegate a file write to a subagent")
			expect(turn.stopReason).toBe("end_turn")
			expect(turn.chunks).toContain("Done — the subagent wrote it.")
			expect(fixture.fake.requests.filter((req) => isClassifierRequest(req.body))).toHaveLength(1)

			const escalated = findEscalatedRequest(fixture)
			expect(escalated, "non-safe verdict escalates to a named parent card").toBeDefined()
			expect(escalated?.toolCall._meta?.["kimchi.dev"]).toMatchObject({
				subagent: { persona: "General-Purpose", agentId: expect.any(String) },
			})

			expect(cardStatuses(fixture, sessionId, escalated?.toolCall.toolCallId), "card follows the call").toEqual([
				"in_progress",
				"completed",
			])
		})
	})

	describe("client cancels", () => {
		let fixture: AcpFixture

		beforeEach(async () => {
			fixture = await startAcpFixture({
				artifactName: "subagent-permission-escalation-cancel",
				providerId: "kimchi-dev",
				defaultProvider: "kimchi-dev",
				defaultModel: "basic",
				models: [MAIN_MODEL, CLASSIFIER_MODEL],
				extraArgs: ["--auto"],
				clientCapabilities: FULL_CAPABILITIES,
				clientMeta: { "kimchi.dev": { pi_notify: true } },
				responses: [
					TURN_SCRIPTS.parentTurn1,
					TURN_SCRIPTS.childTurn1,
					...CLASSIFIER_ERROR_SCRIPTS,
					// A cancelled card => route failure => the fail-closed block reason
					// (the child's model reads this in its tool result).
					{
						match: bodyIncludes("Blocked: the permission classifier is temporarily unavailable"),
						stream: ["The call was declined."],
					},
					{ match: bodyIncludes("The call was declined"), stream: ["The subagent was denied."] },
				],
			})
		}, STARTUP_TIMEOUT_MS)

		afterEach(async () => {
			await fixture.stop()
		})

		it("fails the call closed and closes the card with a failed status", async () => {
			fixture.client.answerNextPermissionWith({ outcome: { outcome: "cancelled" } })
			const sessionId = await newSession(fixture, fixture.workDir)
			const turn = await prompt(fixture, sessionId, "delegate a file write to a subagent")
			expect(turn.stopReason, "turn completes after the cancel").toBe("end_turn")
			expect(turn.chunks).toContain("The subagent was denied.")

			const escalated = findEscalatedRequest(fixture)
			expect(escalated, "escalated permission request").toBeDefined()

			// The call never ran: one final status, and never in_progress.
			expect(cardStatuses(fixture, sessionId, escalated?.toolCall.toolCallId), "card closed as failed").toEqual([
				"failed",
			])
			expect(existsSync(join(fixture.workDir, "output.txt")), "nothing was written").toBe(false)
		})
	})

	// session/cancel for the parent's turn while the card is still open. The
	// client answers its open request with `cancelled`, as the protocol asks.
	describe("client cancels the turn while the card is open", () => {
		let fixture: AcpFixture

		beforeEach(async () => {
			fixture = await startAcpFixture({
				artifactName: "subagent-permission-escalation-turn-cancel",
				providerId: "kimchi-dev",
				defaultProvider: "kimchi-dev",
				defaultModel: "basic",
				models: [MAIN_MODEL, CLASSIFIER_MODEL],
				extraArgs: ["--auto"],
				clientCapabilities: FULL_CAPABILITIES,
				clientMeta: { "kimchi.dev": { pi_notify: true } },
				responses: [
					TURN_SCRIPTS.parentTurn1,
					// The second turn's history still holds the first prompt and the
					// first Agent call, so its script has to come before the scripts
					// those texts would match.
					{ match: bodyIncludes("delegate it once more"), stream: ["Delegating again."], toolCalls: [AGENT_CALL] },
					// One per subagent. The classifier's request quotes the write it
					// judges, "hello world" included, and must not take the second
					// subagent's script while it is still waiting in the queue.
					CHILD_WRITE_TURN,
					CHILD_WRITE_TURN,
					...CLASSIFIER_ERROR_SCRIPTS,
					...CLASSIFIER_ERROR_SCRIPTS,
					{ match: bodyIncludes("Successfully wrote"), stream: ["The file is in place."] },
					{ match: bodyIncludes("The file is in place"), stream: ["Done — the subagent wrote it."] },
				],
			})
		}, STARTUP_TIMEOUT_MS)

		afterEach(async () => {
			await fixture.stop()
		})

		it("ends the turn as cancelled, runs nothing, settles the card once and leaves the session usable", async () => {
			const held = fixture.client.holdNextPermission()
			const sessionId = await newSession(fixture, fixture.workDir)
			const turn = prompt(fixture, sessionId, "delegate a file write to a subagent")
			const card = await held.received
			expect(card.toolCall.title, "the open card is the subagent's").toMatch(/^Subagent General-Purpose: /)

			await fixture.conn.notify("session/cancel", { sessionId })
			held.respond({ outcome: { outcome: "cancelled" } })

			expect((await turn).stopReason, "the parent's turn ends as cancelled").toBe("cancelled")
			await waitForSessionUpdate(
				fixture,
				sessionId,
				(u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === card.toolCall.toolCallId,
			)
			expect(existsSync(join(fixture.workDir, "output.txt")), "the child did not run the write").toBe(false)
			expect(escalatedRequests(fixture), "the call is not asked about a second time").toHaveLength(1)
			expect(cardStatuses(fixture, sessionId, card.toolCall.toolCallId), "one final status, never run").toEqual([
				"failed",
			])

			// Nothing is left behind: the next subagent call gets a card of its
			// own, and that card follows its call to the end.
			const again = await prompt(fixture, sessionId, "delegate it once more")
			expect(again.stopReason, "the session still works").toBe("end_turn")
			expect(again.chunks).toContain("Done — the subagent wrote it.")
			const [, second] = escalatedRequests(fixture)
			expect(second, "second escalated request").toBeDefined()
			expect(second?.toolCall.toolCallId, "a card of its own").not.toBe(card.toolCall.toolCallId)
			expect(cardStatuses(fixture, sessionId, second?.toolCall.toolCallId)).toEqual(["in_progress", "completed"])
			expect(existsSync(join(fixture.workDir, "output.txt")), "the approved write ran").toBe(true)
			// The cancelled card got nothing more after its final status.
			expect(cardStatuses(fixture, sessionId, card.toolCall.toolCallId)).toEqual(["failed"])
		})
	})
})
