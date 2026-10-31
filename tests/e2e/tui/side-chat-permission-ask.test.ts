/**
 * Side chat × permission ask focus regression tests.
 *
 * A permission ask (`ctx.ui.select`) lives in the main pane's editor slot and
 * is keyboard-only: once unfocused there is no mouse path back to it. The
 * side chat must never strand it unfocused:
 *
 *   1. Opening/focusing the side chat (e.g. via the "Add to side chat" pill)
 *      while an ask is open must keep the focus on the ask.
 *   2. Closing the side chat while an ask is open must hand the focus to the
 *      ask — before the fix it focused the main editor, so Escape aborted the
 *      whole turn instead of dismissing the ask.
 */

import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import type { Terminal } from "@microsoft/tui-test/lib/terminal/term.js"
import { poll } from "@microsoft/tui-test/lib/utils/poll.js"
import { STREAM_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import type { FakeResponseRequest } from "./support/fake-openai-server.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const CTRL_ALT_LEFT = "\x1b[1;7D"

const MAIN_MODEL = {
	slug: "basic",
	displayName: "Fake Basic",
	provider: "ai-enabler",
	contextWindow: 200_000,
	maxTokens: 8192,
}
const CLASSIFIER_MODEL = {
	slug: "deepseek-v4-flash-0731",
	displayName: "DeepSeek V4 Flash",
	provider: "ai-enabler",
	contextWindow: 200_000,
	maxTokens: 8192,
}

const ALLOW_PROMPT = "Allow the assistant to run this?"
const WRITE_ARGS = JSON.stringify({ path: "output.txt", content: "hello world" })

const isSideRequest = (request: FakeResponseRequest) => JSON.stringify(request.body).includes("<side_chat>")

function enableSideChat(homeDir: string): void {
	const path = join(homeDir, ".config", "kimchi", "harness", "settings.json")
	const settings = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>
	writeFileSync(
		path,
		JSON.stringify({ ...settings, tuiMode: "fullscreen", resources: { "extensions.side-chat": true } }),
		"utf-8",
	)
}

/** Click the first on-screen occurrence of `text`. */
function clickText(terminal: Terminal, text: string): void {
	const lines = viewText(terminal).split("\n")
	const row = lines.findIndex((line) => line.includes(text))
	expect(row).toBeGreaterThanOrEqual(0)
	terminal.mousePress(lines[row].indexOf(text), row)
}

/** Drag-select the first on-screen line containing `text` (character granularity, settled by the release). */
async function selectText(terminal: Terminal, text: string): Promise<void> {
	const lines = viewText(terminal).split("\n")
	const row = lines.findIndex((line) => line.includes(text))
	expect(row).toBeGreaterThanOrEqual(0)
	const col = lines[row].indexOf(text)
	terminal.mouseDown(col, row)
	terminal.mouseTo(col + text.length - 1, row)
	await poll(() => true, 100, 1_000)
	terminal.mouseUp(col + text.length - 1, row)
}

const COMMON_RESPONSES = (followUp: string) => [
	{ match: isSideRequest, stream: ["Use the LRU cache."] },
	// Main turn: write tool call (not read-only → permission ask).
	{
		stream: ["I'll create the file."],
		toolCalls: [{ function: { name: "write", arguments: WRITE_ARGS } }],
	},
	// Classifier: confirm it.
	{
		stream: ['{"verdict":"requires-confirmation","reason":"This writes a new file to disk","riskScore":"high"}'],
	},
	{ stream: [followUp] },
]

/** Open the side chat, answer one question, then focus the main editor and arrive at a visible permission ask. */
async function arriveAtPermissionAsk(terminal: Terminal): Promise<void> {
	terminal.submit("/btw Which cache?")
	await waitForText(terminal, "Use the LRU cache.", { full: false })
	terminal.write(CTRL_ALT_LEFT)
	await waitForText(terminal, "● main", { full: false })
	terminal.submit("Write a file called output.txt")
	await waitForText(terminal, ALLOW_PROMPT, { timeoutMs: STREAM_TIMEOUT_MS, full: false })
}

test("opening the side chat from the pill while a permission ask is open keeps the ask selectable", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "side-chat-permission-ask-pill-open",
			providerId: "kimchi-dev",
			extraArgs: ["--auto", "--plan=false"],
			models: [MAIN_MODEL, CLASSIFIER_MODEL],
			seedHome: enableSideChat,
			responses: COMMON_RESPONSES("File written successfully."),
		},
		async (_fixture, trace) => {
			await arriveAtPermissionAsk(terminal)
			trace.step("permission ask visible with the side chat open")

			// Quoting main-session text via the pill focuses the side chat; the
			// ask must keep the keyboard regardless.
			await selectText(terminal, "I'll create the file.")
			await waitForText(terminal, "+ Add to side chat", { full: false })
			clickText(terminal, "+ Add to side chat")
			await waitForText(terminal, "> I'll create the file.", { full: false })
			trace.step("pill click quoted the selection into the side chat while the ask is open")

			terminal.submit("")
			await waitForText(terminal, "File written successfully.", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			expect(viewText(terminal)).not.toContain("Operation aborted")
			trace.step("keyboard: enter still approves the ask — its focus survived the side chat taking visual focus")
		},
	)
})

