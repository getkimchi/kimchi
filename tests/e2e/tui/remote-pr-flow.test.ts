/**
 * E2E TUI test: remote PR-flow dispatch — branch intent capture.
 *
 * Human workflow under test (one flow, two variants):
 *   /ferment → intent → scoping → plan review → "Execute the plan in a
 *   remote workspace" → BRANCH PROMPT appears (prefilled with the
 *   slugified suggestion from the ferment goal).
 *
 *   Variant A: type a branch name → dispatch proceeds with git intent.
 *   Variant B: press Escape → dispatch proceeds as a PLAIN run.
 *
 * In the hermetic fixture the cloud endpoints are unroutable, so both
 * variants land on the honest background-spawn failure path
 * ("Remote agent failed" + agents-panel entry) — the assertions target
 * the user-visible dispatch UX: the branch prompt and the honest failure.
 * The completion dropdown / consent gating are exercised end to end in the
 * third test via a seeded resumable remote_run:state entry and the
 * KIMCHI_E2E_FAKE_SANDBOX_GIT deterministic git stub.
 */

import { test } from "@microsoft/tui-test"
import type { Terminal } from "@microsoft/tui-test/lib/terminal/term.js"
import { INPUT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { type RunKimchiSessionOptions, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const PROPOSE_SCOPING_PAYLOAD = JSON.stringify({
	ferment_id: "__FERMENT_ID__",
	title: "Fix Login Redirect",
	goal: "Fix the login redirect loop.",
	success_criteria: ["Login redirects to the dashboard once"],
	constraints: ["no new dependencies"],
	assumptions: "The router has a single redirect site.",
	phases: [
		{
			name: "Fix redirect",
			goal: "Fix the redirect logic.",
			steps: [{ description: "Edit src/auth/redirect.ts", verify: "pnpm vitest run src/auth/redirect.test.ts" }],
		},
	],
	questions: [],
	gates: [
		{ id: "P1", verdict: "pass", rationale: "Step has verify", evidence: "tests pass" },
		{ id: "P2", verdict: "omitted", rationale: "single phase", evidence: "n/a" },
		{ id: "P3", verdict: "pass", rationale: "validation gate", evidence: "n/a" },
	],
})

/** Drive the shared prefix: /ferment → intent → review dialog → remote workspace choice → branch prompt. */
async function driveToBranchPrompt(terminal: Terminal): Promise<void> {
	await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
	terminal.write("/ferment")
	await waitForText(terminal, "/ferment", { timeoutMs: INPUT_TIMEOUT_MS })
	terminal.submit("")
	await waitForText(terminal, "would you like to ferment", { timeoutMs: STARTUP_TIMEOUT_MS })
	terminal.submit("Fix the login redirect")
	// Review dialog with the 4-option decision list (remote run enabled):
	//   Execute the plan locally > auto mode > a remote workspace > say something
	await waitForText(terminal, "Proceed with this plan?", { timeoutMs: STREAM_TIMEOUT_MS })
	await waitForText(terminal, "Execute the plan in a remote workspace", { timeoutMs: INPUT_TIMEOUT_MS })
	terminal.keyDown()
	terminal.keyDown()
	terminal.submit("")
	await waitForText(terminal, "Branch name for the remote run", { timeoutMs: STREAM_TIMEOUT_MS })
}

const SESSION_OPTIONS: RunKimchiSessionOptions = {
	artifactName: "remote-pr-flow",
	gitInit: true,
	// Opt back into remote run (the fixture pins KIMCHI_REMOTE_RUN=0).
	// Point the cloud endpoints at an unroutable address so the spawn
	// failure is immediate + deterministic, and hermetic.
	env: { KIMCHI_REMOTE_RUN: "1", KIMCHI_REMOTE_ENDPOINT: "http://127.0.0.1:1" },
	models: [{ slug: "basic", displayName: "Fake Basic", contextWindow: 200_000, maxTokens: 8192 }],
	responses: [
		// Turn 1: model proposes scoping; the review dialog appears.
		{
			toolCalls: [{ function: { name: "propose_ferment_scoping", arguments: PROPOSE_SCOPING_PAYLOAD } }],
		},
		// Turn 2 fallback (mode restore prompts may trigger a turn).
		{ stream: ["Standing by."] },
	],
}

test("remote dispatch prompts for the PR branch, prefilled from the plan goal", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{ ...SESSION_OPTIONS, artifactName: "remote-pr-flow-branch" },
		async (_fixture, trace) => {
			await driveToBranchPrompt(terminal)
			trace.step("branch prompt visible")

			// Type a branch name on top of the prefill, then submit.
			terminal.write("kimchi/fix-login")
			terminal.submit("")
			trace.step("submitted branch name")

			// The remote run spawns in the background, the ferment pauses, and
			// the unroutable endpoint fails honestly.
			await waitForText(terminal, "Ferment paused while the remote agent executes", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Remote agent failed", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("honest spawn failure visible")
		},
	)
})

test("Escape at the branch prompt falls back to a plain remote run", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{ ...SESSION_OPTIONS, artifactName: "remote-pr-flow-plain" },
		async (_fixture, trace) => {
			await driveToBranchPrompt(terminal)
			trace.step("branch prompt visible")

			// Escape = no intent: dispatch continues as a plain run (same honest
			// background failure in this fixture — NOT a crash path).
			terminal.keyEscape()
			await waitForText(terminal, "Remote agent failed", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("plain-run spawn failure visible")
		},
	)
})

