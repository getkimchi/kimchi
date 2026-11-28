// ACP integration: externalized tool results never leak raw markers to the client.
//
// Tool results ≥ 64 KiB are externalized to a disk mirror and the in-memory
// message carries a compact `[kimchi-ext:tool]{...}` marker (memory
// residency). The ACP surface must resolve markers before forwarding content
// (toolResultContent), so the client always sees the real tool output — this
// test drives a real binary end-to-end and asserts on the wire shape.

import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { chatRequests } from "../tui/support/wire-requests.js"
import { type AcpFixture, PROMPT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"
import { LARGE_TOOL_TEXT } from "./support/test-large-nested-tool-extension.js"

const LARGE_NESTED_TOOL_EXTENSION = fileURLToPath(
	new URL("./support/test-large-nested-tool-extension.js", import.meta.url),
)

/** The big-output command the fake model asks bash to run (~70 KiB of output). */
const BIG_OUTPUT_COMMAND = "yes kimchi-e2e-big-output | head -c 70000"

const NESTED_CODEMODE_SCRIPT = [
	"// @description: Inspect >64 KiB plain and structured nested tool outputs",
	"const out = await tools.big_text({});",
	"const structured = await tools.big_structured({});",
	"return JSON.stringify({",
	"  type: typeof out,",
	"  length: out.length,",
	"  head: out.slice(0, 48),",
	'  alphaLines: out.split("\\n").filter((l) => l.startsWith("alpha")).length,',
	"  structuredType: typeof structured,",
	"  structuredLength: structured && typeof structured === 'object' && typeof structured.text === 'string' ? structured.text.length : null,",
	"});",
].join("\n")

const OUTER_CODEMODE_SCRIPT = [
	'// @options: {"max_output_tokens": 50000}',
	"// @description: Return >64 KiB text from codemode itself",
	"return await tools.big_text({});",
].join("\n")

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

function toolMessageText(fixture: AcpFixture, toolCallId: string): string {
	for (const req of chatRequests(fixture)) {
		const messages = (req.body as { messages?: Array<{ role?: string; tool_call_id?: string; content?: unknown }> })
			?.messages
		const match = messages?.find((m) => m.role === "tool" && m.tool_call_id === toolCallId)
		if (match === undefined) continue
		if (typeof match.content === "string") return match.content
		if (Array.isArray(match.content)) {
			return match.content
				.map((part) => (typeof part === "object" && part !== null && "text" in part ? String(part.text) : ""))
				.join("")
		}
	}
	throw new Error(`missing tool message for ${toolCallId}`)
}

describe("ACP integration — codemode nested >64 KiB tool results", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "codemode-large-tool-result",
			extensionPath: LARGE_NESTED_TOOL_EXTENSION,
			responses: [
				{
					toolCalls: [
						{
							id: "cm-nested",
							function: { name: "codemode", arguments: JSON.stringify({ code: NESTED_CODEMODE_SCRIPT }) },
						},
					],
				},
				{ stream: ["Nested codemode complete."] },
				{
					toolCalls: [
						{
							id: "cm-outer",
							function: { name: "codemode", arguments: JSON.stringify({ code: OUTER_CODEMODE_SCRIPT }) },
						},
					],
				},
				{ stream: ["Outer codemode complete."] },
			],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it(
		"passes >64 KiB plain and structured nested results to codemode while still externalizing outer results",
		async () => {
			const sessionId = await newSession(fixture, fixture.workDir)

			const nestedTurn = await prompt(fixture, sessionId, "Run nested large tool codemode")
			expect(nestedTurn.stopReason).toBe("end_turn")

			const nestedContent = toolMessageText(fixture, "cm-nested")
			const summaryMatch = nestedContent.match(/\{[\s\S]*\}/)
			expect(summaryMatch, `expected JSON summary in ${nestedContent}`).toBeTruthy()
			const summary = JSON.parse(summaryMatch?.[0] ?? "{}") as {
				type?: string
				length?: number
				head?: string
				alphaLines?: number
				structuredType?: string
				structuredLength?: number | null
			}
			const expectedAlphaLines = LARGE_TOOL_TEXT.split("\n").filter((l) => l.startsWith("alpha")).length
			expect(LARGE_TOOL_TEXT.length).toBeGreaterThan(64 * 1024)
			expect(summary).toEqual({
				type: "string",
				length: LARGE_TOOL_TEXT.length,
				head: LARGE_TOOL_TEXT.slice(0, 48),
				alphaLines: expectedAlphaLines,
				structuredType: "object",
				structuredLength: LARGE_TOOL_TEXT.length,
			})

			// Outer codemode returning >64 KiB still gets externalized cleanly:
			// no raw marker reaches the ACP wire, and the provider receives the
			// full hydrated output on the follow-up request.
			const outerTurn = await prompt(fixture, sessionId, "Return >64 KiB directly from codemode")
			expect(outerTurn.stopReason).toBe("end_turn")

			const wire = JSON.stringify(fixture.client.sessionUpdates.filter((u) => u.sessionId === sessionId))
			expect(wire).not.toContain("[kimchi-ext:tool]")
			expect(wire).not.toContain("[kimchi-ext:log]")

			const lines = LARGE_TOOL_TEXT.split("\n")
			const outerContent = toolMessageText(fixture, "cm-outer")
			expect(outerContent).toContain(lines[0])
			expect(outerContent).toContain(lines[lines.length - 1])
			expect(outerContent).not.toContain("[kimchi-ext:tool]")
		},
		PROMPT_TIMEOUT_MS * 3,
	)
})
