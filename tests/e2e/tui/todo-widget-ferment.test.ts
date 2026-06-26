import { expect, test } from "@microsoft/tui-test"
import {
	INPUT_TIMEOUT_MS,
	STARTUP_TIMEOUT_MS,
	STREAM_TIMEOUT_MS,
	viewText,
	waitForText,
} from "./support/assertions.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * Widget shows "Todos · Global" header, summary line, and todo items when
 * the model writes todos with no explicit scope (default = global). Also
 * verifies the per-item status symbols (○, ▶, ✓).
 */
test("todo widget renders global scope with status symbols", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "todo-widget-global",
			responses: [
				{
					stream: ["I'll", " add", " a", " todo."],
					toolCalls: [
						{
							function: {
								name: "update_todos",
								arguments: JSON.stringify({
									todos: [
										{ content: "implement widget rendering", status: "in_progress" },
										{ content: "write e2e tests", status: "pending" },
									],
								}),
							},
						},
					],
				},
			],
		},
		async (_fixture, trace) => {
			terminal.submit("Add a todo")
			trace.step("submitted prompt")

			await waitForText(terminal, "Todos · Global", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("scope header visible")

			await waitForText(terminal, "0/2 done", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("summary line visible")

			await waitForText(terminal, "implement widget rendering", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "write e2e tests", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("todo items visible")

			// Status symbols: ▶ for in_progress, ○ for pending.
			const text = terminal.getViewableBuffer().map((r) => r.join("")).join("\n")
			expect(text).toContain("▶")
			expect(text).toContain("○")
		},
	)
})

/**
 * Regression: todo lifecycle tools (create_todos, update_todos, add_todo,
 * mark_todo, clear_todos) must be visible during ferment execution. They were
 * previously cataloged as `modes: ["adhoc"]`, which excluded them from both
 * planning-ferment and implementation-ferment profiles. Now cataloged as
 * `modes: ["shared"]` (SHARED_CORE_TOOLS), they should be available in every
 * mode including ferment.
 *
 * This test starts a ferment via `/ferment`, scopes it, and then has the model
 * call `update_todos` during the ferment. If the tool were not visible, the
 * tool call would be rejected by the runtime and the todo widget would never
 * appear.
 */
