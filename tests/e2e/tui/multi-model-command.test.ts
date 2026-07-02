import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import { PROMPT_READY, TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/**
 * TUI E2E tests for the `/multi-model` command (model-roles-command.ts).
 *
 * Two commits shape the user-visible surface these tests pin down:
 *
 *   1. `feat(orchestration): refined and simplified model delegation rules`
 *      (4f2dc79efb2dd2084d7cfc5254594378bd674731) replaced the prior
 *      role-summary panel with the full interactive editor exercised here.
 *
 *   2. `refactor(extensions): drop metadata wizard from /multi-model`
 *      (#676, eb283fe8) removed the auto-prompt that used to fire after a
 *      user picked a model with no metadata in the role editors. Picking a
 *      model is now seamless; `Edit model metadata…` in the main menu is
 *      the only path that opens the metadata wizard.
 *
 * Tests cover the user-visible surface of that editor at the TUI level:
 *
 *   - Main menu opens with the role summary blocks for every role and
 *     the two footer entries ("Edit model metadata...", "Reset all to
 *     defaults").
 *   - "Reset all to defaults" persists the DEFAULT_MODEL_ROLES and
 *     surfaces an "Model roles reset to defaults." notification.
 *   - "Edit model metadata..." → model picker → "Edit" opens the
 *     metadata wizard (tier / vision / description).
 *   - Selecting a delegable role (e.g. Builder) opens the custom
 *     toggle-select component with the role's current assignment
 *     pre-selected.
 *
 * None of these tests require an LLM response; the menu is interactive
 * UI only. `responses: []` is intentional.
 */

const TWO_MODELS = [
	{ slug: "basic", displayName: "Fake Basic", contextWindow: 1_000_000, maxTokens: 4096 },
	{ slug: "heavy", displayName: "Fake Heavy", contextWindow: 1_000_000, maxTokens: 4096 },
] as const

test("/multi-model opens the main menu with the role summary and footer entries", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "multi-model-main-menu",
			models: [...TWO_MODELS],
			responses: [],
		},
		async (_fixture, trace) => {
			// One-shot "/multi-model\r" races startup; write + submit separately.
			// Trailing space switches autocomplete to argument mode so Enter
			// cannot trigger the slash-command autocomplete accept path.
			terminal.write("/multi-model ")
			await waitForText(terminal, "/multi-model ", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("typed /multi-model")
			terminal.submit("")
			await waitForText(terminal, "Model Roles", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("main menu open")

			// Every role label from ROLE_LABELS is rendered as a section heading.
			for (const label of ["Orchestrator", "Planner", "Builder", "Reviewer", "Explorer", "Researcher", "Judge"]) {
				await waitForText(terminal, label, { timeoutMs: INPUT_TIMEOUT_MS })
			}
			trace.step("all seven role sections visible")

			// The two footer actions added in this commit.
			await expect(terminal.getByText("Edit model metadata...")).toBeVisible()
			await expect(terminal.getByText("Reset all to defaults")).toBeVisible()
			trace.step("footer entries visible")

			// Escape returns to the prompt.
			terminal.keyEscape()
			await waitForText(terminal, PROMPT_READY, { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("escape returned to prompt")
		},
	)
})

test("/multi-model reset to defaults persists roles and surfaces a notification", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "multi-model-reset-defaults",
			models: [...TWO_MODELS],
			responses: [],
		},
		async (_fixture, trace) => {
			terminal.write("/multi-model ")
			await waitForText(terminal, "/multi-model ", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("typed /multi-model")
			terminal.submit("")
			await waitForText(terminal, "Model Roles", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("main menu open")

			// Navigate down one step at a time until the cursor lands on
			// the target. Robust to cursor-over-shoot races that bit earlier
			// versions of this test (where `keyDown()` repeated N times could
			// land past item 7 — see PR for context).
			await navigateMenuTo(terminal, trace, "Reset all to defaults")

			await waitForText(terminal, "Model roles reset to defaults.", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("reset notification visible")

			// The handler then re-enters the main menu — escape out.
			terminal.keyEscape()
			await waitForText(terminal, PROMPT_READY, { timeoutMs: INPUT_TIMEOUT_MS })
		},
	)
})

test("/multi-model metadata editor saves tier/vision/description", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "multi-model-metadata-wizard",
			models: [...TWO_MODELS],
			responses: [],
		},
		async (fixture, trace) => {
			terminal.write("/multi-model ")
			await waitForText(terminal, "/multi-model ", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("typed /multi-model")
			terminal.submit("")
			await waitForText(terminal, "Model Roles", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("main menu open")

			await navigateMenuTo(terminal, trace, "Edit model metadata...")

			// The metadata picker lists every configured model. The picker
			// shows each model ref followed by "(default)" if the model has
			// builtin metadata, or "(missing metadata)" otherwise. Wait for
			// the picker to appear.
			await waitForText(terminal, "Choose a model to edit metadata", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("metadata picker open")

			// Pick the first model in the picker (cursor starts on it). The
			// default orchestrator is "kimchi-dev/kimi-k2.7" and it has
			// builtin metadata, so the wizard will offer "keep current (X)"
			// options alongside the explicit choices.
			await waitForText(terminal, "kimchi-dev/kimi-k2.7", { timeoutMs: INPUT_TIMEOUT_MS })
			// Explicit assertion: if the default orchestrator ref ever
			// changes, this surfaces the failure here at the picker rather
			// than as a confusing downstream timeout waiting for the submenu.
			expect(viewText(terminal)).toContain("kimchi-dev/kimi-k2.7")
			terminal.submit("")
			// The submenu title is `${ref} — metadata`. Matching the full
			// `kimchi-dev/kimi-k2.7 — metadata` string avoids matching the
			// picker's own "Choose a model to edit metadata" header.
			await waitForText(terminal, "kimchi-dev/kimi-k2.7 — metadata", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("model selected, submenu open")

			// Submenu offers "Edit" (cursor starts on it) / "Cancel".
			// No "Reset to defaults" because no custom override exists yet.
			terminal.submit("")

			// Wizard step 1: tier. The question form pre-highlights option
			// 1 ("heavy"), so Enter selects it. The reducer then advances
			// to the next tab (Vision). Wait on the full Tier prompt text
			// rather than just the tab label "Tier" — the tab is rendered
			// for every question, so matching it would not prove we have
			// actually advanced to the Tier tab.
			await waitForText(terminal, "Tier — what capability level is this model?", {
				timeoutMs: INPUT_TIMEOUT_MS,
			})
			trace.step("wizard — tier question")
			terminal.submit("")

			// Wizard step 2: vision. Same pattern — Enter selects the
			// highlighted option (option 1, "yes") and advances.
			await waitForText(terminal, "Vision support — can this model process images?", {
				timeoutMs: INPUT_TIMEOUT_MS,
			})
			trace.step("wizard — vision question")
			terminal.submit("")

			// Wizard step 3: description (text input). Enter enters input
			// mode; type the description and submit it. The form then
			// advances to the Submit tab, where a final Enter actually
			// closes the wizard.
			await waitForText(terminal, "Description — when should this model be used?", {
				timeoutMs: INPUT_TIMEOUT_MS,
			})
			trace.step("wizard — description question")
			terminal.submit("")
			await waitForText(terminal, "Enter to submit", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("wizard — description editor open")
			terminal.submit("heavy model for complex work")
			// The Submit tab is the only place "Ready to submit" appears
			// — matching it (rather than the always-visible "✓ Submit" tab
			// label) proves the reducer actually advanced.
			await waitForText(terminal, "Ready to submit", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("wizard — submit tab visible")
			terminal.submit("")

			// After the last step the wizard closes and surfaces a
			// "Metadata saved for X." notification.
			await waitForText(terminal, /Metadata saved for kimchi-dev\/kimi-k2\.7\./, { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("metadata saved notification")

			// Verify on-disk state. Assert against the parsed JSON object
			// (not raw text regex) so a key reorder or pretty-print change
			// can't silently shift the failure mode.
			const settingsPath = `${fixture.homeDir}/.config/kimchi/harness/settings.json`
			const settings = await readSettingsJson(settingsPath)
			const meta = settings.modelMetadata?.["kimchi-dev/kimi-k2.7"]
			expect(meta).toBeDefined()
			expect(meta).toMatchObject({ tier: "heavy", vision: true })
			expect(meta?.description).toContain("heavy model for complex work")
			trace.step("settings.json carries saved metadata")

			terminal.keyEscape()
			await waitForText(terminal, PROMPT_READY, { timeoutMs: INPUT_TIMEOUT_MS })
		},
	)
})

test("/multi-model builder role opens toggle-select with current assignment pre-checked", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "multi-model-toggle-select",
			models: [...TWO_MODELS],
			responses: [],
		},
		async (_fixture, trace) => {
			terminal.write("/multi-model ")
			await waitForText(terminal, "/multi-model ", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("typed /multi-model")
			terminal.submit("")
			await waitForText(terminal, "Model Roles", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("main menu open")

			// Navigate down to the Builder role entry.
			await navigateMenuTo(terminal, trace, "Builder")

			// The toggle-select title is "{Role} — toggle models (N selected)"
			await waitForText(terminal, "toggle models", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("toggle-select open for Builder")

			// At least one model checkbox is checked — the current
			// assignment must be pre-selected.
			const view = viewText(terminal)
			expect(view).toMatch(/\[x\]\s+kimchi-dev\//)
			trace.step("current assignment pre-checked")

			// Escape cancels back to the main menu.
			terminal.keyEscape()
			await waitForText(terminal, "Model Roles", { timeoutMs: INPUT_TIMEOUT_MS })
		},
	)
})

// ---------------------------------------------------------------------------
// UX contracts: Enter confirms from any row, no Done row, no "Enter custom
// model..." option, cursor resets to row 0 on re-open, Space toggles. These
// behaviors are pinned by the tests below so the original UX bugs cannot
// regress silently.
// ---------------------------------------------------------------------------

test("/multi-model Enter on first row of toggle-select confirms without scrolling", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "multi-model-enter-first-row",
			models: [...TWO_MODELS],
			responses: [],
		},
		async (_fixture, trace) => {
			terminal.write("/multi-model ")
			await waitForText(terminal, "/multi-model ", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("")
			await waitForText(terminal, "Model Roles", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("main menu open")

			await navigateMenuTo(terminal, trace, "Builder")
			await waitForText(terminal, "toggle models", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("toggle-select open for Builder")

			// The cursor (`> ` prefix) must land on the FIRST model row.
			// The original UX bug was that Enter only worked on a hidden
			// "Done" row at the bottom — this assertion pins the fix.
			const beforeView = viewText(terminal)
			const cursorLine = beforeView.split("\n").find((line) => /^> \[/.test(line))
			expect(cursorLine).toBeDefined()
			trace.step("cursor on first row")

			// Press Enter immediately. No scrolling, no Done button needed.
			terminal.submit("")
			await waitForText(terminal, /Builder set to/, { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("Enter from first row confirmed selection")
		},
	)
})

test("/multi-model toggle-select has no Done/Add custom rows and uses new footer", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "multi-model-no-done-no-custom",
			models: [...TWO_MODELS],
			responses: [],
		},
		async (_fixture, trace) => {
			terminal.write("/multi-model ")
			await waitForText(terminal, "/multi-model ", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("")
			await waitForText(terminal, "Model Roles", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("main menu open")

			await navigateMenuTo(terminal, trace, "Builder")
			await waitForText(terminal, "toggle models", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("toggle-select open")

			const view = viewText(terminal)

			// Hidden Done row and Add custom row must be gone — these were
			// the original UX bugs the refactor removed.
			expect(view).not.toContain("Done (")
			expect(view).not.toContain("Add custom")
			trace.step("no Done or Add custom rows visible")

			// Footer uses the new key set with (N selected) count and
			// does NOT mention the removed "c custom" keybinding.
			expect(view).not.toContain("c custom")
			expect(view).toMatch(/\(\d+ selected\)/)
			trace.step("footer shows new key set with (N selected)")
		},
	)
})

test("/multi-model toggle-select cursor resets to row 0 on Escape + re-open", async ({ terminal }) => {
	// The picker must not preserve cursor position across re-open — each
	// invocation is a fresh selection screen, so the cursor lands on row 0
	// even if the user previously moved it. This pins the no-persistence
	// contract; reintroducing cursor persistence would be a UX regression.
	await runKimchiSession(
		terminal,
		{
			artifactName: "multi-model-cursor-resets",
			models: [...TWO_MODELS],
			responses: [],
		},
		async (_fixture, trace) => {
			terminal.write("/multi-model ")
			await waitForText(terminal, "/multi-model ", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("")
			await waitForText(terminal, "Model Roles", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("main menu open")

			await navigateMenuTo(terminal, trace, "Builder")
			await waitForText(terminal, "toggle models", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("toggle-select first open")

			// Move cursor down to row 1 (with TWO_MODELS that's the second
			// and last model — no wrap yet). Confirm we're not on row 0.
			terminal.keyDown()
			await new Promise((resolve) => setTimeout(resolve, 100))
			const firstOpenView = viewText(terminal)
			const firstCursorModel = firstOpenView
				.split("\n")
				.find((line) => /^> \[/.test(line))
				?.match(/kimchi-dev\/(\S+)/)?.[1]
			expect(firstCursorModel).toBe("heavy")
			trace.step(`cursor on row 1 (${firstCursorModel}) after first open`)

			// Escape cancels back to main menu.
			terminal.keyEscape()
			await waitForText(terminal, "Model Roles", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("back at main menu")

			// Re-open Builder picker. The cursor MUST be back on row 0
			// ("basic"), not on the previous row 1 ("heavy").
			await navigateMenuTo(terminal, trace, "Builder")
			await waitForText(terminal, "toggle models", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("toggle-select re-opened")

			const reOpenView = viewText(terminal)
			const reOpenCursorModel = reOpenView
				.split("\n")
				.find((line) => /^> \[/.test(line))
				?.match(/kimchi-dev\/(\S+)/)?.[1]
			expect(reOpenCursorModel).toBe("basic")
			trace.step(`cursor reset to row 0 (${reOpenCursorModel}) after re-open`)

			terminal.keyEscape()
			await waitForText(terminal, "Model Roles", { timeoutMs: INPUT_TIMEOUT_MS })
		},
	)
})

test("/multi-model Space toggles checkbox state in toggle-select", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "multi-model-space-toggle",
			models: [...TWO_MODELS],
			responses: [],
		},
		async (_fixture, trace) => {
			terminal.write("/multi-model ")
			await waitForText(terminal, "/multi-model ", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("")
			await waitForText(terminal, "Model Roles", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("main menu open")

			await navigateMenuTo(terminal, trace, "Builder")
			await waitForText(terminal, "toggle models", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("toggle-select open")

			// Capture the initial state of the cursor row (which is row 0).
			const beforeView = viewText(terminal)
			const beforeCursorLine = beforeView.split("\n").find((line) => /^> \[/.test(line))
			expect(beforeCursorLine).toBeDefined()
			const wasChecked = beforeCursorLine?.includes("[x]") ?? false
			trace.step(`cursor row was ${wasChecked ? "checked" : "unchecked"}`)

			// Press Space to toggle. Space must be sent without a trailing
			// Enter (which is what `terminal.write(" ")` achieves).
			terminal.write(" ")
			await new Promise((resolve) => setTimeout(resolve, 100))

			const afterView = viewText(terminal)
			const afterCursorLine = afterView.split("\n").find((line) => /^> \[/.test(line))
			expect(afterCursorLine).toBeDefined()
			const isChecked = afterCursorLine?.includes("[x]") ?? false
			trace.step(`cursor row is now ${isChecked ? "checked" : "unchecked"}`)

			expect(isChecked).toBe(!wasChecked)
		},
	)
})

test("/multi-model toggle-select title count updates after Space toggle", async ({ terminal }) => {
	// Regression: the title was previously interpolated at call-time and
	// stayed frozen at the initial count while Space toggles updated the
	// footer count, producing a cosmetic mismatch. The title must be
	// rebuilt on every render so both title and footer show the same number.
	await runKimchiSession(
		terminal,
		{
			artifactName: "multi-model-title-count",
			models: [...TWO_MODELS],
			responses: [],
		},
		async (_fixture, trace) => {
			terminal.write("/multi-model ")
			await waitForText(terminal, "/multi-model ", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("")
			await waitForText(terminal, "Model Roles", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("main menu open")

			await navigateMenuTo(terminal, trace, "Builder")
			await waitForText(terminal, "toggle models", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("toggle-select open for Builder")

			// Initial state: the Builder role's current assignment is the
			// single-model default "kimchi-dev/kimi-k2.6" (not in TWO_MODELS
			// but it still counts toward selected.size), so the title and
			// footer both read "(1 selected)".
			const beforeView = viewText(terminal)
			expect(beforeView).toMatch(/Builder\s+\u2014\s+toggle models \(1 selected\)/)
			expect(beforeView).toMatch(/\(1 selected\)/)
			trace.step("initial title and footer both show 1 selected")

			// Space toggles the cursor row (row 0 — "basic") into the
			// selection. Send Space without a trailing Enter so the picker
			// stays open and we can observe the updated render.
			terminal.write(" ")
			await new Promise((resolve) => setTimeout(resolve, 100))

			// Both the title and the footer must now agree on "(2 selected)".
			// Without the fix the title would still read "(1 selected)" while
			// the footer correctly reads "(2 selected)".
			const afterView = viewText(terminal)
			expect(afterView).toMatch(/Builder\s+\u2014\s+toggle models \(2 selected\)/)
			expect(afterView).toMatch(/\(2 selected\)/)
			trace.step("title and footer both show 2 selected after Space")

			// Escape cancels without persisting.
			terminal.keyEscape()
			await waitForText(terminal, "Model Roles", { timeoutMs: INPUT_TIMEOUT_MS })
		},
	)
})

test("/multi-model main menu cursor resets to row 0 after configuring a role", async ({ terminal }) => {
	// The main menu must not preserve cursor position across re-open. After
	// configuring a delegable role via the picker, returning to the main
	// menu should land the cursor back on the Orchestrator (row 0), not on
	// the role that was just configured. Combined with the toggle-select
	// reset test above, this pins the full no-persistence contract.
	await runKimchiSession(
		terminal,
		{
			artifactName: "multi-model-main-menu-cursor-resets",
			models: [...TWO_MODELS],
			responses: [],
		},
		async (_fixture, trace) => {
			terminal.write("/multi-model ")
			await waitForText(terminal, "/multi-model ", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("")
			await waitForText(terminal, "Model Roles", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("main menu open")

			// Configure Builder via the main menu.
			await navigateMenuTo(terminal, trace, "Builder")
			await waitForText(terminal, "toggle models", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("Builder picker open")

			// Toggle one model and confirm with Enter so the picker closes
			// via the same path the user exercises manually.
			terminal.write(" ")
			await new Promise((resolve) => setTimeout(resolve, 100))
			terminal.submit("")
			await waitForText(terminal, /Builder set to/, { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "Model Roles", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("Builder configured, back at main menu")

			// ASSERT: the cursor (`→ `) is on the Orchestrator row (row 0),
			// NOT on the Builder row we just configured. Without no-
			// persistence, this would fail with the cursor still on Builder.
			const view = viewText(terminal)
			const cursorLine = view.split("\n").find((line) => line.includes("→"))
			expect(cursorLine).toBeDefined()
			expect(cursorLine).toContain("Orchestrator")
			expect(cursorLine).not.toContain("Builder:")
			trace.step("main menu cursor reset to Orchestrator row 0")

			terminal.keyEscape()
			await waitForText(terminal, "Model Roles", { timeoutMs: INPUT_TIMEOUT_MS })
		},
	)
})

test("/multi-model orchestrator picker omits the Enter custom model... option", async ({ terminal }) => {
	// The orchestrator role picker is intentionally limited to the available
	// model registry — there is no "Enter custom model..." affordance. This
	// pins the contract so the custom-input flow cannot regress silently.
	await runKimchiSession(
		terminal,
		{
			artifactName: "multi-model-no-orchestrator-custom",
			models: [...TWO_MODELS],
			responses: [],
		},
		async (_fixture, trace) => {
			terminal.write("/multi-model ")
			await waitForText(terminal, "/multi-model ", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("")
			await waitForText(terminal, "Model Roles", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("main menu open")

			// Orchestrator is the first role row, so its summary block
			// ("Orchestrator:\n    kimchi-dev/minimax-m3") is the cursor's
			// starting position. Press Enter directly to open the picker.
			terminal.submit("")
			await waitForText(terminal, "Orchestrator", { timeoutMs: INPUT_TIMEOUT_MS })
			// The picker uses the role label + description as its prompt:
			// "Orchestrator — main model, delegates work".
			await waitForText(terminal, "delegates work", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("orchestrator picker open")

			const view = viewText(terminal)
			expect(view).not.toContain("Enter custom model")
			trace.step("no Enter custom model... option visible")

			terminal.keyEscape()
			await waitForText(terminal, "Model Roles", { timeoutMs: INPUT_TIMEOUT_MS })
		},
	)
})

/**
 * Navigate the open SelectList one step at a time until the cursor (`→ `
 * prefix on the highlighted line) lands on a line containing `target`.
 *
 * Why one-press-at-a-time? `terminal.keyDown(N)` writes N escape sequences
 * to the PTY in a single buffer; the upstream SelectList sometimes
 * processes them in chunks that skip the intended row, especially after
 * the autocomplete race workaround has already pushed the cursor down
 * one extra step. Pressing once per loop and re-reading the view avoids
 * that class of flakiness — at the cost of a few extra ms per step.
 *
 * The cursor indicator `→` comes from the upstream pi-tui SelectList
 * component (see tests/e2e/tui/ferment-phase-review.test.ts for prior
 * art using the same cursor character).
 */
async function navigateMenuTo(
	terminal: import("@microsoft/tui-test").Terminal,
	trace: { step: (label: string) => void },
	target: string,
): Promise<void> {
	for (let i = 0; i < 30; i += 1) {
		const view = viewText(terminal)
		const cursorLine = view.split("\n").find((line) => line.includes("→"))
		if (cursorLine && cursorLine.includes(target)) {
			trace.step(`cursor on "${target}"`)
			terminal.submit("")
			return
		}
		terminal.keyDown()
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
	throw new Error(`Could not navigate to menu option "${target}".`)
}

async function readSettingsJson(path: string): Promise<Record<string, any>> {
	const { readFileSync } = await import("node:fs")
	let raw: string
	try {
		raw = readFileSync(path, "utf-8")
	} catch (err) {
		throw new Error(`Settings file not found at ${path}: ${err instanceof Error ? err.message : err}`)
	}
	try {
		return JSON.parse(raw)
	} catch (err) {
		throw new Error(`Settings file at ${path} is not valid JSON: ${err instanceof Error ? err.message : err}`)
	}
}
