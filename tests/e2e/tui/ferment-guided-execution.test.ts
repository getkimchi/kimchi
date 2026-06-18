import { expect, test } from "@microsoft/tui-test"
import type { Terminal } from "@microsoft/tui-test/lib/terminal/term.js"
import { INPUT_TIMEOUT_MS, STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, fullText, waitForText } from "./support/assertions.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const pGates = [
	{ id: "P1", verdict: "pass", rationale: "Plan includes verification", evidence: "success criteria" },
	{ id: "P2", verdict: "omitted", rationale: "No parallel work needed", evidence: "n/a" },
	{ id: "P3", verdict: "omitted", rationale: "No separate risk tier", evidence: "n/a" },
]

function proposeScope(args: {
	id: string
	title: string
	goal: string
	successCriteria: string[]
	phases: { name: string; goal: string }[]
}) {
	return {
		toolCalls: [
			{
				id: args.id,
				function: {
					name: "propose_ferment_scoping",
					arguments: JSON.stringify({
						ferment_id: "__FERMENT_ID__",
						title: args.title,
						goal: args.goal,
						success_criteria: args.successCriteria,
						phases: args.phases,
						questions: [],
						gates: pGates,
					}),
				},
			},
		],
	}
}

function activatePhase(id: string) {
	return {
		toolCalls: [
			{
				id,
				function: {
					name: "activate_ferment_phase",
					arguments: JSON.stringify({ ferment_id: "__FERMENT_ID__" }),
				},
			},
		],
	}
}

async function startFerment(terminal: Terminal, goal: string): Promise<void> {
	terminal.write("/ferment")
	await waitForText(terminal, "/ferment", { timeoutMs: INPUT_TIMEOUT_MS })
	terminal.submit("")
	await waitForText(terminal, "would you like to ferment", { timeoutMs: STARTUP_TIMEOUT_MS })
	terminal.submit(goal)
}

async function focusOption(terminal: Terminal, pattern: RegExp, maxDowns = 6): Promise<void> {
	for (let i = 0; i <= maxDowns; i++) {
		pattern.lastIndex = 0
		if (pattern.test(fullText(terminal))) return
		terminal.keyDown()
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
	throw new Error(`Could not focus option ${String(pattern)}.\n\nTerminal:\n${fullText(terminal)}`)
}

test("ferment guided execution starts after the user confirms the plan", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-guided-execution",
			gitInit: true,
			responses: [
				proposeScope({
					id: "call_scope_happy",
					title: "TOML support extension",
					goal: "Add a new extension for TOML support.",
					successCriteria: ["TOML extension is registered", "Extension behavior is covered by tests"],
					phases: [{ name: "Add TOML extension", goal: "Register TOML support and verify the extension path" }],
				}),
				{ stream: ["Draft plan:\n- Add TOML extension\nDoes this look right?"] },
				activatePhase("call_activate_happy"),
				{ stream: ["Ferment work has started for the TOML extension."] },
			],
		},
		async (_fixture, trace) => {
			await startFerment(terminal, "Add a new extension for toml support")
			trace.step("submitted ferment goal")

			await waitForText(terminal, "Yes, this looks right", { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.submit("")
			trace.step("accepted draft plan")

			await waitForText(terminal, "Review the proposed phases", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Add TOML extension", { timeoutMs: STREAM_TIMEOUT_MS })
			await focusOption(terminal, /→\s*✓ Confirm and start/)
			terminal.submit("")
			trace.step("confirmed phase list")

			await waitForText(terminal, "Activate Ferment Phase", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Ferment work has started for the TOML extension.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Running · Stop: Phase Boundary", { timeoutMs: STREAM_TIMEOUT_MS })
		},
	)
})

test("ferment plan rejection accepts feedback before starting the revised plan", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-plan-rejection-revision",
			gitInit: true,
			responses: [
				proposeScope({
					id: "call_scope_initial",
					title: "TOML extension draft",
					goal: "Add TOML support in one pass.",
					successCriteria: ["TOML support exists"],
					phases: [{ name: "Wire TOML extension", goal: "Add TOML support as one broad phase" }],
				}),
				{ stream: ["Initial plan:\n- Wire TOML extension\nDoes this look right?"] },
				proposeScope({
					id: "call_scope_revised",
					title: "TOML extension plan",
					goal: "Split TOML work into parser and UI phases with verification.",
					successCriteria: [
						"Parser handles TOML fixtures",
						"UI exposes TOML extension metadata",
						"Verification covers both phases",
					],
					phases: [
						{ name: "Parser phase", goal: "Add TOML parser behavior and fixtures" },
						{ name: "UI verification phase", goal: "Expose TOML metadata and verify the user-facing path" },
					],
				}),
				{ stream: ["Revised plan:\n- Parser phase\n- UI verification phase\nDoes this look right?"] },
				activatePhase("call_activate_revised"),
				{ stream: ["Revised plan accepted and execution started."] },
			],
		},
		async (fixture, trace) => {
			const feedback = "split this into parser and UI phases, and add verification"

			await startFerment(terminal, "Add a new extension for toml support")
			trace.step("submitted ferment goal")

			await waitForText(terminal, "No, revise", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Let me say something else", { timeoutMs: STREAM_TIMEOUT_MS })
			await focusOption(terminal, /→\s*Let me say something else/)
			terminal.submit("")
			await waitForText(terminal, "Your message:", { timeoutMs: INPUT_TIMEOUT_MS })
			terminal.submit(feedback)
			trace.step("sent revision feedback")

			await waitForText(terminal, "Revised plan:", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Parser phase", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "UI verification phase", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(fullText(terminal)).not.toContain("Activate Ferment Phase")

			terminal.submit("")
			trace.step("accepted revised draft")

			await waitForText(terminal, "Review the proposed phases", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Parser phase", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "UI verification phase", { timeoutMs: STREAM_TIMEOUT_MS })
			await focusOption(terminal, /→\s*✓ Confirm and start/)
			terminal.submit("")
			trace.step("confirmed revised phase list")

			await waitForText(terminal, "Activate Ferment Phase", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Revised plan accepted and execution started.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Running · Stop: Phase Boundary", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(JSON.stringify(fixture.fake.requests.map((request) => request.body))).toContain(feedback)
		},
	)
})
