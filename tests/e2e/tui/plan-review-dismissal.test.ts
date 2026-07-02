/**
 * E2E TUI test: plan-review dialog dismissal clears pendingPlanReview.
 *
 * Bug being verified:
 * After `propose_ferment_scoping` sets a `pendingPlanReview` and the
 * `agent_end` handler shows the plan review dialog, dismissing the dialog
 * (Esc) or choosing "Let me say something" to provide feedback must clear
 * the `pendingPlanReview` from the in-memory map. Without the fix, the
 * stale entry persists and the dialog re-appears on the next `agent_end`.
 *
 * Both tests share the same `/ferment` entry flow used by
 * `ferment-new-runs-planning.test.ts`, then diverge:
 *   1. Esc dismissal → user types a new turn → dialog must NOT re-appear.
 *   2. Feedback submission → user types feedback → dialog must NOT
 *      re-appear after the model's response to the feedback.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import type { Terminal } from "@microsoft/tui-test/lib/terminal/term.js"
import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const PROPOSE_SCOPING_PAYLOAD = JSON.stringify({
	ferment_id: "__FERMENT_ID__",
	title: "Add Cache Layer",
	goal: "Add an in-memory cache layer.",
	success_criteria: ["Cache module exposes get/set/del with TTL"],
	constraints: ["no new dependencies"],
	assumptions: "The lookup is idempotent.",
	phases: [
		{
			name: "Cache module",
			goal: "Create the cache module.",
			steps: [{ description: "Write src/cache.ts", verify: "pnpm vitest run src/cache.test.ts" }],
		},
	],
	questions: [],
	gates: [
		{ id: "P1", verdict: "pass", rationale: "Step has verify", evidence: "tests pass" },
		{ id: "P2", verdict: "omitted", rationale: "single phase", evidence: "n/a" },
		{ id: "P3", verdict: "pass", rationale: "validation gate", evidence: "n/a" },
	],
})

/**
 * Locate any ferment artifact with `phases` array (a scoped ferment). Returns
 * undefined if the directory doesn't exist or no such artifact is present.
 */
async function findScopedFermentArtifact(
	workDir: string,
	timeoutMs: number,
): Promise<{ content: Record<string, unknown>; path: string } | undefined> {
	const fermentsDir = join(workDir, ".kimchi", "ferments")
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		if (existsSync(fermentsDir)) {
			try {
				const candidates = readdirSync(fermentsDir)
					.filter((f) => f.endsWith(".json"))
					.map((f) => {
						const fullPath = join(fermentsDir, f)
						return { path: fullPath, mtime: statSync(fullPath).mtimeMs }
					})
					.sort((a, b) => b.mtime - a.mtime)
				for (const c of candidates) {
					const content = JSON.parse(readFileSync(c.path, "utf-8"))
					const phases = Array.isArray(content.phases) ? content.phases : []
					if (phases.length > 0) {
						return { content, path: c.path }
					}
				}
			} catch {
				// dir unreadable mid-flight; keep polling
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 250))
	}
	return undefined
}

/**
 * Poll until the plan-review dialog is no longer visible in the terminal.
 *
 * Waiting for the startup prompt copy ("ask anything or type / for commands")
 * is unreliable — after a completed turn the idle prompt can render as a
 * bare ❯ with footer text. Instead, poll for the absence of the dialog's
 * signature strings.
 */
async function waitForPlanReviewClosed(terminal: Terminal, timeoutMs = INPUT_TIMEOUT_MS): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		const text = viewText(terminal)
		if (
			!text.includes("Proceed with this plan?") &&
			!text.includes("Start execution in auto mode") &&
			!text.includes("Let me say something")
		) {
			return
		}
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
	throw new Error(`Timed out waiting for plan review to close.\n\nTerminal:\n${viewText(terminal)}`)
}

