import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, test } from "@microsoft/tui-test"
import { fullText, viewText, waitForText } from "./support/assertions.js"
import { launchKimchi, PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const STRUCTURED_OUTPUT_TOOL = fileURLToPath(new URL("./support/fixtures/structured-output-tool.js", import.meta.url))

test("Codemode estimates the structured value a script receives, not the shorter display text", async ({
	terminal,
}) => {
	// The tool declares an outputSchema, so Pi hands the script its 10000-char
	// structuredContent instead of the 5-char display text.
	const script = [
		"// @description: Measure a structured report",
		"const report = await tools.structured_report({});",
		"return String(report.text.length);",
	].join("\n")

	await runKimchiSession(
		terminal,
		{
			artifactName: "codemode-outcome-structured",
			extraArgs: ["--plan=false", "--extension", STRUCTURED_OUTPUT_TOOL],
			responses: [
				{
					toolCalls: [
						{
							id: "codemode-structured",
							function: { name: "codemode", arguments: JSON.stringify({ code: script }) },
						},
					],
				},
				{ stream: ["Structured output scenario complete."] },
			],
		},
		async (_fixture, trace) => {
			terminal.submit("Run the structured output Codemode scenario")
			await waitForText(terminal, "Structured output scenario complete.", { full: false })
			expect(viewText(terminal)).toMatch(/✓ called structured_report · \d+(?:\.\d+)?(?:ms|s)/)

			terminal.keyPress("o", { ctrl: true })
			await waitForText(terminal, "Context estimate:", { full: false })
			const intermediateChars = Number(viewText(terminal).match(/intermediate tokens \((\d+) chars\)/)?.[1])
			expect(intermediateChars).toBe(JSON.stringify({ text: "x".repeat(10_000) }).length)
			trace.step("the estimate counts the structured value the script received, not the display text")
		},
	)
})

test("Codemode shows its purpose and observed actions, then replays the recorded context estimate", async ({
	terminal,
}) => {
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
			expect(collapsed).toMatch(/✓ read 1 file · \d+(?:\.\d+)?(?:ms|s)/)
			expect(collapsed).not.toContain("// @description:")
			expect(collapsed).not.toContain("Actions:")
			trace.step("purpose and the observed actions replace the repeated Codemode title and line count")

			terminal.keyPress("o", { ctrl: true })
			await waitForText(terminal, "Context estimate:", { full: false })
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
			expect(expanded).not.toMatch(/Took \d/)
			trace.step("expansion reveals the calculation inputs, then Pi's nested call rows and script output")

			terminal.submit("/quit")
			await waitForText(terminal, exitMarker, { full: false })
			launchKimchi(terminal, fixture, ["--plan=false", "--continue"], fixture.seedEnv, { exitMarker: replayMarker })
			await waitForText(terminal, PROMPT_READY, { full: false })
			await waitForText(terminal, "Codemode Filter the fixture down to its alpha lines", { full: false })
			terminal.keyPress("o", { ctrl: true })
			await waitForText(terminal, "Context estimate:", { full: false })
			const replayed = fullText(terminal)
			expect(replayed).toContain("Codemode Filter the fixture down to its alpha lines")
			expect(replayed).toContain(liveCalculation)
			trace.step("resume replays the persisted purpose and context calculation without executing the script again")
		},
	)
})
