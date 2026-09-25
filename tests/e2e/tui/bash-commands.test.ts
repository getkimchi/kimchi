import { existsSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, Key, test } from "@microsoft/tui-test"
import { fullText, viewText, waitForText } from "./support/assertions.js"
import type { FakeToolCall } from "./support/fake-openai-server.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("commands replaces the input in a tall terminal without leaving a second editor", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "bash-commands-tall",
			extraArgs: ["--plan=false"],
			env: { KIMCHI_PERMISSIONS: "default" },
			models: [{ slug: "basic", displayName: "Fake Basic", contextWindow: 200_000 }],
			responses: [
				{
					toolCalls: [
						{
							id: "tall",
							function: {
								name: "bash",
								arguments: JSON.stringify({
									command: "printf 'TALL_READY\\n'; while [ ! -f finish ]; do sleep 0.05; done",
									timeout: 90,
									checkin_interval: 60,
								}),
							},
						},
					],
				},
				{ stream: ["Tall terminal complete."] },
			],
		},
		async (fixture, trace) => {
			terminal.resize(216, 80)
			await waitForText(terminal, "default →", { full: false })
			terminal.submit("Run the tall terminal check")
			await waitForText(terminal, "Allow the assistant to run this?", { full: false })
			terminal.keyPress(Key.Enter)
			await waitForText(terminal, /^\s*▍ TALL_READY$/m, { full: false })
			const inputRow = () =>
				viewText(terminal)
					.split("\n")
					.findIndex((line) => line.includes(PROMPT_READY))
			const originalInput = inputRow()
			const menuTop = () => {
				const lines = viewText(terminal).split("\n")
				const hint = lines.findIndex((line) => /Esc (back|close)/.test(line))
				return lines.slice(0, hint).findLastIndex((line) => /^─+$/.test(line))
			}
			trace.step("short conversation leaves spare rows below the input")
			for (let cycle = 0; cycle < 3; cycle++) {
				terminal.submit("/commands")
				await waitForText(terminal, "Enter inspect", { full: false })
				expect(inputRow()).toBe(-1)
				expect(menuTop()).toBe(originalInput - 1)
				terminal.keyPress(Key.Enter)
				await waitForText(terminal, "[Script]", { full: false })
				expect(inputRow()).toBe(-1)
				expect(menuTop()).toBe(originalInput - 1)
				if (cycle === 1) {
					for (const [columns, rows] of [
						[45, 16],
						[216, 80],
					]) {
						terminal.resize(columns, rows)
						await waitForText(terminal, new RegExp(`^─{${columns}}$`, "m"), { full: false })
						await waitForText(terminal, "[Script]", { full: false })
						expect(inputRow()).toBe(-1)
						expect(viewText(terminal)).toContain("Esc back")
					}
					expect(menuTop()).toBe(originalInput - 1)
					trace.step("resizing the open detail view keeps one menu and restores its input anchor")
				}
				terminal.keyEscape()
				await waitForText(terminal, "Enter inspect", { full: false })
				terminal.keyEscape()
				await waitForText(terminal, PROMPT_READY, { full: false })
				expect(inputRow()).toBe(originalInput)
				expect(fullText(terminal).match(/Run the tall terminal check/g)).toHaveLength(1)
				trace.step(`open/close cycle ${cycle + 1} restores one editor without duplicating history`)
			}
			writeFileSync(join(fixture.workDir, "finish"), "")
			await waitForText(terminal, "Tall terminal complete.", { full: false })
			trace.step("closing restores the original input position and preserves history")
		},
	)
})

