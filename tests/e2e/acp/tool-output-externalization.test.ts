// ACP integration: externalized tool results never leak raw markers to the client.
//
// Tool results ≥ 64 KiB are externalized to a disk mirror and the in-memory
// message carries a compact `[kimchi-ext:tool]{...}` marker (memory
// residency). The ACP surface must resolve markers before forwarding content
// (toolResultContent), so the client always sees the real tool output — this
// test drives a real binary end-to-end and asserts on the wire shape.

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

/** The big-output command the fake model asks bash to run (~70 KiB of output). */
const BIG_OUTPUT_COMMAND = "yes kimchi-e2e-big-output | head -c 70000"

describe("ACP integration — externalized tool results", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "tool-output-externalization",
			responses: [
				{
					stream: ["Running the big output command."],
					toolCalls: [
						{
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: BIG_OUTPUT_COMMAND }),
							},
						},
					],
				},
			],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("never sends raw marker text to the client and forwards the real output", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		const result = await prompt(fixture, sessionId, "Run the big output command")
		expect(result.stopReason, "turn stop reason").toBe("end_turn")

		const updates = fixture.client.sessionUpdates.filter((u) => u.sessionId === sessionId)
		expect(updates.length, "session updates received").toBeGreaterThan(0)

		// No frame the client received may contain the marker text.
		const wire = JSON.stringify(updates)
		expect(wire).not.toContain("[kimchi-ext:tool]")
		expect(wire).not.toContain("[kimchi-ext:log]")

		// The completed tool call update carries the actual (big) output text.
		const toolCallUpdates = updates.filter(
			(u) => u.update.sessionUpdate === "tool_call_update" && !u.update._meta?.hidden,
		)
		const completed = toolCallUpdates.filter(
			(u) =>
				(u.update as { status?: string }).status === "completed" ||
				(u.update as { content?: unknown }).content !== undefined,
		)
		expect(completed.length, "completed tool call updates").toBeGreaterThanOrEqual(1)
		const content = JSON.stringify(completed)
		expect(content).toContain("kimchi-e2e-big-output")
	})
})
