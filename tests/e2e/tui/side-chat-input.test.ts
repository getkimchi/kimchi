import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, Key, test } from "@microsoft/tui-test"
import { poll } from "@microsoft/tui-test/lib/utils/poll.js"
import { viewText, waitForText } from "./support/assertions.js"
import type { FakeResponseRequest } from "./support/fake-openai-server.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const isSideRequest = (request: FakeResponseRequest) => JSON.stringify(request.body).includes("<side_chat>")

function enableSideChat(homeDir: string): void {
	const path = join(homeDir, ".config", "kimchi", "harness", "settings.json")
	const settings = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>
	writeFileSync(path, JSON.stringify({ ...settings, tuiMode: "fullscreen" }), "utf-8")
}

const CTRL_ALT_LEFT = "\x1b[1;7D"

test("a follow-up submitted during a side reply stays visible as pending input", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "side-chat-pending-input",
			extraArgs: ["--plan=false"],
			seedHome: enableSideChat,
			responses: [
				{
					match: isSideRequest,
					rawDeltas: [{ delta: { content: "Partial reply…" } }, { delta: { content: " finished" }, delayMs: 3_000 }],
				},
				{ match: isSideRequest, stream: ["Follow-up answer."] },
			],
		},
		async (_fixture, trace) => {
			terminal.submit("/btw First question")
			await waitForText(terminal, "Partial reply…", { full: false })
			trace.step("the first side reply is still streaming")

			terminal.submit("Follow-up while busy")
			expect(await poll(() => viewText(terminal).includes("Follow-up while busy"), 50, 1_000)).toBe(true)
			trace.step("the submitted follow-up remains visible while the first reply continues")

			await waitForText(terminal, "Follow-up answer.", { full: false })
			terminal.write("Draft after follow-up")
			await waitForText(terminal, "Draft after follow-up", { full: false })
			const draftLine = viewText(terminal)
				.split("\n")
				.find((line) => line.includes("Draft after follow-up"))
			expect(draftLine).not.toContain("Follow-up while busy")
			trace.step("the queued follow-up runs and its acknowledged text leaves the editor")
		},
	)
})

test("Page Up and Page Down scroll whichever chat has focus", async ({ terminal }) => {
	const mainLines = Array.from({ length: 60 }, (_, index) => `Main line ${index + 1} of 60.`)
	const sideLines = Array.from({ length: 80 }, (_, index) => `Side line ${index + 1} of 80.`)
	await runKimchiSession(
		terminal,
		{
			artifactName: "side-chat-paging-focus",
			extraArgs: ["--plan=false"],
			seedHome: enableSideChat,
			responses: [
				{ match: (request) => !isSideRequest(request), stream: [mainLines.join("\n")] },
				{ match: isSideRequest, stream: [sideLines.join("\n")] },
			],
		},
		async (_fixture, trace) => {
			terminal.submit("Write the main report.")
			await waitForText(terminal, "Main line 60 of 60.", { full: false })
			terminal.submit("/btw Write the side report.")
			await waitForText(terminal, "Side line 80 of 80.", { full: false })
			expect(viewText(terminal)).toContain("Main line 60 of 60.")
			trace.step("both transcripts start pinned to their latest lines with side chat focused")

			const showsEnds = (main: boolean, side: boolean) => {
				const text = viewText(terminal)
				return text.includes("Main line 60 of 60.") === main && text.includes("Side line 80 of 80.") === side
			}

			terminal.keyPress(Key.PageUp)
			expect(await poll(() => showsEnds(true, false), 50, 1_000)).toBe(true)
			trace.step("side-focused Page Up scrolls only the side transcript")

			terminal.keyPress(Key.PageDown)
			expect(await poll(() => showsEnds(true, true), 50, 1_000)).toBe(true)
			trace.step("side-focused Page Down returns only the side transcript to its end")

			terminal.write(CTRL_ALT_LEFT)
			await waitForText(terminal, "○ Side chat", { full: false })
			terminal.keyPress(Key.PageUp)
			expect(await poll(() => showsEnds(false, true), 50, 1_000)).toBe(true)
			trace.step("main-focused Page Up preserves the existing main-chat scrolling path")

			terminal.keyPress(Key.PageDown)
			expect(await poll(() => showsEnds(true, true), 50, 1_000)).toBe(true)
			trace.step("main-focused Page Down returns the main transcript to its end")
		},
	)
})