/**
 * The completion dropdown + consent gates end to end: the
 * KIMCHI_E2E_FAKE_REMOTE_COMPLETION seam fires a deterministic PR-intent
 * completion after session start, driving the REAL completion machinery —
 * collect + verify, the dropdown, consent gates and push orchestration —
 * with KIMCHI_E2E_FAKE_SANDBOX_GIT answering all sandbox git commands (no
 * ssh, no worker — and, unlike session-resume seeding, deterministic across
 * hosts). Declining consent must invoke NO push; the consent-accept path
 * lands on the honest manual gh fallback (the seeded workdir has no git
 * host).
 */
test("PR completion dropdown: push is consent-gated and gh failure lands on the manual command", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "remote-pr-flow-completion",
			gitInit: true,
			env: {
				KIMCHI_REMOTE_RUN: "1",
				KIMCHI_REMOTE_ENDPOINT: "http://127.0.0.1:1",
				KIMCHI_E2E_FAKE_REMOTE_COMPLETION: "1",
				KIMCHI_E2E_FAKE_SANDBOX_GIT: "1",
			},
			models: [{ slug: "basic", displayName: "Fake Basic", contextWindow: 200_000, maxTokens: 8192 }],
			responses: [{ stream: ["Standing by."] }],
		},
		async (_fixture, trace) => {
			// The env-seamed completion fires the dropdown shortly after boot.
			await waitForText(terminal, "Remote branch kimchi/e2e-fix-login is ready", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			trace.step("PR completion dropdown visible")

			// Exactly the eight PR-intent entries, user-visible.
			await waitForText(terminal, "Show the diff", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "Review the diff in browser (comment & decide)", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "Show diff in external viewer", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "Request changes (steer the remote agent)", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "Push branch and open draft PR", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "Push branch and pull locally", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "Pull the changes to my machine and finish", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "Done (keep the remote session for later)", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("all eight dropdown entries visible")

			// Declining push consent: choose Push → consent prompt → Cancel →
			// back at the dropdown. No push, no gh, no session deletion.
			terminal.keyDown() // → Review the diff in browser (1)
			terminal.keyDown() // → Show diff in external viewer (2)
			terminal.keyDown() // → Request changes (3)
			terminal.keyDown() // → Push branch and open draft PR (4)
			terminal.submit("")
			await waitForText(terminal, "Push kimchi/e2e-fix-login to origin and open a draft PR?", {
				timeoutMs: INPUT_TIMEOUT_MS,
			})
			await waitForText(terminal, "secret scan: no hits", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("push consent prompt visible")
			terminal.keyDown() // → Cancel
			terminal.submit("")
			trace.step("declined push consent")
			await waitForText(terminal, "Remote branch kimchi/e2e-fix-login is ready", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("back at the dropdown — nothing was pushed")

			// Accepting consent: sandbox push (canned) succeeds, then gh fails
			// honestly (no git host in the seeded workdir) → manual command.
			terminal.keyDown()
			terminal.keyDown()
			terminal.keyDown()
			terminal.keyDown()
			terminal.submit("")
			await waitForText(terminal, "Push kimchi/e2e-fix-login to origin and open a draft PR?", {
				timeoutMs: INPUT_TIMEOUT_MS,
			})
			terminal.submit("") // consent confirm (first option)
			await waitForText(terminal, "Create it manually:", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("gh-missing manual command notified")
			await waitForText(terminal, "gh pr create --draft --head kimchi/e2e-fix-login", {
				timeoutMs: INPUT_TIMEOUT_MS,
			})
			trace.step("exact manual command visible")
		},
	)
})

/**
 * The browser Review surface end to end at the seam level: choosing
 * "Review the diff in browser (comment & decide)" with
 * KIMCHI_E2E_FAKE_BROWSER_REVIEW=approve MUST route through the same
 * consent-gated push as the menu's "Push branch and open draft PR" — the
 * browser is a decision surface, not an authority bypass.
 * (Real browser/server round-trip is unit-tested in review-server.test.ts;
 * a browser cannot be driven from this TUI rig.)
 */
test("browser review approval flows into the consent-gated push", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "remote-pr-flow-browser-review",
			gitInit: true,
			env: {
				KIMCHI_REMOTE_RUN: "1",
				KIMCHI_REMOTE_ENDPOINT: "http://127.0.0.1:1",
				KIMCHI_E2E_FAKE_REMOTE_COMPLETION: "1",
				KIMCHI_E2E_FAKE_SANDBOX_GIT: "1",
				KIMCHI_E2E_FAKE_BROWSER_REVIEW: "approve",
			},
			models: [{ slug: "basic", displayName: "Fake Basic", contextWindow: 200_000, maxTokens: 8192 }],
			responses: [{ stream: ["Standing by."] }],
		},
		async (_fixture, trace) => {
			await waitForText(terminal, "Remote branch kimchi/e2e-fix-login is ready", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})

			// Menu → Review in browser (index 1) → canned approve → consent gate.
			terminal.keyDown()
			terminal.submit("")
			trace.step("browser review chosen, canned approval posted")

			await waitForText(terminal, "Push kimchi/e2e-fix-login to origin and open a draft PR?", {
				timeoutMs: INPUT_TIMEOUT_MS,
			})
			trace.step("push consent prompt visible — approval did NOT skip consent")

			// Accept: push (canned) succeeds; gh lands on the manual fallback.
			terminal.submit("")
			await waitForText(terminal, "The branch was pushed, but no PR was opened", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await waitForText(terminal, "gh pr create --draft", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("push done — browser approval ended in the manual gh fallback")
		},
	)
})
