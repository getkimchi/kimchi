/**
 * E2E TUI tests for the `/ferment progress` overlay.
 *
 * Covers: the overlay opens and shows the ferment name, progress bar, phase
 * list, the "human:" timing line, and the correct step count (1/2) after a
 * complete step lifecycle (step-1 done, step-2 running).
 *
 * Approach:
 *   Pre-seed a ferment snapshot (step-1 done, step-2 running) via seedHome
 *   and activate it at startup via KIMCHI_ACTIVE_FERMENT + KIMCHI_FERMENTS_DIR.
 *
 *   KIMCHI_ACTIVE_FERMENT shows a resume dialog before PROMPT_READY appears.
 *   The `beforeReady` hook dismisses it so the fixture's PROMPT_READY wait
 *   succeeds cleanly. Choosing "Resume" calls resumeFerment which sets the
 *   active ferment in the runtime and fires a triggerTurn nudge.
 *
 *   Three WAITING responses absorb the nudge turn. We wait for "Waiting." to
 *   appear in scrollback before opening the overlay — once it does, that turn
 *   has rendered and no further responses will re-dismiss the overlay.
 *
 *   All overlay assertions use full:false (viewport only) to avoid false
 *   positives from stale scrollback content.
 */

import { randomUUID } from "node:crypto"
import { mkdirSync, realpathSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "@microsoft/tui-test"
import {
	INPUT_TIMEOUT_MS,
	STARTUP_TIMEOUT_MS,
	STREAM_TIMEOUT_MS,
	waitForText,
} from "./support/assertions.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const NOW = "2026-01-01T00:00:00.000Z"

test("/ferment progress overlay shows ferment name, progress bar, phase list, and correct step count", async ({
	terminal,
}) => {
	const FERMENT_ID = randomUUID()
	const PHASE_ID = randomUUID()
	const STEP_1_ID = randomUUID()
	const STEP_2_ID = randomUUID()

	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-progress-overlay",
			gitInit: true,
			// Three WAITING pads absorb the resume-nudge LLM turn that fires
			// when "Resume" is chosen, plus any continuation nudges afterward.
			responses: [{ stream: ["Waiting."] }, { stream: ["Waiting."] }, { stream: ["Waiting."] }],
			// Dismiss the resume dialog before the fixture's PROMPT_READY wait.
			// KIMCHI_ACTIVE_FERMENT shows this dialog immediately at startup,
			// blocking PROMPT_READY until the user makes a choice.
			beforeReady: async (t) => {
				await waitForText(t, "Resume?", { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
				t.submit("") // choose "Resume" (first item, already selected)
			},
			seedHome(_homeDir, workDir) {
				const resolvedWorkDir = realpathSync(workDir)
				const fermentsDir = join(resolvedWorkDir, ".kimchi", "ferments")
				mkdirSync(fermentsDir, { recursive: true })

				// Ferment snapshot: running, phase active, step-1 done, step-2 running.
				// No worktree.branch — branch check in checkWorktree is skipped.
				const ferment = {
					id: FERMENT_ID,
					name: "Progress Overlay Test",
					status: "running",
					worktree: { path: resolvedWorkDir },
					scoping: {},
					activePhaseId: PHASE_ID,
					phases: [
						{
							id: PHASE_ID,
							index: 1,
							name: "Implementation",
							goal: "Implement and verify the feature.",
							status: "active",
							startedAt: NOW,
							steps: [
								{
									id: STEP_1_ID,
									index: 1,
									description: "Write the code",
									status: "done",
									startedAt: NOW,
									completedAt: NOW,
									verification: { command: "true", type: "shell" },
									result: { summary: "Code written." },
								},
								{
									id: STEP_2_ID,
									index: 2,
									description: "Run the tests",
									status: "running",
									startedAt: NOW,
									verification: { command: "true", type: "shell" },
								},
							],
						},
					],
					decisions: [],
					memories: [],
					createdAt: NOW,
					updatedAt: NOW,
				}

				writeFileSync(
					join(fermentsDir, `${FERMENT_ID}.json`),
					`${JSON.stringify(ferment, null, 2)}\n`,
					"utf-8",
				)

				return {
					env: {
						KIMCHI_ACTIVE_FERMENT: FERMENT_ID,
						KIMCHI_FERMENTS_DIR: fermentsDir,
					},
				}
			},
		},
		async (_fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("ready prompt visible")

			// Wait for "Waiting." to appear in scrollback. The resume-nudge LLM
			// turn renders this text once complete, confirming no further WAITING
			// responses are in-flight. The terminal is stable at this point.
			await waitForText(terminal, "Waiting.", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("resume-nudge turn rendered — terminal stable")

			terminal.submit("/ferment progress")
			trace.step("submitted /ferment progress")

			// "human:" always appears in the overlay header and is absent from
			// the footer and all scrollback. Once visible, the full overlay is
			// rendered and all field assertions are reliable.
			await waitForText(terminal, "human:", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			trace.step("overlay open")

			await waitForText(terminal, "Progress Overlay Test", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			trace.step("overlay shows ferment name")

			await waitForText(terminal, /[█░]/, { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			trace.step("progress bar visible")

			await waitForText(terminal, "Implementation", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			trace.step("phase list visible")

			await waitForText(terminal, "1/2", { timeoutMs: INPUT_TIMEOUT_MS, full: false })
			trace.step("step count shows 1/2 (step-1 done, step-2 running)")
		},
	)
})
