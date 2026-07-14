/**
 * E2E TUI test: plan review dialog appears in one-shot (automated) mode.
 *
 * Regression coverage for the case where `propose_ferment_scoping` returns
 * "Plan ready for review" under automated continuation policy. Before the
 * fix, the `turn_end` handler injected a reactive continuation nudge before
 * the pending-plan-review guard could suppress tools, starting a follow-up
 * turn and preventing `agent_end` from firing — the review dialog never
 * appeared. This test verifies the dialog surfaces and the ferment can be
 * confirmed in one-shot mode.
 */

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const NO_COMPACTION_MODEL = { slug: "basic", displayName: "Fake Basic", contextWindow: 200_000, maxTokens: 8192 }

const PROPOSE_SCOPING_PAYLOAD = JSON.stringify({
	ferment_id: "__FERMENT_ID__",
	title: "One-shot Test Feature",
	goal: "Add a test feature to verify plan review in one-shot mode.",
	success_criteria: ["Feature works correctly", "Tests pass"],
	constraints: ["no new dependencies"],
	assumptions: "Safe defaults assumed.",
	phases: [
		{
			name: "Implement",
			goal: "Build the feature",
			steps: [
				{
					description: "Write the code",
					verify: "pnpm test",
				},
			],
		},
	],
	questions: [],
	gates: [
		{ id: "P1", verdict: "pass", rationale: "Step has verify", evidence: "tests pass" },
		{ id: "P2", verdict: "omitted", rationale: "single phase", evidence: "n/a" },
		{ id: "P3", verdict: "pass", rationale: "tests", evidence: "n/a" },
	],
})

/**
 * Poll for a ferment artifact with the expected status in .kimchi/ferments/.
 * Returns the parsed artifact or undefined if not found before the deadline.
 */
async function findFermentArtifact(
	workDir: string,
	expectedStatus: string,
	timeoutMs = STREAM_TIMEOUT_MS,
): Promise<Record<string, unknown> | undefined> {
	const fermentsDir = join(workDir, ".kimchi", "ferments")
	const deadline = Date.now() + timeoutMs
	while (Date.now() < deadline) {
		try {
			const files = readdirSync(fermentsDir).filter((f) => f.endsWith(".json"))
			for (const f of files) {
				const content = JSON.parse(readFileSync(join(fermentsDir, f), "utf-8"))
				if (content.status === expectedStatus) return content
			}
		} catch {
			// dir doesn't exist yet or unreadable
		}
		await new Promise((r) => setTimeout(r, 250))
	}
	return undefined
}

test("plan review dialog appears in one-shot mode after propose_ferment_scoping", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "plan-review-oneshot",
			gitInit: true,
			models: [NO_COMPACTION_MODEL],
			extraArgs: ["--ferment-oneshot=true"],
			responses: [
				// Turn 1: model calls propose_ferment_scoping directly (questions=[]).
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
				// Turn 2: tools suppressed → model produces text-only response.
				// The test does not assert the exact text here; the important behavior
				// is that agent_end fires and the review dialog surfaces.
				{ stream: ["I've submitted the plan for your review."] },
			],
		},
		async (fixture, trace) => {
			// Stage 1: ready prompt visible.
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("ready prompt visible")

			// Stage 2: submit user request — one-shot mode bootstraps a draft ferment.
			terminal.submit("Add a test feature")
			trace.step("submitted request in one-shot mode")

			// Stage 3: review dialog appears (triggered by agent_end after tool suppression).
			// If the regression were present, a continuation nudge would fire instead and
			// this text would never appear.
			await waitForText(terminal, "Proceed with this plan?", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Start execution", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("plan-review dialog visible in one-shot mode")

			// Stage 4: confirm by pressing Enter (default first option "Start execution").
			terminal.submit("")
			trace.step("confirmed 'Start execution'")

			// Stage 5: verify the ferment transitions to "planned" after confirmation.
			// In automated one-shot mode, post-confirmation turns may inject continuation
			// nudges that compete with scripted responses, so we assert on durable state
			// rather than the next streamed message.
			const artifact = await findFermentArtifact(fixture.workDir, "planned")
			expect(artifact).toBeDefined()
			trace.step("ferment artifact found with status 'planned'")
		},
	)
})
