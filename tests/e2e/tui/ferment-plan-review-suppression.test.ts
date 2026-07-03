/**
 * E2E TUI tests: plan review suppression — propose → review → confirm/cancel.
 *
 * These tests verify the Phase 1 fix: after `propose_ferment_scoping` returns
 * "Plan ready for review", ALL tools are suppressed via `pi.setActiveTools([])`.
 * This forces the model to produce a text-only response (stopReason: "stop"),
 * which fires `agent_end` and triggers the plan-review dialog.
 *
 * Three scenarios:
 * 1. Confirm flow — model proposes, review dialog appears, user clicks Start,
 *    ferment transitions to "planned" and implementation tools are restored.
 * 2. Cancel flow — model proposes, review dialog appears, user cancels,
 *    ferment stays "draft", model regains planning tools and can re-propose.
 * 3. Regression — the existing zero-questions scoping flow still works.
 */

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText, viewText } from "./support/assertions.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const NO_COMPACTION_MODEL = { slug: "basic", displayName: "Fake Basic", contextWindow: 200_000, maxTokens: 8192 }

const PROPOSE_SCOPING_PAYLOAD = JSON.stringify({
	ferment_id: "__FERMENT_ID__",
	title: "Test Feature",
	goal: "Add a test feature to verify the plan review flow.",
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

const PROPOSE_SCOPING_PAYLOAD_2 = JSON.stringify({
	ferment_id: "__FERMENT_ID__",
	title: "Revised Test Feature",
	goal: "Add a revised test feature after user feedback.",
	success_criteria: ["Feature works correctly", "Tests pass"],
	constraints: ["no new dependencies"],
	assumptions: "Safe defaults assumed.",
	phases: [
		{
			name: "Implement",
			goal: "Build the revised feature",
			steps: [
				{
					description: "Write the revised code",
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

// ---------------------------------------------------------------------------
// Test 1: Full scoping flow with review confirmation
// ---------------------------------------------------------------------------

test("plan review: model stops after propose, review dialog appears, user confirms → ferment planned", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "plan-review-confirm",
			gitInit: true,
			models: [NO_COMPACTION_MODEL],
			responses: [
				// Turn 1: model calls propose_ferment_scoping (questions=[]).
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
				// Turn 2: tools suppressed → model produces text-only response (no tool calls).
				{ stream: ["I've submitted the plan for your review."] },
				// Turn 3: post-confirmation, keeps session alive.
				{ stream: ["Starting execution now."] },
			],
		},
		async (fixture, trace) => {
			// Stage 1: ready prompt visible.
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("ready prompt visible")

			// Stage 2: enter ferment.
			terminal.write("/ferment")
			await waitForText(terminal, "/ferment", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("typed /ferment")
			terminal.submit("")
			trace.step("ran /ferment")

			// Stage 3: intent prompt appears.
			await waitForText(terminal, "would you like to ferment", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("intent prompt visible")

			// Stage 4: submit intent → model proposes scoping.
			terminal.submit("Add a test feature")
			trace.step("submitted intent")

			// Stage 5: review dialog appears (triggered by agent_end after tool suppression).
			await waitForText(terminal, "Proceed with this plan?", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Start execution", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("plan-review dialog visible")

			// Stage 6: confirm by pressing Enter (default first option "Start execution").
			terminal.submit("")
			trace.step("confirmed 'Start execution'")

			// Stage 7: verify ferment artifact exists with status "planned".
			const artifact = await findFermentArtifact(fixture.workDir, "planned")
			expect(artifact).toBeDefined()
			trace.step("ferment artifact found with status 'planned'")

			// Stage 8: verify the post-confirmation request has planning tools restored.
			// After confirmPendingScope, the tool profile is restored to planning-ferment
			// (the ferment is "planned" but no phase is activated yet, so the profile
			// is still "planning", not "implementation"). The key thing is that tools
			// are no longer suppressed (non-empty tools array).
			const chatRequests = fixture.fake.requests.filter((req) => req.url.startsWith("/openai/v1/chat/completions"))
			expect(chatRequests.length).toBeGreaterThanOrEqual(2)
			trace.step(`${chatRequests.length} chat requests recorded`)

			// Find the first non-compaction request after the confirmation.
			// Compaction requests have system prompt "You are a context summarization assistant."
			// and no `tools` field.
			const postConfirmReq = chatRequests.slice(2).find((req) => {
				const body = req.body as Record<string, unknown>
				return Array.isArray(body.tools)
			})
			if (postConfirmReq) {
				const body = postConfirmReq.body as Record<string, unknown>
				const tools = body.tools as Array<Record<string, unknown>>
				expect(tools.length).toBeGreaterThan(0)
				trace.step("post-confirmation request has non-empty tools[] — tools restored")
			}
		},
	)
})

// ---------------------------------------------------------------------------
// Test 2: Scoping flow with review cancellation
// ---------------------------------------------------------------------------

test("plan review: cancel restores planning tools, model can re-propose, ferment stays draft", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "plan-review-cancel",
			gitInit: true,
			models: [NO_COMPACTION_MODEL],
			responses: [
				// Turn 1: model calls propose_ferment_scoping (questions=[]).
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
				// Turn 2: tools suppressed → text-only response.
				{ stream: ["Plan is ready for review."] },
				// Turn 3: after cancel, tools restored → model calls propose_ferment_scoping again.
				{
					toolCalls: [
						{
							function: {
								name: "propose_ferment_scoping",
								arguments: PROPOSE_SCOPING_PAYLOAD_2,
							},
						},
					],
				},
				// Turn 4: text-only after second review.
				{ stream: ["Revised plan ready."] },
			],
		},
		async (fixture, trace) => {
			// Stage 1: ready prompt visible.
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("ready prompt visible")

			// Stage 2: enter ferment.
			terminal.write("/ferment")
			await waitForText(terminal, "/ferment", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("typed /ferment")
			terminal.submit("")
			trace.step("ran /ferment")

			// Stage 3: intent prompt.
			await waitForText(terminal, "would you like to ferment", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("intent prompt visible")

			// Stage 4: submit intent → model proposes.
			terminal.submit("Add a test feature")
			trace.step("submitted intent")

			// Stage 5: review dialog appears.
			await waitForText(terminal, "Proceed with this plan?", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Start execution", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("first plan-review dialog visible")

			// Stage 6: cancel by pressing Escape.
			terminal.keyEscape()
			trace.step("pressed Escape — cancelled review")

			// Stage 7: wait for the review dialog to disappear before proceeding.
			// The cancel is asynchronous — submitting a revision message before it
			// completes means the model doesn't get a new turn with tools restored.
			// Poll until "Proceed with this plan?" is no longer in the terminal.
			const cancelDeadline = Date.now() + INPUT_TIMEOUT_MS
			while (Date.now() < cancelDeadline) {
				const text = viewText(terminal)
				if (!text.includes("Proceed with this plan?")) break
				await new Promise((r) => setTimeout(r, 100))
			}
			trace.step("review dialog dismissed after cancel")

			// Stage 8: verify ferment stays in "draft" status.
			const draftArtifact = await findFermentArtifact(fixture.workDir, "draft", 5000)
			expect(draftArtifact).toBeDefined()
			trace.step("ferment remains in 'draft' status after cancel")

			// Stage 9: user types a revision message → model gets new turn with tools restored.
			terminal.submit("Let me revise the plan")
			trace.step("submitted revision message")

			// Stage 9: model calls propose_ferment_scoping again (tools restored).
			// Wait for the second review dialog to appear.
			await waitForText(terminal, "Proceed with this plan?", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("second plan-review dialog appeared — model re-proposed successfully")

			// Stage 10: verify the revision request (post-cancel) includes
			// propose_ferment_scoping in the tool list, proving tools were restored.
			// Find the first chat request after the 2nd one that has a tools array
			// (skip compaction requests which have no tools field).
			const chatRequests = fixture.fake.requests.filter((req) => req.url.startsWith("/openai/v1/chat/completions"))
			expect(chatRequests.length).toBeGreaterThanOrEqual(3)
			const revisionReq = chatRequests.slice(2).find((req) => {
				const body = req.body as Record<string, unknown>
				return Array.isArray(body.tools) && body.tools.length > 0
			})
			expect(revisionReq).toBeDefined()
			const body = revisionReq?.body as Record<string, unknown>
			const tools = body.tools as Array<Record<string, unknown>>
			const toolNames = tools.map((t) => (t.function as { name: string }).name)
			expect(toolNames).toContain("propose_ferment_scoping")
			trace.step("revision request includes propose_ferment_scoping in tools[] — tools restored after cancel")
		},
	)
})

// ---------------------------------------------------------------------------
// Test 3: Regression — existing zero-questions scoping flow still works
// ---------------------------------------------------------------------------

test("plan review: existing zero-questions scoping flow still works (no regression)", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "plan-review-regression",
			gitInit: true,
			models: [NO_COMPACTION_MODEL],
			responses: [
				// Turn 1: model calls propose_ferment_scoping (questions=[]).
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
				// Turn 2: tools suppressed → text-only response (proves suppression works).
				{ stream: ["I've outlined the scope for the test feature."] },
				// Turn 3: post-confirmation.
				{ stream: ["Proceeding with execution."] },
			],
		},
		async (fixture, trace) => {
			// Stage 1: ready prompt visible.
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("ready prompt visible")

			// Stage 2: enter ferment.
			terminal.write("/ferment")
			await waitForText(terminal, "/ferment", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("typed /ferment")
			terminal.submit("")
			trace.step("ran /ferment")

			// Stage 3: intent prompt.
			await waitForText(terminal, "would you like to ferment", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("intent prompt visible")

			// Stage 4: submit intent → model proposes scoping.
			terminal.submit("Add a test feature")
			trace.step("submitted intent")

			// Stage 5: review dialog appears.
			await waitForText(terminal, "Proceed with this plan?", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Start execution", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("plan-review dialog visible")

			// Stage 6: confirm.
			terminal.submit("")
			trace.step("confirmed 'Start execution'")

			// Stage 7: verify ferment artifact with status "planned" and correct structure.
			const artifact = await findFermentArtifact(fixture.workDir, "planned")
			expect(artifact).toBeDefined()
			expect(artifact).toHaveProperty("id")
			expect(artifact).toHaveProperty("name")
			expect(artifact).toHaveProperty("goal")
			expect(artifact).toHaveProperty("phases")
			const phases = artifact?.phases as Array<Record<string, unknown>>
			expect(phases.length).toBe(1)
			expect(phases[0].name).toBe("Implement")
			trace.step("ferment artifact verified — planned, 1 phase, correct structure")

			// Stage 8: verify at least 2 HTTP requests were made.
			const chatRequests = fixture.fake.requests.filter((req) => req.url.startsWith("/openai/v1/chat/completions"))
			expect(chatRequests.length).toBeGreaterThanOrEqual(2)
			trace.step(`${chatRequests.length} chat requests recorded`)

			// Stage 9: verify the 2nd request (after tool result) had no tool calls
			// in the response (proving tool suppression worked — model produced text-only).
			// The 2nd request is the one where the model should have had no tools.
			// We can verify this by checking the `tools` array in the request body.
			// After propose_ferment_scoping returns "Plan ready for review",
			// tools are suppressed. The 2nd request should have an empty `tools` array.
			if (chatRequests.length >= 2) {
				const body = chatRequests[1].body as Record<string, unknown>
				const tools = body.tools as unknown[]
				expect(Array.isArray(tools)).toBe(true)
				expect(tools.length).toBe(0)
				trace.step("2nd request has empty tools[] — tools were suppressed after propose_ferment_scoping")
			}
		},
	)
})