test("todo tools are available during ferment execution", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "todo-widget-ferment-visibility",
			gitInit: true,
			responses: [
				// Turn 1: orientation text then propose_ferment_scoping (same contract
				// as ferment-new-runs-planning.test.ts).
				{
					stream: ["I'll outline the scope."],
					toolCalls: [
						{
							function: {
								name: "propose_ferment_scoping",
								arguments: JSON.stringify({
									ferment_id: "__FERMENT_ID__",
									title: "Test Ferment",
									goal: "Verify todo tools work during ferment execution.",
									success_criteria: ["update_todos tool call succeeds during ferment"],
									constraints: [],
									assumptions: "The ferment lifecycle is active.",
									phases: [
										{
											name: "Implementation",
											goal: "Call update_todos during the ferment.",
											steps: [
												{ description: "Write a todo list via update_todos.", verify: "true" },
											],
										},
									],
									questions: [],
									gates: [
										{ id: "P1", verdict: "pass", rationale: "Step has verify", evidence: "true" },
										{ id: "P2", verdict: "omitted", rationale: "single phase", evidence: "n/a" },
										{ id: "P3", verdict: "pass", rationale: "tests pass", evidence: "n/a" },
									],
								}),
							},
						},
					],
				},
				// Turn 2 (after tool result): short text, no trailing "?".
				{ stream: ["I've outlined the scope for this test."] },
				// Turn 3 (post-confirmation keepalive): mirrors ferment-new-runs-planning.
				{},
				// Turn 4 (host nudge): activate the implementation phase.
				{
					stream: ["Starting implementation."],
					toolCalls: [
						{
							function: {
								name: "activate_ferment_phase",
								arguments: JSON.stringify({
									ferment_id: "__FERMENT_ID__",
									phase_id: "phase-1",
								}),
							},
						},
					],
				},
				// Turn 5: model calls update_todos during implementation.
				{
					stream: ["I'll track my work with todos."],
					toolCalls: [
						{
							function: {
								name: "update_todos",
								arguments: JSON.stringify({
									todos: [
										{ content: "write the code", status: "in_progress" },
										{ content: "run tests", status: "pending" },
									],
								}),
							},
						},
					],
				},
				// Keepalive after implementation turn.
				{},
			],
		},
		async (_fixture, trace) => {
			// Stage 1: ready prompt visible.
			await waitForText(terminal, "ask anything or type / for commands", {
				timeoutMs: STARTUP_TIMEOUT_MS,
			})
			trace.step("ready prompt visible")

			// Stage 2: enter ferment (same entry path as ferment-new-runs-planning).
			terminal.write("/ferment")
			await waitForText(terminal, "/ferment", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("typed /ferment")
			terminal.submit("")
			trace.step("ran /ferment")

			// Stage 3: intent prompt appears.
			await waitForText(terminal, "would you like to ferment", {
				timeoutMs: STARTUP_TIMEOUT_MS,
			})
			trace.step("intent prompt visible")

			// Stage 4: submit intent → model proposes scoping.
			terminal.submit("Verify todo tools work during ferment")
			trace.step("submitted intent")

			// Stage 5: plan-review dialog appears.
			await waitForText(terminal, "Proceed with this plan?", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await waitForText(terminal, "Start execution", {
				timeoutMs: INPUT_TIMEOUT_MS,
			})
			trace.step("plan-review dialog visible")

			// Stage 6: confirm → ferment is scoped and implementation can begin.
			terminal.submit("")
			trace.step("confirmed 'Start execution'")

			// Stage 7: model calls update_todos — if the tool were not visible during
			// the ferment, this call would be rejected and the todo widget would
			// never render. Seeing the widget proves the tool was available.
			await waitForText(terminal, "Todos · Global", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("todo widget appeared — update_todos succeeded during ferment")

			await waitForText(terminal, "write the code", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "run tests", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("todo items visible during ferment")
		},
	)
})

/**
 * Widget summary line shows the correct count for mixed-status todos:
 * "1/4 done · 3 active · 1 blocked" when there are 4 todos with
 * pending/in_progress/blocked/completed statuses.
 */
test("todo widget summary reflects mixed-status counts", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "todo-widget-mixed-status",
			responses: [
				{
					stream: ["Adding", " mixed", " todos."],
					toolCalls: [
						{
							function: {
								name: "update_todos",
								arguments: JSON.stringify({
									todos: [
										{ content: "pending item", status: "pending" },
										{ content: "active item", status: "in_progress" },
										{ content: "blocked item", status: "blocked" },
										{ content: "done item", status: "completed" },
									],
								}),
							},
						},
					],
				},
			],
		},
		async (_fixture, trace) => {
			terminal.submit("Add mixed todos")
			trace.step("submitted prompt")

			// Summary format: "1/4 done · 3 active · 1 blocked"
			await waitForText(terminal, "1/4 done", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("summary count visible")

			await waitForText(terminal, "1 blocked", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("blocked count visible")

			// All 4 items should appear with their status symbols.
			await waitForText(terminal, "pending item", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "active item", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "blocked item", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "done item", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("all items visible")
		},
	)
})

test("todo widget shows rolling markers around active work", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "todo-widget-rolling-window",
			responses: [
				{
					stream: ["Rolled", " todos."],
					toolCalls: [
						{
							function: {
								name: "update_todos",
								arguments: JSON.stringify({
									todos: Array.from({ length: 19 }, (_, index) => ({
										content: `task ${index + 1}`,
										status: index < 9 ? "completed" : index === 9 ? "in_progress" : "pending",
									})),
								}),
							},
						},
					],
				},
			],
		},
		async (_fixture, trace) => {
			terminal.submit("Create rolling todos")

			await waitForText(terminal, "9/19 done · 10 active", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			await waitForText(terminal, "… 7 completed", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForText(terminal, "  8.  ✓ task 8", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForText(terminal, "  9.  ✓ task 9", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForText(terminal, " 10.  ▶ task 10", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForText(terminal, " 14.  ○ task 14", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForText(terminal, "… 5 more", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			trace.step("rolling active window visible")

			const text = viewText(terminal)
			expect(text).not.toContain("  1.  ✓ task 1")
			expect(text).not.toContain(" 19.  ○ task 19")
		},
	)
})

test("todo widget anchors completed overflow at the end", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "todo-widget-completed-end",
			responses: [
				{
					stream: ["All", " completed."],
					toolCalls: [
						{
							function: {
								name: "update_todos",
								arguments: JSON.stringify({
									todos: Array.from({ length: 19 }, (_, index) => ({
										content: `task ${index + 1}`,
										status: "completed",
									})),
								}),
							},
						},
					],
				},
			],
		},
		async (_fixture, trace) => {
			terminal.submit("Create completed todos")
			await waitForText(terminal, "All completed.", { timeoutMs: STREAM_TIMEOUT_MS, full: false })

			terminal.write("/todos")
			await waitForText(terminal, "/todos", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("")

			await waitForText(terminal, "19/19 done · 0 active", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForText(terminal, "… 10 completed", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForText(terminal, " 11.  ✓ task 11", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			await waitForText(terminal, " 19.  ✓ task 19", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			trace.step("completed end window visible")

			const text = viewText(terminal)
			expect(text).not.toContain("  1.  ✓ task 1")
			expect(text).not.toContain("… 9 more")
		},
	)
})
