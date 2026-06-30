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
 * NOTE: the plan-review dialog ("Proceed with this plan?" / "Start execution") does not
 * reliably render its text in the tui-test buffer (see plan-to-ferment-promo.test.ts
 * lines 35-40). The dialog IS shown and accepts Enter — we just can't observe its text
 * directly. So instead of waiting for dialog text, we wait for the model's turn 1 stream
 * (which confirms propose_ferment_scoping completed), give the dialog a moment to be
 * presented, press Enter to accept "Start execution" (the default first option), and
 * then wait for the model's turn 2 stream text to confirm the ferment started and turn 2
 * is executing.
 *
 * @param turn2Stream the turn-2 stream text to wait for — differs per test
 */
async function startFerment(
	terminal: import("@microsoft/tui-test").Terminal,
	trace: import("./support/kimchi-fixture.js").TuiScenarioTrace,
	turn2Stream: string,
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

	// Give the plan-review dialog a moment to be presented (text won't appear in buffer,
	// but the host shows it and awaits Enter).
	await new Promise((resolve) => setTimeout(resolve, 500))

	// Press Enter to accept "Start execution" (default first option in the dialog).
	terminal.submit("")
	trace.step("confirmed 'Start execution' (Enter on default option)")

	// Wait for the model's turn 2 stream to confirm the ferment started and turn 2 is
	// executing (i.e. ask_user / confirm_ferment_completion_criteria is about to be called).
	await waitForText(terminal, turn2Stream, { timeoutMs: STREAM_TIMEOUT_MS })
	trace.step(`turn 2 stream received: ${turn2Stream}`)
}

test("ask_user renders a single-choice question and accepts selection", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "ask-user-single-choice",
			gitInit: true,
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
				// Turn 2: ask the user a single-choice question.
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
				// Turn 3: stream a follow-up after the user picks Vanilla.
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
				// Turn 2: confirm completion criteria (uses askUserForm internally with allowOther).
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
				// Turn 3: stream after the user confirms.
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
				// Turn 2: ask_user with a confirm question (fixed Yes/No).
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
				// Turn 3: stream after the user confirms.
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
