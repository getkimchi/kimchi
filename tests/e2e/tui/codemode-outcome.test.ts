import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { fullText, viewText, waitForText } from "./support/assertions.js"
import { launchKimchi, PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("Codemode shows its purpose and context outcome, then replays the recorded calculation", async ({ terminal }) => {
	const script = [
		'// @options: {"max_output_tokens": 2000}',
		"// @description: Filter the fixture down to its alpha lines",
		'const source = await tools.read({ path: "fixture.txt" });',
		'return source.split("\\n").filter(line => line.includes("alpha")).slice(0, 2).join("\\n");',
	].join("\n")
	const exitMarker = "CODEMODE_OUTCOME_EXIT"
	const replayMarker = "CODEMODE_OUTCOME_REPLAY_EXIT"

	await runKimchiSession(
		terminal,
		{
			artifactName: "codemode-outcome",
			exitMarker,
			extraArgs: ["--plan=false"],
			seedHome: (_home, workDir) => {
				const lines = Array.from(
					{ length: 40 },
					(_, index) =>
						`${index % 2 === 0 ? "alpha" : "beta"} ${String(index + 1).padStart(3, "0")} intermediate payload with enough text to measure context filtering accurately`,
				)
				writeFileSync(join(workDir, "fixture.txt"), `${lines.join("\n")}\n`)
			},
			responses: [
				{
					toolCalls: [
						{
							id: "codemode-outcome",
							function: { name: "codemode", arguments: JSON.stringify({ code: script }) },
						},
					],
				},
				{ stream: ["Codemode outcome complete."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Run the Codemode outcome scenario")
			await waitForText(terminal, "Codemode outcome complete.", { full: false })
			const collapsed = viewText(terminal)
			expect(collapsed).toContain("● Codemode Filter the fixture down to its alpha lines")
			expect(collapsed).toMatch(/✓ Script completed · \d+(?:\.\d+)?(?:ms|s)/)
			expect(collapsed).not.toContain("// @description:")
			expect(collapsed).not.toContain("Actions:")
			expect(collapsed).not.toContain("tokens kept out of context")
			trace.step("purpose and compact script status replace the repeated Codemode title and line count")

			terminal.keyPress("o", { ctrl: true })
			await waitForText(terminal, "Actions: read 1 file", { full: false })
			const expanded = viewText(terminal)
			expect(expanded).toMatch(
				/Context estimate: ≈\d+(?:\.\d+)?[km]? intermediate tokens \(\d+ chars\) → ≈\d+(?:\.\d+)?[km]? returned tokens \(\d+ chars\)/,
			)
			expect(expanded).toContain('read {"path":"fixture.txt"}')
			expect(expanded).toContain("alpha 001 intermediate payload")
			const liveCalculation = expanded.match(
				/Context estimate: ≈\d+(?:\.\d+)?[km]? intermediate tokens \(\d+ chars\) → ≈\d+(?:\.\d+)?[km]? returned tokens \(\d+ chars\)/,
			)?.[0]
			expect(liveCalculation).toBeDefined()
			trace.step("expansion reveals actions, calculation inputs, the nested call, and script output")

			terminal.submit("/quit")
			await waitForText(terminal, exitMarker, { full: false })
			launchKimchi(terminal, fixture, ["--plan=false", "--continue"], fixture.seedEnv, { exitMarker: replayMarker })
			await waitForText(terminal, PROMPT_READY, { full: false })
			await waitForText(terminal, "Codemode Filter the fixture down to its alpha lines", { full: false })
			terminal.keyPress("o", { ctrl: true })
			await waitForText(terminal, "Context estimate:", { full: false })
			const replayed = fullText(terminal)
			expect(replayed).toContain("Codemode Filter the fixture down to its alpha lines")
			expect(replayed).not.toContain("tokens kept out of context")
			expect(replayed).toContain(liveCalculation)
			trace.step("resume replays the persisted purpose and context calculation without executing the script again")
		},
	)
})
