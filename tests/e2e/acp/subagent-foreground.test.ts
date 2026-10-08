// ACP integration — subagents run foreground by default.
//
// Regression guard: ACP sessions report hasUI true, so they were swept into
// the background-by-default bucket — the turn ended right after the spawn and
// ACP clients (Studio, vscode extension) never saw progress or the result.
// The Agent tool must default to foreground in rpc mode: the tool call stays
// in_progress while the subagent runs, completes with its result inline, and
// the orchestrator continuation carries the subagent output in the SAME turn.

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt, waitForSessionUpdate } from "./support/scenarios.js"

const SUBAGENT_MARKER = "SUBAGENT-OUTPUT-MARKER"

describe("ACP integration — subagent foreground default", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "subagent-foreground",
			// Match predicates reserve each script for its intended request — the
			// session-title namer fires interleaved requests on the same fake
			// server and would otherwise steal the FIFO-ordered responses.
			responses: [
				{
					toolCalls: [
						{
							function: {
								name: "Agent",
								arguments: JSON.stringify({
									prompt: "look around and report",
									description: "explore the repo",
									subagent_type: "general-purpose",
								}),
							},
						},
					],
				},
				// Orchestrator continuation: carries the subagent's tool result.
				{
					match: (req) => JSON.stringify(req.body ?? {}).includes(SUBAGENT_MARKER),
					stream: ["Orchestrator wrapping up."],
				},
				// The subagent's own request (system prompt identifies it).
				{
					forSubagent: true,
					match: (req) => JSON.stringify(req.body ?? {}).includes("sub-agent"),
					stream: [SUBAGENT_MARKER],
				},
			],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("runs the subagent in foreground and returns its result before the turn ends", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)

		const result = await prompt(fixture, sessionId, "delegate to an agent")
		expect(result.stopReason, "turn stop reason").toBe("end_turn")

		// The Agent tool call surfaced to the client with its kind and title
		// derived from the tool args (kind "think", title from `description`).
		const toolCall = await waitForSessionUpdate(
			fixture,
			sessionId,
			(u) => u.sessionUpdate === "tool_call" && u.kind === "think",
		)
		expect(toolCall).toMatchObject({ sessionUpdate: "tool_call", kind: "think", title: "explore the repo" })

		// In foreground mode the tool call reaches "completed" while the turn
		// is still open — a backgrounded spawn would jump straight to a result
		// message and the subagent's work would be invisible to the client.
		const toolCallId = toolCall.sessionUpdate === "tool_call" ? toolCall.toolCallId : ""
		const updates = fixture.client.sessionUpdates.filter((u) => u.sessionId === sessionId).map((u) => u.update)
		const completedIdx = updates.findIndex(
			(u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === toolCallId && u.status === "completed",
		)
		expect(completedIdx, "Agent tool_call_update with status completed").toBeGreaterThanOrEqual(0)

		// The subagent actually made its own LLM call, and its output flowed
		// back into the orchestrator continuation in the same turn: some request
		// after the spawn carries the tool result containing the marker.
		// Only chat-completions requests carry a body; telemetry (GET /v1/me) is body-less.
		const bodies = fixture.fake.requests.map((r) => JSON.stringify(r.body ?? {}))
		const chatBodies = bodies.filter((b) => b.includes("messages"))
		const subagentIdx = chatBodies.findIndex((b) => b.includes("sub-agent"))
		expect(subagentIdx, "subagent made its own LLM request").toBeGreaterThanOrEqual(0)
		const continuation = chatBodies.find((b, i) => i !== subagentIdx && b.includes(SUBAGENT_MARKER))
		expect(continuation, "orchestrator continuation carries subagent result").toBeDefined()

		// Turn completes with the orchestrator's scripted wrap-up.
		expect(result.chunks).toContain("Orchestrator wrapping up.")
	})
})