test("inspect a running Bash command without interrupting it or asking the model", async ({ terminal }) => {
	const command = [
		"cat initial.txt",
		"while [ ! -f more ]; do sleep 0.05; done",
		"for row in $(seq 1 80); do printf 'row-%02d\\n' \"$row\"; done",
		"cat waiting.txt",
		"while [ ! -f newest ]; do sleep 0.05; done",
		"cat newest.txt",
		"while [ ! -f finish ]; do sleep 0.05; done",
		"cat done.txt",
		"touch finished",
	].join("\n")
	const control: FakeToolCall = {
		id: "inspect_control",
		function: { name: "bash_control", arguments: "" },
	}
	await runKimchiSession(
		terminal,
		{
			artifactName: "bash-commands",
			extraArgs: ["--plan=false"],
			env: { KIMCHI_PERMISSIONS: "default" },
			seedHome: (_home, workDir) => {
				for (const [file, text] of Object.entries({
					"initial.txt": "output-before-checkin",
					"waiting.txt": "output-during-control-wait",
					"newest.txt": "output-after-scrolling",
					"done.txt": "command-finished-successfully",
				})) {
					writeFileSync(join(workDir, file), `${text}\n`)
				}
			},
			responses: [
				{
					toolCalls: [
						{
							id: "inspect_bash",
							function: {
								name: "bash",
								arguments: JSON.stringify({ command, description: "Inspect streaming command", timeout: 90 }),
							},
						},
					],
				},
				{
					match: (request) => {
						const handle = JSON.stringify(request.body).match(/call bash_control with handle ([\w-]+) to/)?.[1]
						if (!handle) return false
						control.function.arguments = JSON.stringify({ handle, action: "continue", checkin_interval: 60 })
						return true
					},
					toolCalls: [control],
				},
				{ stream: ["Inspection complete."] },
			],
		},
		async (fixture, trace) => {
			const requests = () => fixture.fake.requests.filter((request) => request.url === "/openai/v1/chat/completions")
			const signal = (name: string) => writeFileSync(join(fixture.workDir, name), "")
			const menuPosition = () => {
				const lines = viewText(terminal).split("\n")
				return [
					lines.findIndex((line) => /\[Script\]|Script {2}\[Output\]/.test(line)),
					lines.findIndex((line) => line.includes("Esc back")),
				]
			}
			const editorRow = () =>
				viewText(terminal)
					.split("\n")
					.findIndex((line) => line.includes("default →"))
			const menuOutput = () => viewText(terminal).split("Script  [Output]")[1]?.split("Esc back")[0] ?? ""
			await waitForText(terminal, "default →", { full: false })
			terminal.submit("Run the streaming command")
			await waitForText(terminal, "Allow the assistant to run this?", { full: false })
			terminal.keyPress(Key.Enter)
			await waitForText(terminal, "output-before-checkin", { full: false, timeoutMs: 7_000 })
			expect(requests()).toHaveLength(1)
			trace.step("initial output visible before the default fifteen-second checkin")

			await waitForText(terminal, /[Ss]till running/, { full: false, timeoutMs: 20_000 })
			expect(requests()).toHaveLength(2)
			trace.step("same command streams output during the control wait")

			terminal.submit("/commands")
			await waitForText(terminal, "Enter inspect", { full: false })
			terminal.keyPress(Key.Enter)
			await waitForText(terminal, "[Script]", { full: false })
			for (const line of command.split("\n")) expect(viewText(terminal)).toContain(line)
			expect(viewText(terminal)).not.toMatch(/[╭╮╰╯]/)
			const chatOutput = viewText(terminal).indexOf("output-before-checkin")
			expect(chatOutput).toBeGreaterThanOrEqual(0)
			expect(chatOutput).toBeLessThan(viewText(terminal).indexOf("[Script]"))
			expect(viewText(terminal)).toContain("Esc back")
			trace.step("open menu shows the script below the running command output")

			const scriptPosition = menuPosition()
			terminal.keyPress(Key.Tab)
			await waitForText(terminal, "[Output]", { full: false })
			expect(menuPosition()).toEqual(scriptPosition)
			signal("more")
			await waitForText(terminal, "output-during-control-wait", { full: false })
			expect(menuPosition()).toEqual(scriptPosition)
			trace.step("tabs and footer stay fixed as short output grows beyond the viewport")
			terminal.keyPress(Key.PageUp)
			await waitForText(terminal, "Follow: off", { full: false })
			expect(menuOutput()).not.toContain("output-during-control-wait")
			signal("newest")
			terminal.keyPress(Key.End)
			await waitForText(terminal, "output-after-scrolling", { full: false })
			await waitForText(terminal, "Follow: on", { full: false })
			trace.step("output scrolls independently; End follows fresh output")

			terminal.keyCtrlC()
			await waitForText(terminal, PROMPT_READY, { full: false })
			expect(editorRow()).toBe(TUI_TEST_CONFIG.rows - 1)
			expect(fullText(terminal).match(/Run the streaming command/g)).toHaveLength(1)
			await waitForText(terminal, "output-after-scrolling", { full: false })
			expect(requests()).toHaveLength(2)
			expect(existsSync(join(fixture.workDir, "finished"))).toBe(false)
			trace.step("Ctrl+C closes inspection without aborting or making a model request")

			terminal.submit("/commands")
			await waitForText(terminal, "Enter inspect", { full: false })
			terminal.keyPress(Key.Enter)
			await waitForText(terminal, "[Script]", { full: false })
			terminal.keyPress(Key.Tab)
			await waitForText(terminal, "[Output]", { full: false })
			signal("finish")
			await waitForText(terminal, "Exited 0", { full: false })
			await waitForText(terminal, "command-finished-successfully", { full: false })
			expect(existsSync(join(fixture.workDir, "finished"))).toBe(true)
			trace.step("completion remains readable in the open inspector")
			terminal.keyEscape()
			await waitForText(terminal, "Enter inspect", { full: false })
			terminal.keyEscape()
			await waitForText(terminal, "Inspection complete.", { full: false })
			expect(fullText(terminal).match(/Run the streaming command/g)).toHaveLength(1)
			expect(requests()).toHaveLength(3)
		},
	)
})
