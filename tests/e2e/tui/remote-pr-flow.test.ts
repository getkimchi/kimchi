/**
 * E2E TUI test: remote PR-flow dispatch — branch intent capture.
 *
 * Human workflow under test (one flow, two variants):
 *   /ferment → intent → scoping → plan review → "Execute the plan in a
 *   remote workspace" → BRANCH PICKER appears (the slugified suggestion
 *   from the ferment goal as the first item, then "Custom name…").
 *
 *   Variant A: accept the suggested branch (first picker item) → dispatch
 *   proceeds with git intent.
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

/** Drive the shared prefix: /ferment → intent → review dialog → remote workspace choice → branch picker. */
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
	await waitForText(terminal, "Branch for the remote run", { timeoutMs: STREAM_TIMEOUT_MS })
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

test("remote dispatch offers the plan-goal branch in a picker", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{ ...SESSION_OPTIONS, artifactName: "remote-pr-flow-branch" },
		async (_fixture, trace) => {
			await driveToBranchPrompt(terminal)
			trace.step("branch picker visible")

			// The slugified suggestion from the ferment goal must be VISIBLE as
			// the first picker item — this was the placeholder-regression the
			// picker replaced. Accepting it captures the git intent.
			await waitForText(terminal, "kimchi-fix-the-login-redirect", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("suggested slug visible in the picker")
			terminal.submit("")
			trace.step("accepted the suggested branch")

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
			trace.step("branch picker visible")

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
 * pushes (canned) then fails honestly on the LOCAL pull — the seeded workdir
 * has no reachable origin.
 */
test("PR completion dropdown: push is consent-gated and the local pull fails honestly", async ({ terminal }) => {
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

			// Exactly the four PR-intent entries, user-visible. (The fifth —
			// "Review the diff in browser" — is only offered when plannotator
			// is installed; this fixture has no plannotator, and the
			// KIMCHI_E2E_FAKE_BROWSER_REVIEW seam is not set for this test.)
			await waitForText(terminal, "Request changes (steer the remote agent)", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "Push remote changes, pull and continue locally", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "Pull the changes to my machine and finish", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "Done", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("all four dropdown entries visible")

			// Declining push consent: choose Push (index 1) → consent prompt →
			// Cancel → back at the dropdown. No push, no session deletion.
			terminal.keyDown() // → Push remote changes, pull and continue locally (1)
			terminal.submit("")
			await waitForText(terminal, "Push kimchi/e2e-fix-login to origin and pull it locally?", {
				timeoutMs: INPUT_TIMEOUT_MS,
			})
			trace.step("push consent prompt visible")
			terminal.keyDown() // → Custom instructions (1 of 3)
			terminal.keyDown() // → Cancel (consent is a three-option gate: push, custom, Cancel)
			terminal.submit("")
			trace.step("declined push consent")
			await waitForText(terminal, "Remote branch kimchi/e2e-fix-login is ready", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("back at the dropdown — nothing was pushed")

			// Accepting consent: sandbox push (canned) succeeds, then the LOCAL
			// pull fails honestly (the seeded workdir has no reachable origin) →
			// error notify with the exact manual commands.
			terminal.keyDown()
			terminal.submit("")
			await waitForText(terminal, "Push kimchi/e2e-fix-login to origin and pull it locally?", {
				timeoutMs: INPUT_TIMEOUT_MS,
			})
			terminal.submit("") // consent confirm (first option)
			await waitForText(terminal, "local pull failed", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("honest local-pull failure notified")
			await waitForText(terminal, "Do it manually:", { timeoutMs: INPUT_TIMEOUT_MS })
			await waitForText(terminal, "git fetch origin kimchi/e2e-fix-login", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("exact manual commands visible")
		},
	)
})

/**
 * The browser Review surface end to end at the seam level: choosing
 * "Review the diff in browser (comment & decide)" with
 * KIMCHI_E2E_FAKE_BROWSER_REVIEW=approve MUST route through the same
 * consent-gated push as the menu's "Push remote changes, pull and continue locally" —
 * the browser is a decision surface, not an authority bypass. (The seam also
 * makes the review entry visible at all: without plannotator or the seam
 * the menu hides it.)
 * (The real plannotator/browser round-trip is unit-tested in
 * plannotator-review.test.ts; a browser cannot be driven from this TUI rig.)
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

			// Menu → Review in browser (index 0) → canned approve → consent gate.
			terminal.submit("")
			trace.step("browser review chosen, canned approval posted")

			await waitForText(terminal, "Push kimchi/e2e-fix-login to origin and pull it locally?", {
				timeoutMs: INPUT_TIMEOUT_MS,
			})
			trace.step("push consent prompt visible — approval did NOT skip consent")

			// Accept: push (canned) succeeds; the local pull fails honestly (no
			// reachable origin in the seeded workdir) → manual-commands notify.
			terminal.submit("")
			await waitForText(terminal, "local pull failed", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await waitForText(terminal, "Do it manually:", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("push done — browser approval ended in the honest local-pull failure")
		},
	)
})
