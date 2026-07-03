/**
 * E2E TUI tests for the simplified `ask_user` tool and `confirm_ferment_completion_criteria`.
 *
 * Covers:
 *   1. `ask_user` with a single-choice question renders a select prompt.
 *   2. `confirm_ferment_completion_criteria` shows "Type your own answer" (the hardcoded
 *      allowOther fallback label) — not the old "No (input what is wrong)" label.
 *   3. `ask_user` with a confirm question renders Yes/No options.
 *
 * The simplified `ask_user` only accepts a `questions[]` array and infers `ferment_id`
 * from `runtime.getActiveId()` when not supplied.
 */

import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const NO_COMPACTION_MODEL = { slug: "basic", displayName: "Fake Basic", contextWindow: 200_000, maxTokens: 8192 }

// Minimal propose_ferment_scoping payload used by all three tests to start the ferment.
const PROPOSE_SCOPING_PAYLOAD = JSON.stringify({
	ferment_id: "__FERMENT_ID__",
	title: "Test Ferment",
	goal: "Test goal for e2e verification.",
	success_criteria: ["Test criterion passes"],
	phases: [
		{
			name: "Test Phase",
			goal: "Test phase goal",
			steps: [{ description: "Do the thing", verify: "echo done" }],
		},
	],
	questions: [],
	gates: [
		{ id: "P1", verdict: "pass", rationale: "Step has verify", evidence: "echo done" },
		{ id: "P2", verdict: "omitted", rationale: "single phase", evidence: "n/a" },
		{ id: "P3", verdict: "pass", rationale: "criterion checked", evidence: "n/a" },
	],
})

/** Shared boilerplate to drive a ferment from cold-start through the plan-review confirm.
 *
 * Turn sequence (with tool suppression):
 *   Turn 1: propose_ferment_scoping → sets pending plan review
 *   Turn 2: text-only (tools suppressed by hasPendingPlanReview) → agent_end fires
 *           → review dialog appears → user confirms → tools restored
 *   Turn 3: ask_user / confirm_ferment_completion_criteria (the stream we wait for)
 *
 * @param nextStream the post-confirmation stream text to wait for — differs per test
 */
async function startFerment(
	terminal: import("@microsoft/tui-test").Terminal,
	trace: import("./support/kimchi-fixture.js").TuiScenarioTrace,
	nextStream: string,
) {
	// Stage 1: enter ferment. Type then Enter separately — one-shot "/ferment\r" can
	// race startup and skip the intent prompt.
	terminal.write("/ferment")
	await waitForText(terminal, "/ferment", { timeoutMs: INPUT_TIMEOUT_MS })
	trace.step("typed /ferment")
	terminal.submit("")
	trace.step("ran /ferment")

	await waitForText(terminal, "would you like to ferment", { timeoutMs: STARTUP_TIMEOUT_MS })
	trace.step("intent prompt visible")

	terminal.submit("Test intent for ask-user e2e")
	trace.step("submitted intent")

	// Wait for the model's turn 1 stream to confirm propose_ferment_scoping completed.
	await waitForText(terminal, "I'll outline the scope.", { timeoutMs: STREAM_TIMEOUT_MS })
	trace.step("turn 1 stream received — propose_ferment_scoping completed")

	// Turn 2 is the suppression turn: tools are suppressed (pi.setActiveTools([]))
	// because a pending plan review exists. The model produces a text-only response,
	// firing agent_end → the review dialog appears.
	// We don't wait for the Turn 2 stream text — go straight to the dialog.

	// Wait for the plan-review dialog to appear (triggered by agent_end after
	// the suppression turn).
	await waitForText(terminal, "Proceed with this plan?", { timeoutMs: STREAM_TIMEOUT_MS })
	await waitForText(terminal, "Start execution", { timeoutMs: INPUT_TIMEOUT_MS })
	trace.step("plan-review dialog visible")

	// Press Enter to accept "Start execution" (default first option in the dialog).
	terminal.submit("")
	trace.step("confirmed 'Start execution' (Enter on default option)")

	// Wait for the model's turn 3 stream — tools are restored after confirmation,
	// so ask_user / confirm_ferment_completion_criteria is now available.
	await waitForText(terminal, nextStream, { timeoutMs: STREAM_TIMEOUT_MS })
	trace.step(`post-confirmation stream received: ${nextStream}`)
}

