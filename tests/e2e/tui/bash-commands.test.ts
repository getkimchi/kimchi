import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, Key, test } from "@microsoft/tui-test"
import { poll } from "@microsoft/tui-test/lib/utils/poll.js"
import { fullText, viewText, waitForText } from "./support/assertions.js"
import type { FakeToolCall } from "./support/fake-openai-server.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("Bash uses one descriptive header like Grep and expands the submitted command", async ({ terminal }) => {
	const command = "printf 'card-output\\n'"
	await runKimchiSession(
		terminal,
		{
			artifactName: "bash-card-layout",
			extraArgs: ["--plan=false"],
			env: { KIMCHI_PERMISSIONS: "yolo" },
			seedHome: (_home, workDir) => writeFileSync(join(workDir, "sample.txt"), "card-output\n"),
			responses: [
				{
					toolCalls: [
						{
							id: "grep-card",
							function: { name: "grep", arguments: JSON.stringify({ pattern: "card-output", path: "sample.txt" }) },
						},
					],
				},
				{
					toolCalls: [
						{
							id: "bash-card",
							function: { name: "bash", arguments: JSON.stringify({ command, description: "Check card output" }) },
						},
					],
				},
				{ stream: ["Card comparison complete."] },
			],
		},
		async (_fixture, trace) => {
			terminal.submit("Compare the tool cards")
			await waitForText(terminal, "Card comparison complete.", { full: false })
			const collapsed = viewText(terminal)
			expect(collapsed).toContain('● Grep "card-output"')
			expect(collapsed).toContain("● Bash Check card output")
			expect(collapsed.match(/Check card output/g)).toHaveLength(1)
			expect(collapsed).toContain("└─ Exited 0")
			expect(collapsed).not.toContain(command)
			expect(collapsed).not.toMatch(/Command [a-f0-9-]{36}/)
			trace.step("Grep and Bash share one status-dot header with branched results")
			terminal.keyPress("o", { ctrl: true })
			await waitForText(terminal, command, { full: false })
			expect(viewText(terminal).match(/Check card output/g)).toHaveLength(1)
			expect(viewText(terminal)).toMatch(/Command [a-f0-9-]{36}/)
			trace.step("expansion shows the command and handle without repeating the title")
		},
	)
})

test("processes preserves the fresh session position and history", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "bash-commands-fresh",
			extraArgs: ["--plan=false"],
			env: { KIMCHI_PERMISSIONS: "default" },
			responses: [],
		},
		async (_fixture, trace) => {
			await waitForText(terminal, "default →", { full: false })
			await waitForText(terminal, "Tip: Press shift+tab to change permissions mode.", { full: false })
			const baseline = viewText(terminal).split("\n")
			const history = fullText(terminal)
			const input = baseline.findIndex((line) => line.includes(PROMPT_READY))
			const aboveInput = baseline.slice(0, input - 1)
			trace.step("fresh session before any resize or model request")
			for (let cycle = 0; cycle < 3; cycle++) {
				terminal.submit("/processes")
				await waitForText(terminal, "No managed Bash commands", { full: false })
				const menuBottom = viewText(terminal)
					.split("\n")
					.findLastIndex((line) => /^─+$/.test(line))
				// Blank writes below the menu expand Warp's output block despite unchanged text rows.
				expect(terminal.getCursor().y).toBeLessThanOrEqual(menuBottom + 1)
				expect(
					viewText(terminal)
						.split("\n")
						.slice(0, input - 1),
				).toEqual(aboveInput)
				trace.step("opening leaves the fresh session content in place")
				terminal.keyEscape()
				await waitForText(terminal, PROMPT_READY, { full: false })
				expect(
					viewText(terminal)
						.split("\n")
						.slice(0, input + 1),
				).toEqual(baseline.slice(0, input + 1))
				expect(fullText(terminal)).toBe(history)
				trace.step("closing restores the fresh input at the same row")
			}
		},
	)
})

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
			await waitForText(terminal, /^\s*▍\s+TALL_READY$/m, { full: false })
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
				terminal.submit("/processes")
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
	const repeatControl: FakeToolCall = {
		id: "inspect_control_after_exit",
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
					stream: ["The command is still running; watching its output."],
				},
				{
					match: () => {
						repeatControl.function.arguments = control.function.arguments
						return control.function.arguments.length > 0
					},
					toolCalls: [repeatControl],
					stream: ["Checking the completed command once more."],
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

			await waitForText(terminal, "The command is still running", { full: false, timeoutMs: 20_000 })
			expect(requests()).toHaveLength(2)
			expect(fullText(terminal).match(/● Bash /g)).toHaveLength(1)
			expect(viewText(terminal)).not.toContain("Snapshot at check-in")
			expect(viewText(terminal).match(/Inspect streaming command/g)).toHaveLength(1)
			expect(viewText(terminal)).not.toMatch(/Command [a-f0-9-]{36}/)
			expect(viewText(terminal)).not.toContain("cat initial.txt")
			trace.step("same command streams output during the control wait")
			const inputBeforeInspection = editorRow()

			terminal.submit("/processes")
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
			// The Bash preview grows from one line to three; omission shares its footer.
			expect(editorRow()).toBe(Math.min(TUI_TEST_CONFIG.rows - 1, inputBeforeInspection + 2))
			expect(fullText(terminal).match(/Run the streaming command/g)).toHaveLength(1)
			await waitForText(terminal, "output-after-scrolling", { full: false })
			expect(requests()).toHaveLength(2)
			expect(fullText(terminal).match(/● Bash /g)).toHaveLength(1)
			expect(existsSync(join(fixture.workDir, "finished"))).toBe(false)
			trace.step("Ctrl+C closes inspection without aborting or making a model request")

			terminal.submit("/processes")
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
			expect(fullText(terminal).match(/● Bash /g)).toHaveLength(1)
			expect(fullText(terminal)).toContain("Exited 0")
			expect(fullText(terminal)).toContain("The command is still running")
			expect(fullText(terminal)).toContain("Checking the completed command once more.")
			expect(fullText(terminal)).not.toContain("unknown handle")
			expect(requests()).toHaveLength(4)
			trace.step("an extra poll after completion preserves one final Bash card without an error")
		},
	)
})

