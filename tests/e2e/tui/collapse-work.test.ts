import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { fullText, STARTUP_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import { harnessSettingsPath, launchKimchi, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const ALPHA = "ALPHA_COLLAPSE_CONTENT"
const BETA = "BETA_COLLAPSE_CONTENT"
const INTERIM = "INTERIM_COLLAPSE_MARKER"
const FINAL = "DISPLAY_MODE_COMPLETE"
type DisplayMode = "all" | "tools" | "off"

function seedCollapseWork(mode: DisplayMode, homeDir: string): void {
	const path = harnessSettingsPath(homeDir)
	const settings = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>
	writeFileSync(path, JSON.stringify({ ...settings, collapseWork: mode }, null, "\t"))
}

function successfulResponses() {
	return [
		{
			toolCalls: [{ id: "read-alpha", function: { name: "read", arguments: JSON.stringify({ path: "a.txt" }) } }],
		},
		{
			stream: [INTERIM],
			toolCalls: [{ id: "read-beta", function: { name: "read", arguments: JSON.stringify({ path: "b.txt" }) } }],
		},
		{ stream: [FINAL] },
	]
}

function expectModeView(text: string, mode: DisplayMode, replay: boolean): void {
	expect(text).toContain(FINAL)
	if (mode === "off") {
		expect(text).toContain("● Read a.txt")
		expect(text).toContain("● Read b.txt")
		expect(text).toContain(INTERIM)
		expect(text).not.toContain("read 2 files")
		return
	}

	if (replay) expect(text).toContain("read 2 files")
	else expect(text).toMatch(/✓ Worked for .* · read 2 files/)
	expect(text).not.toContain("● Read a.txt")
	expect(text).not.toContain("● Read b.txt")
	if (mode === "all") expect(text).not.toContain(INTERIM)
	else expect(text).toContain(INTERIM)
}

for (const mode of ["all", "tools", "off"] as const) {
	test(`collapseWork ${mode}: transcript, expansion, and replay`, async ({ terminal }) => {
		const exitMarker = `COLLAPSE_WORK_${mode.toUpperCase()}_FIRST_EXIT`
		await runKimchiSession(
			terminal,
			{
				artifactName: `collapse-work-${mode}-success`,
				exitMarker,
				seedHome(homeDir, workDir) {
					seedCollapseWork(mode, homeDir)
					writeFileSync(join(workDir, "a.txt"), `${ALPHA}\n`)
					writeFileSync(join(workDir, "b.txt"), `${BETA}\n`)
				},
				responses: successfulResponses(),
			},
			async (fixture, trace) => {
				terminal.submit("Show how this display mode handles my work")
				await waitForText(terminal, FINAL, { full: false })
				if (mode === "off") await waitForText(terminal, "● Read b.txt", { full: false })
				else await waitForText(terminal, "read 2 files", { full: false })
				expectModeView(viewText(terminal), mode, false)
				trace.step(`${mode}: initial transcript matches the display mode`)

				terminal.keyPress("o", { ctrl: true })
				await waitForText(terminal, ALPHA, { full: false })
				await waitForText(terminal, BETA, { full: false })
				await waitForText(terminal, INTERIM, { full: false })
				expect(viewText(terminal)).toContain(FINAL)
				trace.step(`${mode}: expansion reveals both results and interim commentary`)

				terminal.submit("/quit")
				await waitForText(terminal, exitMarker, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
				launchKimchi(terminal, fixture, ["--continue"])
				await waitForText(terminal, FINAL, { timeoutMs: STARTUP_TIMEOUT_MS, full: true })
				if (mode === "off") await waitForText(terminal, "● Read b.txt", { full: true })
				else await waitForText(terminal, "read 2 files", { full: true })
				expectModeView(fullText(terminal), mode, true)
				trace.step(`${mode}: replay preserves the display mode contract`)
			},
		)
	})
}

for (const mode of ["all", "tools"] as const) {
	test(`collapseWork ${mode}: a failed tool remains visible in the folded run and after expansion`, async ({
		terminal,
	}) => {
		await runKimchiSession(
			terminal,
			{
				artifactName: `collapse-work-${mode}-failure`,
				seedHome(homeDir, workDir) {
					seedCollapseWork(mode, homeDir)
					writeFileSync(join(workDir, "a.txt"), `${ALPHA}\n`)
				},
				responses: [
					{
						toolCalls: [
							{ id: "read-success", function: { name: "read", arguments: JSON.stringify({ path: "a.txt" }) } },
						],
					},
					{
						toolCalls: [
							{
								id: "bash-failure",
								function: {
									name: "bash",
									arguments: JSON.stringify({ command: "printf 'SENTINEL_TOOL_ERROR\\n'; exit 1" }),
								},
							},
						],
					},
					{ stream: ["FAILURE_DETAILS_AVAILABLE"] },
				],
			},
			async (_fixture, trace) => {
				terminal.submit("Run one successful read and one failing command")
				await waitForText(terminal, "FAILURE_DETAILS_AVAILABLE", { full: false })
				await waitForText(terminal, "1 failed call", { full: false })
				expect(viewText(terminal)).toContain("1 failed call")
				expect(viewText(terminal)).not.toContain("SENTINEL_TOOL_ERROR")
				trace.step("folded run reports one failure without exposing all output")

				terminal.keyPress("o", { ctrl: true })
				await waitForText(terminal, "SENTINEL_TOOL_ERROR", { full: false })
				trace.step("expansion reveals the failed command output")
			},
		)
	})
}
