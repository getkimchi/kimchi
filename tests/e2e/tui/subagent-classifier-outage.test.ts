/**
 * E2E TUI test for subagent classifier-outage escalation: a subagent cannot
 * prompt in its own session, so when the classifier fails on a call the
 * subagent made, the permission prompt opens in the MAIN session, names the
 * subagent, and the user decides for it. Allow runs the call; Escape denies
 * it (the cancelled select settles as a deny) and the subagent's model learns
 * the call was declined.
 *
 * Key wiring notes:
 *   - Classifier requests are identified by the classifier's system prompt;
 *     `--auto` overrides the fixture's yolo env. The parent's live mode and
 *     rules are forwarded to each worker role rather than per-child mode
 *     environment keys.
 *   - The non-classifier queue order is: parent turn 1 (Agent tool call) →
 *     child turn 1 (write tool call) → child turn 2 (after the decision) →
 *     parent turn 2 (Agent result). Agent calls are allow-listed, so only
 *     the child's write is classifier-gated.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

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
const ORIGIN_LINE = "Subagent General-Purpose — write the file wants to run:"
const ESCALATED_SUBTITLE = "this subagent's call needs your approval"
const ALLOW_PROMPT = "Allow the assistant to run this?"
/** What the subagent's model reads in its tool result after Escape. */
const DECLINED_RESULT = "Declined by user"

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

const AGENT_CALL = {
	function: {
		name: "Agent",
		arguments: JSON.stringify({
			prompt: "Use the write tool to create output.txt containing: hello world",
			description: "write the file",
			subagent_type: "General-Purpose",
			run_in_background: false,
		}),
	},
}

/** Tool-call arguments for a `write` to output.txt — a non-read-only file write. */
const WRITE_ARGS = JSON.stringify({ path: "output.txt", content: "hello world" })

function bodyIncludes(needle: string) {
	return (request: { body: unknown }) => JSON.stringify(request.body ?? {}).includes(needle)
}

function bufferText(terminal: { getBuffer: () => string[][] }): string {
	return terminal
		.getBuffer()
		.map((row: string[]) => row.join(""))
		.join("\n")
}

test("escalated prompt names the subagent in the main session; approving runs the call", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "subagent-classifier-outage-allow",
			providerId: "kimchi-dev",
			extraArgs: ["--auto"],
			models: [MAIN_MODEL, CLASSIFIER_MODEL],
			responses: [
				{ stream: ["Let me delegate that."], toolCalls: [AGENT_CALL] },
				{ stream: ["I'll create the file."], toolCalls: [{ function: { name: "write", arguments: WRITE_ARGS } }] },
				...CLASSIFIER_ERROR_SCRIPTS,
				{ stream: ["The file was written."] },
				{ stream: ["The subagent wrote the file."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Have a subagent write a file called output.txt")
			trace.step("submitted user prompt")

			// The escalated prompt carries the subagent identity, the outage copy,
			// and the "for this subagent" remember labels — in the MAIN session.
			await waitForText(terminal, ORIGIN_LINE, { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, ESCALATED_SUBTITLE, { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, ALLOW_PROMPT, { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "for this subagent", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("escalated prompt with subagent identity visible")

			expect(bufferText(terminal)).not.toContain(CLASSIFIER_ERROR)
			trace.step("no provider diagnostic in terminal buffer")

			const classifierRequests = fixture.fake.requests.filter((req) => isClassifierRequest(req.body))
			expect(classifierRequests.length).toBeGreaterThanOrEqual(1)
			trace.step(`classifier made ${classifierRequests.length} failing request(s)`)

			// Enter selects "Yes — just this call" first, matching the main session.
			await new Promise((resolve) => setTimeout(resolve, 500))
			terminal.submit("")
			await waitForText(terminal, "The subagent wrote the file.", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(existsSync(join(fixture.workDir, "output.txt"))).toBe(true)
			trace.step("approved — subagent completed, the parent continued, and the file exists")
		},
	)
})

test("requires-confirmation asks with the classifier reason and risk before allowing the write", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "subagent-classifier-requires-confirmation",
			providerId: "kimchi-dev",
			extraArgs: ["--auto"],
			models: [MAIN_MODEL, CLASSIFIER_MODEL],
			responses: [
				{ stream: ["Let me delegate that."], toolCalls: [AGENT_CALL] },
				{ stream: ["I'll create the file."], toolCalls: [{ function: { name: "write", arguments: WRITE_ARGS } }] },
				{
					match: (request: { body: unknown }) => isClassifierRequest(request.body),
					stream: ['{"verdict":"requires-confirmation","reason":"This writes a new file to disk","riskScore":"high"}'],
				},
				{ stream: ["The file was written."] },
				{ stream: ["The subagent wrote the file."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Have a subagent write a file called output.txt")
			trace.step("submitted user prompt")

			await waitForText(terminal, ORIGIN_LINE, { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "This writes a new file to disk", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "high risk", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("task identity, classifier reason, and risk visible")

			const classifierRequests = fixture.fake.requests.filter((req) => isClassifierRequest(req.body))
			expect(classifierRequests).toHaveLength(1)
			trace.step("classifier ran once before the escalation")

			await new Promise((resolve) => setTimeout(resolve, 500))
			terminal.submit("")
			await waitForText(terminal, "The subagent wrote the file.", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(existsSync(join(fixture.workDir, "output.txt"))).toBe(true)
			trace.step("approved non-safe write completed on disk")
		},
	)
})

test("escaping the escalated prompt denies the subagent's call", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "subagent-classifier-outage-deny",
			providerId: "kimchi-dev",
			extraArgs: ["--auto"],
			models: [MAIN_MODEL, CLASSIFIER_MODEL],
			responses: [
				{ stream: ["Let me delegate that."], toolCalls: [AGENT_CALL] },
				{ stream: ["I'll create the file."], toolCalls: [{ function: { name: "write", arguments: WRITE_ARGS } }] },
				...CLASSIFIER_ERROR_SCRIPTS,
				// Served only for the denial: the subagent's next request must carry
				// the declined tool result, and the parent's the subagent's report.
				// Had the write run, neither would match and the test would time out.
				{ match: bodyIncludes(DECLINED_RESULT), stream: ["I could not write the file — the call was declined."] },
				{ match: bodyIncludes("I could not write the file"), stream: ["The subagent reported it was denied."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Have a subagent write a file called output.txt")
			trace.step("submitted user prompt")

			await waitForText(terminal, ORIGIN_LINE, { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("escalated prompt visible")

			// The opening input guard deliberately consumes in-flight keys,
			// including Escape. Exercise deliberate cancellation after it expires.
			await new Promise((resolve) => setTimeout(resolve, 500))
			terminal.keyEscape()
			trace.step("escaped after the opening guard — the call is denied")

			await waitForText(terminal, "The subagent reported it was denied.", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(existsSync(join(fixture.workDir, "output.txt"))).toBe(false)
			expect(bufferText(terminal)).not.toContain(CLASSIFIER_ERROR)
			trace.step("subagent's model read the denial and the parent continued")
		},
	)
})
