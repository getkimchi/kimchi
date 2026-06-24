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
			// default orchestrator is "kimchi-dev/minimax-m3" and it has
			// builtin metadata, so the wizard will offer "keep current (X)"
			// options alongside the explicit choices.
			await waitForText(terminal, "kimchi-dev/minimax-m3", { timeoutMs: INPUT_TIMEOUT_MS })
			// Explicit assertion: if the default orchestrator ref ever
			// changes, this surfaces the failure here at the picker rather
			// than as a confusing downstream timeout waiting for the submenu.
			expect(viewText(terminal)).toContain("kimchi-dev/minimax-m3")
			terminal.submit("")
			// The submenu title is `${ref} — metadata`. Matching the full
			// `kimchi-dev/minimax-m3 — metadata` string avoids matching the
			// picker's own "Choose a model to edit metadata" header.
			await waitForText(terminal, "kimchi-dev/minimax-m3 — metadata", { timeoutMs: INPUT_TIMEOUT_MS })
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
			await waitForText(terminal, /Metadata saved for kimchi-dev\/minimax-m3\./, { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("metadata saved notification")

			// Verify on-disk state. Assert against the parsed JSON object
			// (not raw text regex) so a key reorder or pretty-print change
			// can't silently shift the failure mode.
			const settingsPath = `${fixture.homeDir}/.config/kimchi/harness/settings.json`
			const settings = await readSettingsJson(settingsPath)
			const meta = settings.modelMetadata?.["kimchi-dev/minimax-m3"]
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