test("clicking into the side editor while a permission ask is open keeps the ask selectable", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "side-chat-permission-ask-editor-click",
			providerId: "kimchi-dev",
			extraArgs: ["--auto", "--plan=false"],
			models: [MAIN_MODEL, CLASSIFIER_MODEL],
			seedHome: enableSideChat,
			responses: COMMON_RESPONSES("File written successfully."),
		},
		async (_fixture, trace) => {
			await arriveAtPermissionAsk(terminal)
			trace.step("permission ask visible with the side chat open")

			// Mouse dispatch refocuses clicked editors directly, bypassing the
			// focus seam — a click into the side editor must not strand the ask.
			const lines = viewText(terminal).split("\n")
			const hintRow = lines.findIndex((line) => line.includes("/wrap"))
			const dividerCol = (lines.find((line) => line.includes("│")) ?? "").indexOf("│")
			expect(hintRow).toBeGreaterThanOrEqual(0)
			expect(dividerCol).toBeGreaterThanOrEqual(0)
			terminal.mousePress(dividerCol + 4, hintRow - 2)
			expect(await poll(() => viewText(terminal).includes("esc ask"), 100, 5_000)).toBe(true)
			trace.step("clicked into the side editor; the ask is the advertised esc target")

			terminal.submit("")
			await waitForText(terminal, "File written successfully.", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			expect(viewText(terminal)).not.toContain("Operation aborted")
			trace.step("keyboard: enter still approves the ask after the click")
		},
	)
})

test("closing the side chat while a permission ask is open hands focus back to the ask", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "side-chat-permission-ask-close",
			providerId: "kimchi-dev",
			extraArgs: ["--auto", "--plan=false"],
			models: [MAIN_MODEL, CLASSIFIER_MODEL],
			seedHome: enableSideChat,
			responses: COMMON_RESPONSES("Denied, moving on."),
		},
		async (_fixture, trace) => {
			await arriveAtPermissionAsk(terminal)
			trace.step("permission ask visible with the side chat open")

			// Distract the focus: click into the side pane, out of the ask.
			clickText(terminal, "✕")
			expect(await poll(() => !viewText(terminal).includes("Side chat ·"), 100, 5_000)).toBe(true)
			trace.step("mouse: header ✕ closes the side chat while the ask is open")

			// Escape must dismiss the ask (selector focused again), not abort the turn.
			terminal.write("\x1b")
			await waitForText(terminal, "Denied, moving on.", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			expect(viewText(terminal)).not.toContain("Operation aborted")
			trace.step("keyboard: escape dismissed the ask; the turn continued with the denial")
		},
	)
})
