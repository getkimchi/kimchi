/**
 * E2E TUI tests for the simplified `ask_user` tool and `confirm_ferment_completion_criteria`.
 *
 * Covers:
 *   1. `ask_user` with a single-choice question renders a select prompt.
 *   2. `confirm_ferment_completion_criteria` shows "Type your own answer" (the hardcoded
 *      allowOther fallback label) — not the old "No (input what is wrong)" label.
 *   3. `ask_user` with a confirm question renders Yes/No options.
 *   4. The plan review that gates these flows remains visible and usable while
 *      scrolling and resizing.
 *
 * The simplified `ask_user` only accepts a `questions[]` array and infers `ferment_id`
 * from `runtime.getActiveId()` when not supplied.
 */

import { expect, test } from "@microsoft/tui-test"
import type { Terminal } from "@microsoft/tui-test/lib/terminal/term.js"
import { INPUT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

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

const SCROLLABLE_PLAN_SCOPING_PAYLOAD = JSON.stringify({
	ferment_id: "__FERMENT_ID__",
	title: "Scrollable Review",
	goal: "RESIZE_MARKER_GOAL",
	success_criteria: ["The decision controls remain visible and usable"],
	phases: Array.from({ length: 7 }, (_, index) => ({
		name: `Scroll verification phase ${index + 1}`,
		goal: `Verify scrolling through plan content ${index + 1}.`,
		steps: [
			{
				description: `Scroll marker ${index + 1}: keep this plan far taller than the review window.`,
				verify: "echo done",
			},
		],
	})),
	questions: [],
	gates: [
		{ id: "P1", verdict: "pass", rationale: "Steps have verification", evidence: "echo done" },
		{ id: "P2", verdict: "omitted", rationale: "single interactive step", evidence: "n/a" },
		{ id: "P3", verdict: "pass", rationale: "criterion checked", evidence: "n/a" },
	],
})

/** Shared boilerplate to drive a ferment from cold-start through the plan-review confirm.
 *
 * Turn sequence (with terminate:true on propose_ferment_scoping):
 *   Turn 1: propose_ferment_scoping → sets pending plan review + terminate:true
 *           → review dialog appears via onPlanReviewRequest setTimeout(0)
 *   Turn 2: ask_user / confirm_ferment_completion_criteria (tools restored after confirm)
 *
 * @param nextStream the post-confirmation stream text to wait for — differs per test
 */
async function startFerment(
	terminal: Terminal,
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

	// The review dialog appears directly after propose_ferment_scoping terminates
	// the turn (the onPlanReviewRequest listener schedules it via setTimeout(0)).
	// The dialog is a centered overlay that COVERS the transcript, so the turn 1
	// stream text behind it is not visible while it is open — resolve the dialog
	// first, then assert on the stream text.
	await waitForText(terminal, "Proceed with this plan?", { timeoutMs: STREAM_TIMEOUT_MS })
	await waitForText(terminal, "Start execution", { timeoutMs: INPUT_TIMEOUT_MS })
	trace.step("plan-review dialog visible")

	// Press Enter to accept "Start execution" (default first option in the dialog).
	terminal.submit("")
	trace.step("confirmed 'Start execution' (Enter on default option)")

	await waitForText(terminal, "I'll outline the scope.", { timeoutMs: STREAM_TIMEOUT_MS })
	trace.step("turn 1 stream received — propose_ferment_scoping completed")

	// Wait for the model's turn 2 stream — tools are restored after confirmation,
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
				// Turn 1: propose scoping — terminate:true ends the turn and the
				// review dialog appears via the onPlanReviewRequest listener.
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
				// Turn 2: ask the user a single-choice question (tools restored after confirm).
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
			models: [NO_COMPACTION_MODEL],
			responses: [
				// Turn 1: propose scoping — terminate:true ends the turn and the
				// review dialog appears via the onPlanReviewRequest listener.
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
				// Turn 2: confirm completion criteria (tools restored after confirm).
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

test("plan review keeps decision options visible and usable while scrolling and resizing", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "plan-review-scroll-resize",
			gitInit: true,
			models: [NO_COMPACTION_MODEL],
			responses: [
				// Turn 1: produce a plan much taller than the initial 14-row terminal.
				{
					stream: ["I'll outline the scope."],
					toolCalls: [
						{
							function: {
								name: "propose_ferment_scoping",
								arguments: SCROLLABLE_PLAN_SCOPING_PAYLOAD,
							},
						},
					],
				},
				// Turn 2: proves the feedback option submitted after scrolling and resizing worked.
				{ stream: ["Feedback received after the resize."] },
			],
		},
		async (_fixture, trace) => {
			// Resize the live session before opening the dialog: test.use owns the
			// initial 120x40 geometry, so changing it before runKimchiSession is overwritten.
			terminal.resize(100, 14)
			terminal.write("/ferment")
			await waitForText(terminal, "/ferment", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			terminal.submit("")

			await waitForText(terminal, "would you like to ferment", { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
			terminal.submit("Exercise the scrollable plan review")
			trace.step("opened a long plan review in a 100 by 14 terminal")

			await waitForText(terminal, "Proceed with this plan?", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			await waitForText(terminal, "scroll plan", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			const initialView = viewText(terminal)
			expect(initialView).toContain("Execute the plan locally")
			expect(initialView).toContain("Start execution in auto mode")
			expect(initialView).toContain("Let me say something")
			trace.step("all decision options visible above the harness footer")

			terminal.write("\x1b[b") // shift+down scrolls the plan without changing the selection
			await waitForText(terminal, /2-\d+ of \d+/, { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			const scrolledView = viewText(terminal)
			expect(scrolledView).toContain("Execute the plan locally")
			expect(scrolledView).toContain("Start execution in auto mode")
			expect(scrolledView).toContain("Let me say something")
			trace.step("plan scrolled while the decision options stayed visible")

			terminal.resize(100, 20)
			await waitForText(terminal, "RESIZE_MARKER_GOAL", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			const resizedView = viewText(terminal)
			expect(resizedView).toContain("Execute the plan locally")
			expect(resizedView).toContain("Start execution in auto mode")
			expect(resizedView).toContain("Let me say something")
			trace.step("resize grew the markdown window without losing the decision options")

			terminal.write("\x1b[B")
			terminal.write("\x1b[B")
			await waitForText(terminal, "> Let me say something", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			terminal.submit("")
			await waitForText(terminal, "Your direction:", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			trace.step("selected the feedback option after scrolling and resizing")

			terminal.write("Tighten the plan before starting")
			terminal.submit("")
			await waitForText(terminal, "Feedback received after the resize.", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			trace.step("feedback submission reached the model turn")
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
				// Turn 1: propose scoping — terminate:true ends the turn and the
				// review dialog appears via the onPlanReviewRequest listener.
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
				// Turn 2: ask_user with a confirm question (tools restored after confirm).
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
											prompt: "Should we proceed?",
										},
									],
								}),
							},
						},
					],
				},
				// Turn 3: stream after the user confirms.
				{ stream: ["Proceeding with the plan."] },
			],
		},
		async (_fixture, trace) => {
			await startFerment(terminal, trace, "Let me confirm.")

			// Stage 2: the confirm question renders Yes/No options.
			await waitForText(terminal, "Should we proceed?", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Yes", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "No", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("confirm prompt visible with Yes/No options")

			// Stage 3: press Enter to select "Yes" (first option).
			terminal.submit("")
			trace.step("selected 'Yes'")

			// Stage 4: model's next stream appears.
			await waitForText(terminal, "Proceeding with the plan", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("model streamed follow-up after confirm")
		},
	)
})
