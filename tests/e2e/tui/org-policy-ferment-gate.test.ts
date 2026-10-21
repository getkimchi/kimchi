/**
 * E2E TUI test: the ferment elevation gate asks before a ferment executes
 * under a restricting org policy.
 *
 * Policy allows default + auto (yolo disabled). The user scopes a ferment via
 * /ferment and confirms "Start execution" on the plan review — the gate then
 * asks whether to elevate to the highest allowed high mode (auto). Accepting
 * elevates the session to auto and the ferment proceeds; the plan review's
 * "auto" continuation request is honored (not degraded).
 *
 * Policy delivery is the real path: the fake server answers api-keys:verify
 * and settings:resolve, so the harness fetches and parses the policy itself.
 */

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { INPUT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const PROPOSE_SCOPING_PAYLOAD = JSON.stringify({
	ferment_id: "__FERMENT_ID__",
	title: "Add Cache Layer",
	goal: "Add an in-memory cache layer to the read path.",
	success_criteria: ["Cache module exposes get/set with TTL"],
	constraints: ["no new dependencies"],
	assumptions: "The lookup is idempotent.",
	phases: [
		{
			name: "Cache module",
			goal: "Create the cache module.",
			steps: [{ description: "Write src/cache.ts.", verify: "pnpm vitest run src/cache.test.ts" }],
		},
	],
	questions: [],
	gates: [
		{
			id: "P1",
			verdict: "pass",
			rationale: "Each step has a verify command",
			evidence: "step-1: vitest",
		},
		{
			id: "P2",
			verdict: "omitted",
			rationale: "Single phase, no ordering concerns",
			evidence: "n/a",
		},
		{
			id: "P3",
			verdict: "pass",
			rationale: "Validation gate will check files + tests",
			evidence: "step-1: vitest",
		},
	],
})

test("ferment gate offers the highest allowed mode and proceeds on accept", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "org-policy-ferment-gate",
			gitInit: true,
			// Yolo disallowed, auto allowed: the gate must offer auto (not yolo).
			policy: { modes: { plan: true, default: true, auto: true, yolo: false } },
			// The fixture pins KIMCHI_PERMISSIONS=yolo so generic TUI e2e never
			// blocks on permission prompts; this scenario needs the session to
			// start in default so the gate ladder actually asks. envEntries are
			// appended after the pin, so this override wins.
			env: { KIMCHI_PERMISSIONS: "default" },
			responses: [
				{
					stream: ["I'll outline the scope."],
					toolCalls: [
						{
							function: {
								name: "propose_ferment_scoping",
								arguments: PROPOSE_SCOPING_PAYLOAD,
							},
						},
					],
				},
				// Post-elevation: the continuation wake-up gets a short ack.
				{ stream: ["Cache module done."] },
			],
		},
		async (fixture, trace) => {
			// Stage 1: ready prompt.
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("ready prompt visible")

			// Stage 2: start the ferment.
			terminal.write("/ferment")
			await waitForText(terminal, "/ferment", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("")
			trace.step("ran /ferment")

			// Stage 3: intent prompt → submit intent.
			await waitForText(terminal, "would you like to ferment", { timeoutMs: STARTUP_TIMEOUT_MS })
			terminal.submit("Add a cache layer")
			trace.step("submitted intent")

			// Stage 4: plan-review dialog → confirm "Start execution".
			await waitForText(terminal, "Proceed with this plan?", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Start execution", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("")
			trace.step("confirmed 'Start execution'")

			// Stage 5: the elevation gate appears BEFORE the ferment activates —
			// asking to elevate to the highest policy-allowed high mode (auto).
			// yolo is not offered: the policy disables it.
			await waitForText(terminal, "Elevate for unattended execution?", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Elevate to auto & run", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("elevation gate visible — offers auto, not yolo")

			// Stage 6: accept (first option) — the session elevates to auto and
			// the ferment proceeds to execution.
			terminal.submit("")
			await waitForText(terminal, /^auto(?: → shift\+tab)? ·/m, { full: false, timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("accepted elevation — session mode is auto")

			// Stage 7: the scoped ferment artifact was persisted and the scheduler
			// woke the planner (second model turn consumed).
			const fermentsDir = join(fixture.workDir, ".kimchi", "ferments")
			const deadline = Date.now() + STREAM_TIMEOUT_MS
			let scoped = false
			while (Date.now() < deadline) {
				try {
					for (const f of readdirSync(fermentsDir).filter((f) => f.endsWith(".json"))) {
						const content = JSON.parse(readFileSync(join(fermentsDir, f), "utf-8"))
						if (Array.isArray(content.phases) && content.phases.length > 0) scoped = true
					}
				} catch {
					// ferments dir not created yet — retry until the deadline.
				}
				if (scoped) break
				await new Promise((resolve) => setTimeout(resolve, 100))
			}
			expect(scoped).toBe(true)
			trace.step("scoped ferment artifact persisted — execution proceeded after elevation")
		},
	)
})

test("ferment gate decline runs degraded with manual continuation", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "org-policy-ferment-gate-decline",
			gitInit: true,
			// Same policy as the accept scenario: auto is the offered elevation.
			policy: { modes: { plan: true, default: true, auto: true, yolo: false } },
			// Start in default so the gate ladder actually asks (see accept test).
			env: { KIMCHI_PERMISSIONS: "default" },
			responses: [
				{
					stream: ["I'll outline the scope."],
					toolCalls: [
						{
							function: {
								name: "propose_ferment_scoping",
								arguments: PROPOSE_SCOPING_PAYLOAD,
							},
						},
					],
				},
				// Declined elevation: the continuation wake-up runs degraded.
				{ stream: ["Cache module done."] },
			],
		},
		async (_fixture, trace) => {
			// Stage 1: ready prompt.
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("ready prompt visible")

			// Stage 2: start the ferment.
			terminal.write("/ferment")
			await waitForText(terminal, "/ferment", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("")
			trace.step("ran /ferment")

			// Stage 3: intent prompt → submit intent.
			await waitForText(terminal, "would you like to ferment", { timeoutMs: STARTUP_TIMEOUT_MS })
			terminal.submit("Add a cache layer")
			trace.step("submitted intent")

			// Stage 4: plan-review dialog → confirm "Start execution".
			await waitForText(terminal, "Proceed with this plan?", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Start execution", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("")
			trace.step("confirmed 'Start execution'")

			// Stage 5: the elevation gate appears — decline it this time.
			await waitForText(terminal, "Elevate for unattended execution?", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Run in default (degraded)", { timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("elevation gate visible")

			// Stage 6: move to the second option ("Run in default (degraded)") and
			// confirm — the session must NOT elevate.
			terminal.keyDown()
			terminal.submit("")
			await waitForText(terminal, "Running ferment in default mode (degraded)", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("declined elevation — degraded warning visible")

			// Stage 7: no elevation — the status line still shows the default mode.
			await waitForText(terminal, /^default(?: → shift\+tab)? ·/m, { full: false, timeoutMs: INPUT_TIMEOUT_MS })
			trace.step("status line still default — no elevation")
		},
	)
})

test("plan-only policy refuses /ferment", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "org-policy-ferment-gate-plan-only",
			gitInit: true,
			// Only plan is allowed: ferment has no executable mode and must be
			// refused outright. KIMCHI_PERMISSIONS=default clamps to plan.
			policy: { modes: { plan: true, default: false, auto: false, yolo: false } },
			env: { KIMCHI_PERMISSIONS: "default" },
			responses: [{ stream: ["Session ready."] }],
		},
		async (_fixture, trace) => {
			// Stage 1: ready prompt.
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("ready prompt visible")

			// Stage 2: start the ferment.
			terminal.write("/ferment")
			await waitForText(terminal, "/ferment", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("")
			trace.step("ran /ferment")

			// Stage 3: intent prompt → submit intent.
			await waitForText(terminal, "would you like to ferment", { timeoutMs: STARTUP_TIMEOUT_MS })
			terminal.submit("Add a cache layer")
			trace.step("submitted intent")

			// Stage 4: the refusal — a plan-only policy cannot run ferments.
			await waitForText(terminal, "Your organization's policy only allows plan mode", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			trace.step("refusal visible — ferment cannot run under a plan-only policy")

			// Stage 5: the plan-review dialog must never have shown.
			expect(viewText(terminal)).not.toContain("Proceed with this plan?")
			trace.step("no plan-review dialog appeared")
		},
	)
})

// Regression: /ferment new "Title" used to create + activate a ferment without
// the isFermentRunnable refusal (only the bare-intent path checked the policy).
test("plan-only policy refuses /ferment new with an inline title", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "org-policy-ferment-gate-plan-only-new",
			gitInit: true,
			policy: { modes: { plan: true, default: false, auto: false, yolo: false } },
			env: { KIMCHI_PERMISSIONS: "default" },
			responses: [{ stream: ["Session ready."] }],
		},
		async (_fixture, trace) => {
			// Stage 1: ready prompt.
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("ready prompt visible")

			// Stage 2: start a ferment with an inline title (skips the intent prompt).
			terminal.write('/ferment new "Add a cache layer"')
			await waitForText(terminal, '/ferment new "Add a cache layer"', { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit("")
			trace.step("ran /ferment new with inline title")

			// Stage 3: the refusal — up front, before anything is created.
			await waitForText(terminal, "Your organization's policy only allows plan mode", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			trace.step("refusal visible — /ferment new refused under a plan-only policy")

			// Stage 4: no scoping editor prompt and no plan-review dialog.
			expect(viewText(terminal)).not.toContain("What would you like to ferment?")
			expect(viewText(terminal)).not.toContain("Proceed with this plan?")
			trace.step("no scoping prompt, no plan-review dialog")
		},
	)
})