test("fullscreen processes grows from empty and supports clicking rows and tabs", async ({ terminal }) => {
	let startCommands = () => {}
	let finishResponse = () => {}
	const start = new Promise<void>((resolve) => {
		startCommands = resolve
	})
	const finish = new Promise<void>((resolve) => {
		finishResponse = resolve
	})
	await runKimchiSession(
		terminal,
		{
			artifactName: "bash-processes-mouse",
			models: [{ slug: "basic", displayName: "Fake Basic", contextWindow: 128_000 }],
			extraArgs: ["--plan=false"],
			env: { KIMCHI_PERMISSIONS: "yolo" },
			seedHome: (homeDir) => {
				const path = join(homeDir, ".config/kimchi/harness/settings.json")
				const settings = JSON.parse(readFileSync(path, "utf8"))
				writeFileSync(path, JSON.stringify({ ...settings, tuiMode: "fullscreen", showHardwareCursor: true }))
			},
			responses: [
				{
					holdUntil: start,
					toolCalls: ["A", "B", "C"].map((name, index) => ({
						id: `mouse_worker_${name}`,
						index,
						function: {
							name: "bash",
							arguments: JSON.stringify({
								command: `printf 'worker-${name}-output\\n'; while [ ! -f finish ]; do sleep 0.05; done`,
								description: `Worker ${name}`,
								timeout: 120,
								checkin_interval: 1,
							}),
						},
					})),
				},
				{ holdUntil: finish, stream: ["Mouse inspection complete."] },
			],
		},
		async (fixture, trace) => {
			try {
				const requests = () => fixture.fake.requests.filter((request) => request.url === "/openai/v1/chat/completions")
				terminal.submit("Start the three background workers")
				expect(await poll(() => requests().length === 1, 100, 10_000)).toBe(true)
				terminal.submit("/processes")
				await waitForText(terminal, "No managed Bash commands", { full: false })
				trace.step("open the empty process list while the model response is held")
				startCommands()
				await waitForText(terminal, "Processes · 3 running", { full: false })
				const list = viewText(terminal).split("Processes · 3 running")[1]?.split("Esc close")[0] ?? ""
				for (const name of ["A", "B", "C"]) expect(list).toContain(`Worker ${name}`)
				expect(list).not.toContain("printf")
				expect(await poll(() => requests().length === 2, 100, 10_000)).toBe(true)
				trace.step("all three compact rows appear without reopening")
				const workerRow = viewText(terminal)
					.split("\n")
					.findLastIndex((line) => line.includes("Worker B"))
				expect(workerRow).toBeGreaterThanOrEqual(0)
				terminal.mousePress(4, workerRow)
				await waitForText(terminal, "[Script]", { full: false })
				const clickTab = (label: string) => {
					const lines = viewText(terminal).split("\n")
					const row = lines.findIndex((line) => line.includes("[Script]") || line.includes("[Output]"))
					expect(row).toBeGreaterThanOrEqual(0)
					terminal.mousePress(lines[row].indexOf(label) + 1, row)
				}
				clickTab("Output")
				await waitForText(terminal, "[Output]", { full: false })
				expect(viewText(terminal).split("[Output]")[1]).toContain("worker-B-output")
				terminal.resize(45, 16)
				// The compact footer proves Kimchi redrew; emulator reflow alone leaves stale mouse bounds.
				await waitForText(terminal, "Esc back · Tab · PgUp/PgDn · End", { full: false })
				clickTab("Script")
				await waitForText(terminal, "[Script]", { full: false })
				expect(viewText(terminal).split("[Script]")[1]).toContain("printf 'worker-B-output")
				trace.step("mouse opens the selected script and switches both tabs after resize")
				terminal.keyCtrlC()
				await waitForText(terminal, PROMPT_READY, { full: false })
				expect(requests()).toHaveLength(2)
				terminal.submit("/processes")
				await waitForText(terminal, "Processes · 3 running", { full: false })
				terminal.keyEscape()
				await waitForText(terminal, PROMPT_READY, { full: false })
				writeFileSync(join(fixture.workDir, "finish"), "")
				finishResponse()
				await waitForText(terminal, "Mouse inspection complete.", { full: false })
				trace.step("inspection leaves all workers running and makes no extra model requests")
			} finally {
				startCommands()
				finishResponse()
			}
		},
	)
})
