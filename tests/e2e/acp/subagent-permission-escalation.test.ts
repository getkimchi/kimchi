// ACP integration — subagent classifier-outage escalation: a subagent has no
// prompt surface of its own, so when its classifier fails the permission
// card lands on the PARENT session as `session/request_permission`, naming
// the subagent in both the card title and `_meta["kimchi.dev"].subagent`.
// Approving runs the call; cancelling fails the call closed and closes the
// card with a failed status (the client never gets a tool_call stream for
// the child's call, so the prompter emits the closing update explicitly).
//
// Wiring notes (mirrors tests/e2e/acp/permission-classifier-outage.test.ts):
//   - `match` predicates reserve each script for its intended request —
//     interleaved classifier/title requests must not steal FIFO turns.
//   - `--auto` overrides the fixture's yolo env. The parent's live policy is
//     forwarded to each worker role instead of per-child mode env keys.

import type { ClientCapabilities, RequestPermissionRequest } from "@agentclientprotocol/sdk"
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

function findEscalatedRequest(fixture: AcpFixture): RequestPermissionRequest | undefined {
	return fixture.client.permissionRequests.filter((req) =>
		req.toolCall.title?.startsWith("Subagent General-Purpose: "),
	)[0]
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

			// The card was closed with a completed update for the same card id.
			const updates = fixture.client.sessionUpdates.filter((u) => u.sessionId === sessionId).map((u) => u.update)
			const closing = updates.find(
				(u) =>
					u.sessionUpdate === "tool_call_update" &&
					u.toolCallId === escalated?.toolCall.toolCallId &&
					u.status === "completed",
			)
			expect(closing, "card closed with completed status").toBeDefined()

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

			const updates = fixture.client.sessionUpdates.filter((u) => u.sessionId === sessionId).map((u) => u.update)
			const closing = updates.find(
				(u) =>
					u.sessionUpdate === "tool_call_update" &&
					u.toolCallId === escalated?.toolCall.toolCallId &&
					u.status === "completed",
			)
			expect(closing, "approved non-safe card closed with completed status").toBeDefined()
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

			const updates = fixture.client.sessionUpdates.filter((u) => u.sessionId === sessionId).map((u) => u.update)
			const closing = updates.find(
				(u) =>
					u.sessionUpdate === "tool_call_update" &&
					u.toolCallId === escalated?.toolCall.toolCallId &&
					u.status === "failed",
			)
			expect(closing, "card closed with failed status").toBeDefined()
		})
	})
})
