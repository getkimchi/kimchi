import { expect, test } from "@microsoft/tui-test"
import { fullText, viewText, waitForText } from "./support/assertions.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("the first prompt uses the bottom of the terminal", async ({ terminal }) => {
	await runKimchiSession(terminal, { artifactName: "fullscreen-startup", responses: [] }, async (_fixture, trace) => {
		await waitForText(terminal, "yolo → shift+tab", { full: false })
		const rows = viewText(terminal).split("\n")
		expect(rows.findIndex((row) => row.includes(PROMPT_READY))).toBeGreaterThanOrEqual(TUI_TEST_CONFIG.rows - 5)
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
			await waitForText(terminal, "To resume this session", { full: false })
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
			terminal.resize(45, 16)
			terminal.keyDown(14)
			await waitForText(terminal, /→.*Memory/, { full: false, timeoutMs: 3000 })
			trace.step("selected resource visible in resized viewport")
			terminal.keyEscape()
			await waitForText(terminal, PROMPT_READY, { full: false })
			expect(
				viewText(terminal)
					.split("\n")
					.findIndex((row) => row.includes(PROMPT_READY)),
			).toBeGreaterThanOrEqual(11)
		},
	)
})
