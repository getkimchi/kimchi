import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { fullText, viewText, waitForText } from "./support/assertions.js"
import { launchKimchi, PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

// Editor borders/input, permission warning, and footer in this fixture.
const INPUT_DOCK_ROWS = 5

for (const hasConversation of [false, true]) {
	test(`${hasConversation ? "completed" : "empty"} fullscreen exits without UI leftovers or blank padding`, async ({
		terminal,
	}) => {
		terminal.submit("export PS1='RESTORED> '")
		terminal.submit("printf 'PRIOR_LINE_%s\\n' {1..10}")
		await waitForText(terminal, "\nPRIOR_LINE_10\n")
		await runKimchiSession(
			terminal,
			{
				artifactName: `fullscreen-clean-exit-${hasConversation ? "completed" : "empty"}`,
				responses: [{ stream: ["CLEAN_EXIT_REPLY"] }],
			},
			async (fixture, trace) => {
				await waitForText(terminal, "yolo → shift+tab", { full: false })
				if (hasConversation) {
					terminal.submit("Reply with the test marker")
					await waitForText(terminal, "CLEAN_EXIT_REPLY", { full: false })
					await waitForText(terminal, "Worked for", { full: false })
				}
				terminal.submit("/quit")
				await waitForText(terminal, /\nRESTORED> *\n*$/, { full: false })
				const restored = fullText(terminal)
				for (let line = 1; line <= 10; line++) expect(restored).toContain(`\nPRIOR_LINE_${line}\n`)
				expect(restored).not.toContain("Kimchi's special")
				expect(restored).not.toContain(PROMPT_READY)
				expect(restored).not.toContain("shift+tab")
				expect(restored).not.toContain("CLEAN_EXIT_REPLY")
				if (hasConversation) {
					expect(restored).toContain("Session saved. Pick up where you left off:")
					expect(restored).toMatch(/kimchi --resume [0-9a-f-]{36}/)
				}
				const exitOutput = restored.slice(restored.indexOf("\nPRIOR_LINE_10\n"), restored.lastIndexOf("RESTORED>"))
				expect(exitOutput).not.toMatch(/\n(?:[ \t]*\n){5}/)
				trace.step("prior shell output restored without fullscreen chrome or blank padding")
				if (hasConversation) {
					const resumeCommand = restored.match(/kimchi --resume ([0-9a-f-]{36})/)
					if (!resumeCommand) throw new Error("No --resume session ID in the exit hint")
					const sessionId = resumeCommand[1]
					expect(restored.split("Session saved.").length - 1).toBe(1)
					launchKimchi(terminal, fixture, ["--resume", sessionId], fixture.seedEnv)
					await waitForText(terminal, "yolo → shift+tab", { full: false })
					await waitForText(terminal, "CLEAN_EXIT_REPLY", { full: false })
					trace.step("the displayed resume command restores the saved conversation")
				}
			},
		)
	})
}

test("the first prompt uses the bottom of the terminal", async ({ terminal }) => {
	await runKimchiSession(terminal, { artifactName: "fullscreen-startup", responses: [] }, async (_fixture, trace) => {
		await waitForText(terminal, "yolo → shift+tab", { full: false })
		const rows = viewText(terminal).split("\n")
		expect(rows.findIndex((row) => row.includes(PROMPT_READY))).toBeGreaterThanOrEqual(
			TUI_TEST_CONFIG.rows - INPUT_DOCK_ROWS,
		)
		trace.step("first prompt anchored at terminal bottom")
	})
})

test("closing resources repeatedly restores the input and footer rows", async ({ terminal }) => {
	await runKimchiSession(terminal, { artifactName: "fullscreen-resources", responses: [] }, async (_fixture, trace) => {
		await waitForText(terminal, "yolo → shift+tab", { full: false })
		const initialRows = viewText(terminal).split("\n")
		const inputRow = initialRows.findIndex((row) => row.includes(PROMPT_READY))
		const footerRow = initialRows.findIndex((row) => row.includes("ctrl+p"))
		const menus = [
			["resources", "Kimchi resources"],
			["resources", "Kimchi resources"],
			["resources", "Kimchi resources"],
			["settings", "Auto-compact"],
			["model", "Enter to select"],
			["theme", "Select color theme"],
		]
		for (const [command, heading] of menus) {
			terminal.write(`/${command}`)
			await waitForText(terminal, `/${command}`, { full: false })
			terminal.submit("")
			await waitForText(terminal, heading, { full: false })
			trace.step(`${command} opened`)
			terminal.keyEscape()
			await waitForText(terminal, PROMPT_READY, { full: false })
			const rows = viewText(terminal).split("\n")
			expect(rows.findIndex((row) => row.includes(PROMPT_READY))).toBe(inputRow)
			expect(rows.findIndex((row) => row.includes("ctrl+p"))).toBe(footerRow)
			expect(rows.filter((row) => row.includes(PROMPT_READY)).length).toBe(1)
			trace.step(`${command} closed: input and footer restored`)
		}
	})
})

test("streaming and scrolling keep the input fixed and exit preserves the transcript", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "fullscreen-transcript",
			seedHome(homeDir) {
				const path = join(homeDir, ".config/kimchi/harness/settings.json")
				const settings = JSON.parse(readFileSync(path, "utf8"))
				writeFileSync(path, JSON.stringify({ ...settings, fullscreenExitOutput: "transcript" }))
			},
			responses: [
				{
					stream: Array.from({ length: 80 }, (_, i) => `Viewport line ${String(i + 1).padStart(3, "0")}\n`),
					delayMs: 40,
				},
			],
		},
		async (_fixture, trace) => {
			await waitForText(terminal, "yolo → shift+tab", { full: false })
			const inputRow = viewText(terminal)
				.split("\n")
				.findIndex((row) => row.includes(PROMPT_READY))
			terminal.submit("Print a long transcript")
			await waitForText(terminal, "Viewport line 010", { full: false })
			expect(
				viewText(terminal)
					.split("\n")
					.findIndex((row) => row.includes(PROMPT_READY)),
			).toBe(inputRow)
			trace.step("input stays fixed while response streams")
			await waitForText(terminal, "Worked for", { full: false })
			await waitForText(terminal, "Viewport line 080", { full: false })
			terminal.write("\u001b[5~")
			await waitForText(terminal, "Viewport line 030", { full: false })
			expect(viewText(terminal)).not.toContain("Viewport line 080")
			expect(
				viewText(terminal)
					.split("\n")
					.findIndex((row) => row.includes(PROMPT_READY)),
			).toBe(inputRow)
			trace.step("PageUp scrolls transcript without moving input")
			const historyRow = viewText(terminal)
				.split("\n")
				.findIndex((row) => row.includes("Viewport line 030"))
			terminal.submit("/resources")
			await waitForText(terminal, "Kimchi resources", { full: false })
			terminal.keyEscape()
			await waitForText(terminal, PROMPT_READY, { full: false })
			expect(
				viewText(terminal)
					.split("\n")
					.findIndex((row) => row.includes("Viewport line 030")),
			).toBe(historyRow)
			trace.step("closing resources restores the scrolled transcript position")
			terminal.write("\u001b[F")
			await waitForText(terminal, "Viewport line 080", { full: false })
			terminal.submit("/quit")
			await waitForText(terminal, "Session saved.", { full: false })
			const transcript = fullText(terminal)
			for (let line = 1; line <= 80; line++) {
				expect(transcript.split(`Viewport line ${String(line).padStart(3, "0")}`).length - 1).toBe(1)
			}
			terminal.submit("printf 'SHELL_RESTORED\\n'")
			await waitForText(terminal, /\nSHELL_RESTORED\r?\n/, { full: false })
			trace.step("exit prints each transcript line once and returns control to the shell")
		},
	)
})

test("resource navigation keeps the selected item visible after shrinking the terminal", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{ artifactName: "fullscreen-small-resources", responses: [] },
		async (_fixture, trace) => {
			await waitForText(terminal, "yolo → shift+tab", { full: false })
			terminal.submit("/resources")
			await waitForText(terminal, "Kimchi resources", { full: false })
			const resizedRows = 16
			terminal.resize(45, resizedRows)
			terminal.keyDown(14)
			await waitForText(terminal, /→.*Memory/, { full: false, timeoutMs: 3000 })
			trace.step("selected resource visible in resized viewport")
			terminal.keyEscape()
			await waitForText(terminal, PROMPT_READY, { full: false })
			expect(
				viewText(terminal)
					.split("\n")
					.findIndex((row) => row.includes(PROMPT_READY)),
			).toBeGreaterThanOrEqual(resizedRows - INPUT_DOCK_ROWS)
		},
	)
})
