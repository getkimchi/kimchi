/**
 * TUI e2e test: review-write-guard in single-model sessions.
 *
 * The fixture launches kimchi with an explicit `--model`, which makes every
 * hermetic session single-model (resolveMultiModelEnabled → cli:false). These
 * scenarios prove the guard's user-visible behavior after a subagent returns
 * in build phase:
 *
 * 1. Six direct writes past the block threshold apply without a BLOCKED error,
 *    and the downgraded advisory steer reaches the model.
 * 2. KIMCHI_DISABLE_GUARD_REVIEW_WRITE disables the guard entirely — no block
 *    and no steer text in any provider request.
 *
 * The multi-model path (hard block still fires) is unchanged behavior covered
 * by review-write-guard.integration.test.ts.
 */

import { existsSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { fullText, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import type { RecordedRequest } from "./support/fake-openai-server.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const WRITE_COUNT = 6
const FINAL_TEXT = "All six writes completed."

function requestBodyText(request: RecordedRequest): string {
	return JSON.stringify(request.body ?? "")
}

function orchestrationResponses() {
	return [
		{
			toolCalls: [
				{
					// Distinct indices are required: the fake server defaults every
					// call to index 0, and pi merges same-index deltas into one tool
					// call (which silently drops the second call).
					index: 0,
					id: "call_guard_set_phase",
					function: {
						name: "set_phase",
						arguments: JSON.stringify({ phase: "build" }),
					},
				},
				{
					index: 1,
					id: "call_guard_agent",
					function: {
						name: "Agent",
						arguments: JSON.stringify({
							prompt: "Touch nothing; just report completion.",
							description: "guard probe agent",
							subagent_type: "Builder",
							// The guard arms on the Agent tool_result, so the main turn must
							// WAIT for the subagent — background agents return immediately and
							// the writes would never run in the guarded main session.
							run_in_background: false,
						}),
					},
				},
			],
		},
		// Consumed by the Builder subagent's own session.
		{ stream: ["Subagent finished its work."] },
		// Six writes in one turn: counts 1-6 against the armed guard. The steer
		// fires at 2, the downgraded advisory at 5, and the 6th would have been
		// hard-blocked before the single-model downgrade existed.
		{
			toolCalls: Array.from({ length: WRITE_COUNT }, (_, i) => ({
				index: i,
				id: `call_guard_write_${i + 1}`,
				function: {
					name: "write",
					arguments: JSON.stringify({
						path: `guard-probe-${i + 1}.txt`,
						content: `probe ${i + 1}`,
					}),
				},
			})),
		},
		{ stream: [FINAL_TEXT] },
	]
}

test("single-model sessions run no review-write guard at all", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "review-write-guard-single-model-disabled",
			responses: orchestrationResponses(),
		},
		async (fixture, trace) => {
			terminal.submit("Run the delegated write workflow")

			await waitForText(terminal, "guard probe agent", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("subagent spawned and rendered")

			await waitForText(terminal, FINAL_TEXT, { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("orchestrator completed after the writes")

			// Every write applied — none was blocked by the guard.
			for (let i = 1; i <= WRITE_COUNT; i++) {
				expect(existsSync(join(fixture.workDir, `guard-probe-${i}.txt`))).toBe(true)
			}
			expect(fullText(terminal)).not.toContain("BLOCKED")
			trace.step("all six writes applied, no BLOCKED error")

			// The guard never engages: no steer text reaches the model either.
			for (const request of fixture.fake.requests) {
				expect(requestBodyText(request)).not.toContain("Delegation guard")
			}
			trace.step("no guard steer text in any provider request")
		},
	)
})

test("KIMCHI_DISABLE_GUARD_REVIEW_WRITE disables the guard entirely", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "review-write-guard-kill-switch",
			env: { KIMCHI_DISABLE_GUARD_REVIEW_WRITE: "1" },
			responses: orchestrationResponses(),
		},
		async (fixture, trace) => {
			terminal.submit("Run the delegated write workflow")

			await waitForText(terminal, FINAL_TEXT, { timeoutMs: STREAM_TIMEOUT_MS })

			for (let i = 1; i <= WRITE_COUNT; i++) {
				expect(existsSync(join(fixture.workDir, `guard-probe-${i}.txt`))).toBe(true)
			}
			expect(fullText(terminal)).not.toContain("BLOCKED")
			trace.step("all six writes applied, no BLOCKED error")

			// With the kill switch on, no guard text reaches the model either.
			for (const request of fixture.fake.requests) {
				expect(requestBodyText(request)).not.toContain("Delegation guard")
			}
			trace.step("no guard steer text in any provider request")
		},
	)
})
