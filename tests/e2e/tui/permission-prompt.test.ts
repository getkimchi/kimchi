/**
 * E2E TUI tests for the permission prompt UX — the terminal-facing surface
 * in `src/extensions/permissions/prompts.ts`.
 *
 * Covers three scenarios:
 *   1. Auto mode: classifier returns "requires-confirmation" with "high" risk
 *      → the risk badge ("● high risk") and classifier reason appear in the prompt.
 *   2. Auto mode: classifier returns "safe" → tool auto-approves, no prompt shown.
 *   3. Auto mode without classifier model: prompt appears without a risk badge
 *      (classifier unavailable → riskScore undefined → no badge rendered).
 *
 * Key wiring notes:
 *   - The fixture hardcodes `KIMCHI_PERMISSIONS=yolo`, which bypasses all prompts.
 *     All tests override via `--auto` flag, which takes precedence over env in
 *     `resolveMode` (flag > env > config).
 *   - The classifier makes its own LLM call to `deepseek-v4-flash`, so that model
 *     slug must be present in the models config for tests 1 and 2. Both the main
 *     model and classifier hit the same fake server endpoint; response ordering in
 *     the queue must match the real request order: main turn → classifier → main
 *     follow-up.
 *   - Test 3 omits the classifier model slug. `classifyToolCall` returns
 *     `{ verdict: "requires-confirmation", riskScore: undefined }`, so the prompt
 *     appears (auto mode + promptAvailable) but `formatRiskBadge` is never called.
 */

import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const MAIN_MODEL = { slug: "basic", displayName: "Fake Basic", contextWindow: 200_000, maxTokens: 8192 }
const CLASSIFIER_MODEL = {
	slug: "deepseek-v4-flash",
	displayName: "DeepSeek V4 Flash",
	contextWindow: 200_000,
	maxTokens: 8192,
}

const ALLOW_PROMPT = "Allow the assistant to run this?"

/** Tool-call arguments for a `write` to output.txt — a non-read-only file write. */
const WRITE_ARGS = JSON.stringify({ path: "output.txt", content: "hello world" })

test("auto mode shows risk badge when classifier returns high risk", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "permission-prompt-risk-badge",
			extraArgs: ["--auto"],
			models: [MAIN_MODEL, CLASSIFIER_MODEL],
			responses: [
				// Turn 1: main model streams text + write tool call.
				{
					stream: ["I'll create the file."],
					toolCalls: [{ function: { name: "write", arguments: WRITE_ARGS } }],
				},
				// Classifier response: requires-confirmation, high risk.
				{
					stream: ['{"verdict":"requires-confirmation","reason":"This writes a new file to disk","riskScore":"high"}'],
				},
				// Turn 2: follow-up after user approves.
				{ stream: ["File written successfully."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Write a file called output.txt")
			trace.step("submitted user prompt")

			// Wait for the permission prompt to render.
			await waitForText(terminal, ALLOW_PROMPT, { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("permission prompt visible")

			// The risk badge "● high risk" should appear (ANSI color codes are
			// in the raw buffer; substring match on "high risk" is sufficient).
			await waitForText(terminal, "high risk", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("risk badge 'high risk' visible")

			// The classifier reason should appear as a subtitle line.
			await waitForText(terminal, "This writes a new file to disk", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("classifier reason subtitle visible")

			// Approve by pressing Enter (first option = "Yes — just this call").
			terminal.submit("")
			trace.step("approved with 'allow-once'")

			// The model's follow-up stream should appear.
			await waitForText(terminal, "File written successfully.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("follow-up stream after approval")

			// Verify the classifier request was actually sent to the fake server.
			const classifierRequests = fixture.fake.requests.filter(
				(req) => req.url.startsWith("/openai/v1/chat/completions") && typeof req.body === "object" && req.body !== null,
			)
			expect(classifierRequests.length).toBeGreaterThanOrEqual(2)
			trace.step("fake server received main + classifier requests")
		},
	)
})

test("auto mode auto-approves when classifier returns safe verdict", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "permission-prompt-safe-auto-approve",
			extraArgs: ["--auto"],
			models: [MAIN_MODEL, CLASSIFIER_MODEL],
			responses: [
				// Turn 1: main model streams text + write tool call.
				{
					stream: ["I'll create the file."],
					toolCalls: [{ function: { name: "write", arguments: WRITE_ARGS } }],
				},
				// Classifier response: safe, low risk.
				{
					stream: ['{"verdict":"safe","reason":"Routine file write within project","riskScore":"low"}'],
				},
				// Turn 2: follow-up after auto-approval.
				{ stream: ["File written successfully."] },
			],
		},
		async (_fixture, trace) => {
			terminal.submit("Write a file called output.txt")
			trace.step("submitted user prompt")

			// The model's follow-up should appear without a permission prompt.
			// If the classifier returns "safe", the tool runs immediately.
			await waitForText(terminal, "File written successfully.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("follow-up stream received (auto-approved)")

			// Verify the permission prompt never appeared.
			const fullBuffer = terminal
				.getBuffer()
				.map((row: string[]) => row.join(""))
				.join("\n")
			expect(fullBuffer).not.toContain(ALLOW_PROMPT)
			trace.step("no permission prompt in terminal buffer")
		},
	)
})

test("auto mode without classifier model shows prompt without risk badge", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "permission-prompt-no-risk-badge",
			extraArgs: ["--auto"],
			// No CLASSIFIER_MODEL in the list — classifyToolCall returns unavailable.
			models: [MAIN_MODEL],
			responses: [
				// Turn 1: main model streams text + write tool call.
				{
					stream: ["I'll create the file."],
					toolCalls: [{ function: { name: "write", arguments: WRITE_ARGS } }],
				},
				// Turn 2: follow-up after user approves.
				{ stream: ["File written successfully."] },
			],
		},
		async (_fixture, trace) => {
			terminal.submit("Write a file called output.txt")
			trace.step("submitted user prompt")

			// The permission prompt should appear — classifier is unavailable so
			// the verdict is "requires-confirmation", but riskScore is undefined.
			await waitForText(terminal, ALLOW_PROMPT, { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("permission prompt visible")

			// Verify no risk badge text is present (riskScore undefined → no badge).
			const fullBuffer = terminal
				.getBuffer()
				.map((row: string[]) => row.join(""))
				.join("\n")
			expect(fullBuffer).not.toContain("risk")
			trace.step("no risk badge in terminal buffer")

			// Approve by pressing Enter (first option).
			terminal.submit("")
			trace.step("approved with 'allow-once'")

			// The model's follow-up should appear.
			await waitForText(terminal, "File written successfully.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("follow-up stream after approval")
		},
	)
})