test("ask_user renders a single-choice question and accepts selection", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "ask-user-single-choice",
			gitInit: true,
			models: [NO_COMPACTION_MODEL],
			responses: [
				// Turn 1: propose scoping so the ferment starts in planning phase.
				{
					stream: ["I'll outline the scope."],
					toolCalls: [
						{
							function: {
								name: "propose_ferment_scoping",
								arguments: PROPOSE_SCOPING_PAYLOAD,
							},
						},
					],
				},
				// Turn 2 (suppression): tools are suppressed after propose_ferment_scoping
				// sets a pending plan review. The model produces a text-only response,
				// ending the turn so agent_end fires and the review dialog appears.
				{ stream: ["Plan ready for review."] },
				// Turn 3: ask the user a single-choice question (tools restored after confirm).
				{
					stream: ["Let me ask the user."],
					toolCalls: [
						{
							function: {
								name: "ask_user",
								arguments: JSON.stringify({
									questions: [
										{
											id: "flavor",
											type: "single",
											prompt: "Which flavor?",
											options: [
												{ id: "vanilla", label: "Vanilla" },
												{ id: "chocolate", label: "Chocolate" },
											],
										},
									],
								}),
							},
						},
					],
				},
				// Turn 4: stream a follow-up after the user picks Vanilla.
				{ stream: ["Thanks! I'll use vanilla."] },
			],
		},
		async (fixture, trace) => {
			await startFerment(terminal, trace, "Let me ask the user.")

			// Stage 2: wait for the ask_user prompt — question text + both option labels.
			await waitForText(terminal, "Which flavor?", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Vanilla", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "Chocolate", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("ask_user single-choice prompt visible with options")

			// Stage 3: select first option (Vanilla) by pressing Enter.
			terminal.submit("")
			trace.step("selected Vanilla")

			// Stage 4: model's next stream ("Thanks! I'll use vanilla.") appears.
			await waitForText(terminal, "vanilla", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("model streamed follow-up after ask_user")

			// Stage 5: assert the fake server received an ask_user tool call.
			const askUserRequests = fixture.fake.requests.filter(
				(req) =>
					req.url.startsWith("/openai/v1/chat/completions") &&
					typeof req.body === "object" &&
					req.body !== null &&
					JSON.stringify(req.body).includes("ask_user"),
			)
			expect(askUserRequests.length).toBeGreaterThan(0)
			trace.step(`host sent ${askUserRequests.length} request(s) referencing ask_user`)
		},
	)
})

test("confirm_ferment_completion_criteria shows 'Type your own answer' label", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "ask-user-confirm-criteria",
			gitInit: true,
			models: [NO_COMPACTION_MODEL],
			responses: [
				// Turn 1: propose scoping.
				{
					stream: ["I'll outline the scope."],
					toolCalls: [
						{
							function: {
								name: "propose_ferment_scoping",
								arguments: PROPOSE_SCOPING_PAYLOAD,
							},
						},
					],
				},
				// Turn 2 (suppression): tools are suppressed after propose_ferment_scoping
				// sets a pending plan review. The model produces a text-only response,
				// ending the turn so agent_end fires and the review dialog appears.
				{ stream: ["Plan ready for review."] },
				// Turn 3: confirm completion criteria (tools restored after confirm).
				{
					stream: ["Let me confirm the criteria."],
					toolCalls: [
						{
							function: {
								name: "confirm_ferment_completion_criteria",
								arguments: JSON.stringify({
									ferment_id: "__FERMENT_ID__",
									criteria: ["Test passes"],
								}),
							},
						},
					],
				},
				// Turn 4: stream after the user confirms.
				{ stream: ["Great, criteria confirmed."] },
			],
		},
		async (_fixture, trace) => {
			await startFerment(terminal, trace, "Let me confirm the criteria.")

			// Stage 2: the confirm_ferment_completion_criteria prompt renders a single-choice
			// select with "Yes, looks good" + the hardcoded "Type your own answer" fallback.
			await waitForText(terminal, "Yes, looks good", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Type your own answer", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("confirm prompt visible with 'Yes, looks good' + 'Type your own answer'")

			// Stage 3: press Enter to select "Yes, looks good" (first option).
			terminal.submit("")
			trace.step("selected 'Yes, looks good'")

			// Stage 4: model's next stream appears.
			await waitForText(terminal, "Great, criteria confirmed", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("model streamed follow-up after confirm_ferment_completion_criteria")
		},
	)
})

test("ask_user with a confirm question renders Yes/No options", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "ask-user-confirm-question",
			gitInit: true,
			models: [NO_COMPACTION_MODEL],
			responses: [
				// Turn 1: propose scoping.
				{
					stream: ["I'll outline the scope."],
					toolCalls: [
						{
							function: {
								name: "propose_ferment_scoping",
								arguments: PROPOSE_SCOPING_PAYLOAD,
							},
						},
					],
				},
				// Turn 2 (suppression): tools are suppressed after propose_ferment_scoping
				// sets a pending plan review. The model produces a text-only response,
				// ending the turn so agent_end fires and the review dialog appears.
				{ stream: ["Plan ready for review."] },
				// Turn 3: ask_user with a confirm question (tools restored after confirm).
				{
					stream: ["Let me confirm."],
					toolCalls: [
						{
							function: {
								name: "ask_user",
								arguments: JSON.stringify({
									questions: [
										{
											id: "proceed",
											type: "confirm",
											prompt: "Should I proceed?",
										},
									],
								}),
							},
						},
					],
				},
				// Turn 4: stream after the user confirms.
				{ stream: ["Proceeding."] },
			],
		},
		async (_fixture, trace) => {
			await startFerment(terminal, trace, "Let me confirm.")

			// Stage 2: confirm question text + Yes/No options visible.
			await waitForText(terminal, "Should I proceed?", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Yes", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "No", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("ask_user confirm prompt visible with Yes/No")

			// Stage 3: press Enter to select "Yes" (first option).
			terminal.submit("")
			trace.step("selected Yes")

			// Stage 4: model's next stream appears.
			await waitForText(terminal, "Proceeding", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("model streamed follow-up after confirm")
		},
	)
})
