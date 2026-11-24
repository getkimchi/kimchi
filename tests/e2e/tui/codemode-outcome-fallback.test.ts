import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { viewText, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("Codemode without a purpose keeps the legacy title and shows no estimate when nothing was filtered", async ({
	terminal,
}) => {
	const script = 'return "tiny";'

	await runKimchiSession(
		terminal,
		{
			artifactName: "codemode-outcome-fallback",
			extraArgs: ["--plan=false"],
			responses: [
				{
					toolCalls: [
						{
							id: "codemode-fallback",
							function: { name: "codemode", arguments: JSON.stringify({ code: script }) },
						},
					],
				},
				{ stream: ["Legacy fallback complete."] },
			],
		},
		async (_fixture, trace) => {
			terminal.submit("Run the legacy Codemode fallback")
			await waitForText(terminal, "Legacy fallback complete.", { full: false })
			const collapsed = viewText(terminal)
			expect(collapsed).toContain("● Codemode Codemode")
			expect(collapsed).toMatch(/✓ Script completed · \d+(?:\.\d+)?(?:ms|s)/)
			trace.step("a script without a purpose keeps the legacy title")

			terminal.keyPress("o", { ctrl: true })
			await waitForText(terminal, "tiny", { full: false })
			expect(viewText(terminal)).not.toContain("Context estimate:")
			trace.step("a script with no nested calls filtered nothing, so no estimate is shown")
		},
	)
})

test("Codemode shows a complete context estimate for a failed script", async ({ terminal }) => {
	const script = [
		"// @description: Filter the fixture before failing deliberately",
		'const source = await tools.read({ path: "fixture.txt" });',
		'if (!source.includes("alpha")) throw new Error("missing alpha");',
		'throw new Error("intentional-codemode-failure");',
	].join("\n")

	await runKimchiSession(
		terminal,
		{
			artifactName: "codemode-outcome-failed",
			extraArgs: ["--plan=false"],
			seedHome: (_home, workDir) => {
				writeFileSync(join(workDir, "fixture.txt"), "alpha\n".repeat(200))
			},
			responses: [
				{
					toolCalls: [
						{
							id: "codemode-failed",
							function: { name: "codemode", arguments: JSON.stringify({ code: script }) },
						},
					],
				},
				{ stream: ["Failed Codemode scenario complete."] },
			],
		},
		async (_fixture, trace) => {
			terminal.submit("Run the failed Codemode outcome scenario")
			await waitForText(terminal, "Failed Codemode scenario complete.", { full: false })
			const collapsed = viewText(terminal)
			expect(collapsed).toContain("● Codemode Filter the fixture before failing deliberately")
			expect(collapsed).toMatch(
				/✗ Script failed: Error: intentional-codemode-failure · read 1 file · \d+(?:\.\d+)?(?:ms|s)/,
			)
			trace.step("a failed script shows why it failed and the actions it completed, without expanding")

			terminal.keyPress("o", { ctrl: true })
			await waitForText(terminal, "Context estimate:", { full: false })
			expect(viewText(terminal)).toMatch(/Context estimate: ≈\d+(?:\.\d+)?[km]? intermediate tokens/)
			expect(viewText(terminal)).not.toContain("Wall time")
		},
	)
})

test("Codemode keeps overall success when the script catches a nested failure", async ({ terminal }) => {
	const script = [
		"// @description: Filter successful reads and tolerate a missing file",
		'const [source, missing] = await Promise.allSettled([tools.read({ path: "fixture.txt" }), tools.read({ path: "missing.txt" })]);',
		'if (source.status !== "fulfilled") throw new Error("fixture read failed");',
		'if (missing.status !== "rejected") throw new Error("missing fixture unexpectedly loaded");',
		'return source.value.split("\\n").filter(line => line.includes("alpha")).slice(0, 2).join("\\n");',
	].join("\n")

	await runKimchiSession(
		terminal,
		{
			artifactName: "codemode-outcome-nested-failure",
			extraArgs: ["--plan=false"],
			seedHome: (_home, workDir) => {
				writeFileSync(join(workDir, "fixture.txt"), "alpha intermediate payload\n".repeat(100))
			},
			responses: [
				{
					toolCalls: [
						{
							id: "codemode-nested-failure",
							function: { name: "codemode", arguments: JSON.stringify({ code: script }) },
						},
					],
				},
				{ stream: ["Nested failure scenario complete."] },
			],
		},
		async (_fixture, trace) => {
			terminal.submit("Run the nested Codemode failure scenario")
			await waitForText(terminal, "Nested failure scenario complete.", { full: false })
			const collapsed = viewText(terminal)
			expect(collapsed).toMatch(/✓ read 1 file, 1 failed · \d+(?:\.\d+)?(?:ms|s)/)
			expect(collapsed).not.toContain("⚠")
			trace.step("a caught nested failure is counted as failed, not as a completed read, under overall success")

			terminal.keyPress("o", { ctrl: true })
			await waitForText(terminal, 'read {"path":"missing.txt"}', { full: false })
			const expanded = viewText(terminal)
			expect(expanded).toContain('✗ read {"path":"missing.txt"}')
			expect(expanded).toMatch(/Context estimate: ≈\d+(?:\.\d+)?[km]? intermediate tokens/)
		},
	)
})
