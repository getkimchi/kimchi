/**
 * E2E TUI test for the classifier-outage prompt UX: the classifier model is
 * configured but every classification request fails (provider-side error),
 * so the gate falls back to a permission prompt that says the classifier is
 * unavailable — with fixed copy, never the raw provider diagnostic.
 *
 * Key wiring notes:
 *   - The classifier ladder tries three models with up to three attempts
 *     each. Every classifier request is answered with an SSE error chunk
 *     (`finish_reason: "error"`); scripts use a `match` predicate on the
 *     classifier's system prompt so they can never consume the main model's
 *     scripted turns. Leftover error scripts are harmless: unmatched scripts
 *     are taken in order, and the follow-up turn sits after them.
 *   - The fixture hardcodes `KIMCHI_PERMISSIONS=yolo`; `--auto` overrides it
 *     (flag > env) so the classifier actually runs.
 *   - Both the main model and the classifier hit the same fake server; the
 *     main queue order is turn 1 (with the write tool call) → classifier
 *     errors (matched) → turn 2 follow-up.
 */

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

const ALLOW_PROMPT = "Allow the assistant to run this?"
const OUTAGE_SUBTITLE = "your confirmation is needed for this call"
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

/** Tool-call arguments for a `write` to output.txt — a non-read-only file write. */
const WRITE_ARGS = JSON.stringify({ path: "output.txt", content: "hello world" })

test("classifier outage shows a labelled confirmation prompt without provider diagnostics", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "permission-classifier-outage",
			providerId: "kimchi-dev",
			extraArgs: ["--auto"],
			models: [MAIN_MODEL, CLASSIFIER_MODEL],
			responses: [
				// Turn 1: main model streams text + write tool call.
				{
					stream: ["I'll create the file."],
					toolCalls: [{ function: { name: "write", arguments: WRITE_ARGS } }],
				},
				// Classifier ladder: every attempt errors (matched scripts).
				...CLASSIFIER_ERROR_SCRIPTS,
				// Turn 2: follow-up after user approves.
				{ stream: ["File written successfully."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Write a file called output.txt")
			trace.step("submitted user prompt")

			// The classifier fails, so the gate asks the user — and the prompt
			// says the classifier is unavailable instead of leaking the error.
			await waitForText(terminal, ALLOW_PROMPT, { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, OUTAGE_SUBTITLE, { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("labelled outage prompt visible")

			const fullBuffer = terminal
				.getBuffer()
				.map((row: string[]) => row.join(""))
				.join("\n")
			expect(fullBuffer).not.toContain(CLASSIFIER_ERROR)
			trace.step("no provider diagnostic in terminal buffer")

			// The classifier actually ran against the fake server and failed.
			const classifierRequests = fixture.fake.requests.filter((req) => isClassifierRequest(req.body))
			expect(classifierRequests.length).toBeGreaterThanOrEqual(1)
			trace.step(`classifier made ${classifierRequests.length} failing request(s)`)

			// Approving lets the call through and the session continues.
			terminal.submit("")
			await waitForText(terminal, "File written successfully.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("follow-up stream after approval")
		},
	)
})
