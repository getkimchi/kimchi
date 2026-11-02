/**
 * Side chat × questionnaire focus regression test.
 *
 * The `questionnaire` tool's TUI form mounts via `ctx.ui.custom`, which — unlike
 * `ctx.ui.select` (permission asks) — leaves no trace in the interactive mode's
 * tracked dialog members. A click into the side pane therefore steals the
 * keyboard focus from the keyboard-only questionnaire, and no key or click
 * leads back: the main turn deadlocks on an unanswerable form.
 *
 * The questionnaire must survive the click: the side-chat focus guard has to
 * treat a `ui.custom` dialog in the editor slot as a modal and keep it focused.
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

const QUESTIONNAIRE_ARGS = JSON.stringify({
	header: "One question",
	questions: [
		{
			id: "color",
			type: "single",
			prompt: "Pick a color",
			options: [
				{ id: "alpha", label: "Alpha" },
				{ id: "beta", label: "Beta" },
			],
		},
	],
})

const isSideRequest = (request: FakeResponseRequest) => JSON.stringify(request.body).includes("<side_chat>")

function enableSideChat(homeDir: string): void {
	const path = join(homeDir, ".config", "kimchi", "harness", "settings.json")
	const settings = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>
	writeFileSync(
		path,
		JSON.stringify({
			...settings,
			tuiMode: "fullscreen",
			resources: { ...((settings.resources as Record<string, boolean>) ?? {}), "extensions.side-chat": true },
		}),
		"utf-8",
	)
}

/** Open the side chat, focus the main editor and arrive at a visible questionnaire form. */
async function arriveAtQuestionnaire(terminal: Terminal): Promise<void> {
	terminal.submit("/btw Which cache?")
	await waitForText(terminal, "Use the LRU cache.", { full: false })
	terminal.write(CTRL_ALT_LEFT)
	await waitForText(terminal, "● main", { full: false })
	terminal.submit("Ask me a question")
	await waitForText(terminal, "Pick a color", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
}

test("clicking into the side editor while a questionnaire is open keeps the questionnaire answerable", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "side-chat-questionnaire-editor-click",
			providerId: "kimchi-dev",
			extraArgs: ["--auto", "--plan=false"],
			models: [MAIN_MODEL],
			seedHome: enableSideChat,
			responses: [
				{ match: isSideRequest, stream: ["Use the LRU cache."] },
				// Main turn: questionnaire tool call (ui.custom dialog).
				{
					stream: ["Let me ask."],
					toolCalls: [{ function: { name: "questionnaire", arguments: QUESTIONNAIRE_ARGS } }],
				},
				// Absorbs the side editor's stray Enter if the click steals focus (pre-fix behaviour).
				{ match: isSideRequest, stream: ["Stray side submit."] },
				{ stream: ["Answer noted: Alpha."] },
			],
		},
		async (_fixture, trace) => {
			await arriveAtQuestionnaire(terminal)
			trace.step("questionnaire form visible with the side chat open")

			// Mouse dispatch refocuses clicked editors directly, bypassing the
			// focus seam — a click into the side editor must not strand the form.
			// The divider's column comes from the harness footer row itself — the
			// first "│" on screen can be an intro-box border at column 0.
			const lines = viewText(terminal).split("\n")
			const hintRow = lines.findIndex((line) => line.includes("/wrap"))
			expect(hintRow).toBeGreaterThanOrEqual(0)
			const dividerCol = lines[hintRow].indexOf("│")
			expect(dividerCol).toBeGreaterThan(0)
			terminal.mousePress(dividerCol + 4, hintRow - 2)
			expect(await poll(() => viewText(terminal).includes("esc ask"), 100, 5_000)).toBe(true)
			trace.step("clicked into the side editor; the questionnaire is the advertised esc target")

			terminal.submit("")
			await waitForText(terminal, "Answer noted: Alpha.", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			expect(viewText(terminal)).not.toContain("Stray side submit.")
			trace.step("keyboard: enter still answered the questionnaire after the click")
		},
	)
})