test("plan review dialog does not re-appear after Esc dismissal", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "plan-review-dismissal-esc",
			gitInit: true,
			// Large context window prevents pi-mono's built-in compaction from
			// firing mid-test and consuming scripted responses.
			models: [{ slug: "basic", displayName: "Fake Basic", contextWindow: 200_000, maxTokens: 8192 }],
			responses: [
				// Turn 1: model calls propose_ferment_scoping.
				{
					toolCalls: [
						{
							function: {
								name: "propose_ferment_scoping",
								arguments: PROPOSE_SCOPING_PAYLOAD,
							},
						},
					],
				},
				// Turn 1 continuation after the tool result is sent back.
				{ stream: ["Plan ready for review."] },
				// Turn 2 (after the new user turn): short text response.
				{ stream: ["Understood, I'll wait for your direction."] },
			],
		},
		async (fixture, trace) => {
			// Stage 1: ready prompt visible.
			await waitForText(terminal, "ask anything or type / for commands", {
				timeoutMs: STARTUP_TIMEOUT_MS,
			})

			// Stage 2: enter ferment. Type then Enter separately — one-shot
			// "/ferment\r" can race startup.
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
			terminal.submit("Add a cache layer")
			trace.step("submitted intent")

			// Stage 5: plan-review dialog appears.
			await waitForText(terminal, "Proceed with this plan?", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await waitForText(terminal, "Start execution", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("plan-review dialog visible")

			// Stage 6: dismiss with Esc → handler resolves with
			// { kind: "cancelled" } and must clear the pendingPlanReview entry.
			terminal.keyEscape()
			trace.step("pressed Esc")

			// Stage 7: wait for the plan-review dialog to close. Waiting for
			// the startup prompt copy is unreliable — the idle prompt can
			// render as a bare ❯ with footer text. Instead, poll until the
			// dialog's signature strings are gone from the viewable buffer.
			await waitForPlanReviewClosed(terminal)
			trace.step("plan-review dialog closed")

			// Stage 8: trigger a new turn. If pendingPlanReview was not cleared,
			// agent_end → setTimeout(0) will re-present the dialog here.
			terminal.submit("hello")
			trace.step("sent hello")

			// Stage 9: wait for the model's response to land.
			await waitForText(terminal, "Understood", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("model responded")

			// Stage 10: the dialog is shown via setTimeout(0) after agent_end,
			// which fires after the response text is already in the buffer. Wait
			// a bit longer than that, then assert the viewable buffer is clean.
			await new Promise((resolve) => setTimeout(resolve, 500))
			expect(viewText(terminal)).not.toContain("Proceed with this plan?")
			trace.step("verified: dialog did not re-appear")

			// Stage 11: no scoped ferment artifact should exist (the dialog
			// was cancelled, so confirmPendingScope never ran).
			const scoped = await findScopedFermentArtifact(fixture.workDir, 1_000)
			expect(scoped).toBeUndefined()
			trace.step("verified: no scoped ferment artifact persisted")
		},
	)
})

test("plan review dialog does not re-appear after feedback", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "plan-review-dismissal-feedback",
			gitInit: true,
			// Large context window prevents pi-mono's built-in compaction from
			// firing mid-test and consuming scripted responses.
			models: [{ slug: "basic", displayName: "Fake Basic", contextWindow: 200_000, maxTokens: 8192 }],
			responses: [
				// Turn 1: model calls propose_ferment_scoping.
				{
					toolCalls: [
						{
							function: {
								name: "propose_ferment_scoping",
								arguments: PROPOSE_SCOPING_PAYLOAD,
							},
						},
					],
				},
				// Turn 1 continuation after the tool result is sent back.
				{ stream: ["Plan ready for review."] },
				// Turn 2 (after the feedback): short text response.
				{ stream: ["Got it — I'll revise the plan based on your feedback."] },
			],
		},
		async (fixture, trace) => {
			// Stage 1: ready prompt visible.
			await waitForText(terminal, "ask anything or type / for commands", {
				timeoutMs: STARTUP_TIMEOUT_MS,
			})

			// Stage 2: enter ferment.
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
			terminal.submit("Add a cache layer")
			trace.step("submitted intent")

			// Stage 5: plan-review dialog appears.
			await waitForText(terminal, "Proceed with this plan?", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await waitForText(terminal, "Start execution", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("plan-review dialog visible")

			// Stage 6: navigate to "Let me say something" (index 2). The
			// cursor starts at index 0 ("Start execution"), so two keyDown
			// presses land on index 2.
			terminal.keyDown()
			terminal.keyDown()
			trace.step("navigated to 'Let me say something'")
			terminal.submit("")
			trace.step("selected 'Let me say something'")

			// Stage 7: the feedback editor appears with the "Your direction:" label.
			await waitForText(terminal, "Your direction:", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("feedback editor visible")

			// Stage 8: submit feedback text. This submits the editor, which
			// resolves the dialog with { kind: "feedback", text } and must
			// clear the pendingPlanReview entry.
			terminal.submit("Make the cache TTL configurable")
			trace.step("submitted feedback")

			// Stage 9: wait for the model's response to the feedback.
			await waitForText(terminal, "Got it", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("model responded to feedback")

			// Stage 10: agent_end → setTimeout(0) would re-present the dialog
			// if pendingPlanReview was not cleared. Wait, then assert.
			await new Promise((resolve) => setTimeout(resolve, 500))
			expect(viewText(terminal)).not.toContain("Proceed with this plan?")
			trace.step("verified: dialog did not re-appear")
		},
	)
})
