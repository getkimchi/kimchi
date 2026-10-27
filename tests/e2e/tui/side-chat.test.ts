import { readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import type { Terminal } from "@microsoft/tui-test/lib/terminal/term.js"
import { poll } from "@microsoft/tui-test/lib/utils/poll.js"
import { viewText, waitForText } from "./support/assertions.js"
import type { FakeResponseRequest } from "./support/fake-openai-server.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

/** xterm encoding of ctrl+alt+arrows (modifier 7 = 1 + alt 2 + ctrl 4), as terminals send them without Option-as-Meta. */
const CTRL_ALT_LEFT = "\x1b[1;7D"
const CTRL_ALT_RIGHT = "\x1b[1;7C"

/** Side-session requests carry the side chat's system-prompt block. */
const isSideRequest = (request: FakeResponseRequest) => JSON.stringify(request.body).includes("<side_chat>")
/** `/wrap` drafts in its own session, marked by the wrap-up system prompt. */
const isWrapUpRequest = (request: FakeResponseRequest) => JSON.stringify(request.body).includes("<side_chat_wrap_up>")
const isMainRequest = (request: FakeResponseRequest) => !isSideRequest(request) && !isWrapUpRequest(request)

function enableSideChat(homeDir: string): void {
	const path = join(homeDir, ".config", "kimchi", "harness", "settings.json")
	const settings = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>
	writeFileSync(
		path,
		JSON.stringify({ ...settings, tuiMode: "fullscreen", resources: { "extensions.side-chat": true } }),
		"utf-8",
	)
}

/** Side chat transcripts kept next to the main sessions: `side-chats/<main session id>/<side chat id>.jsonl`. */
function sideChatFiles(homeDir: string): string[] {
	return readdirSync(homeDir, { recursive: true, encoding: "utf-8" })
		.filter((path) => /(^|[/\\])side-chats[/\\][^/\\]+[/\\][^/\\]+\.jsonl$/.test(path))
		.map((path) => join(homeDir, path))
}

/** Click the first on-screen occurrence of `text` (`offset` cells into it). */
function clickText(terminal: Terminal, text: string, offset = 0): void {
	const lines = viewText(terminal).split("\n")
	const row = lines.findIndex((line) => line.includes(text))
	expect(row).toBeGreaterThanOrEqual(0)
	terminal.mousePress(lines[row].indexOf(text) + offset, row)
}

test("side chat answers next to the session and wraps up into a steer for the main agent", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "side-chat-wrap-up",
			extraArgs: ["--plan=false"],
			seedHome: enableSideChat,
			responses: [
				{ match: isMainRequest, stream: ["Noted."] },
				{ match: isSideRequest, stream: ["Use the LRU cache."] },
				{ match: isWrapUpRequest, stream: ["Switch to the LRU cache."] },
				{ match: isMainRequest, stream: ["Main switched caches."] },
			],
		},
		async (fixture, trace) => {
			const chatRequests = () =>
				fixture.fake.requests.filter((request) => request.url === "/openai/v1/chat/completions")

			terminal.submit("The codeword is PAPAYA-42.")
			await waitForText(terminal, "Noted.", { full: false })

			terminal.submit("/side Which cache?")
			await waitForText(terminal, "Use the LRU cache.", { full: false })
			expect(viewText(terminal)).toContain("Side chat · Which cache?")
			expect(JSON.stringify(chatRequests().find(isSideRequest)?.body)).toContain("PAPAYA-42")
			trace.step("/side opens a docked side chat, branched with the main context, that answers the first question")

			terminal.submit("/wrap")
			await waitForText(terminal, "Steering prompt for main session", { full: false })
			expect(viewText(terminal)).toContain("Switch to the LRU cache.")
			const wrapUpBody = JSON.stringify(chatRequests().find(isWrapUpRequest)?.body)
			expect(wrapUpBody).toContain("[User]: Which cache?")
			expect(wrapUpBody).toContain("[Assistant]: Use the LRU cache.")
			expect(wrapUpBody).not.toContain("PAPAYA-42")
			expect(wrapUpBody).not.toContain("<side_chat>")
			trace.step("/wrap drafts a steering prompt from the side thread only, for review in the side editor")

			terminal.write("\r")
			await waitForText(terminal, "Main switched caches.", { full: false })
			expect(viewText(terminal)).not.toContain("Side chat · Which cache?")
			const mainRequest = chatRequests().filter(isMainRequest).at(-1)
			expect(JSON.stringify(mainRequest?.body)).toContain("Switch to the LRU cache.")
			expect(await poll(() => chatRequests().length === 4, 100, 5_000)).toBe(true)
			trace.step("enter sends the draft to the main agent and closes the side chat")
		},
	)
})

test("side chat header closes it, lists past chats to reopen, and ctrl+alt+arrows move focus", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "side-chat-header-history",
			extraArgs: ["--plan=false"],
			seedHome: enableSideChat,
			responses: [{ match: isSideRequest, stream: ["Use the LRU cache."] }],
		},
		async (fixture, trace) => {
			terminal.submit("/side Which cache?")
			await waitForText(terminal, "Use the LRU cache.", { full: false })
			expect(await poll(() => sideChatFiles(fixture.homeDir).length === 1, 100, 5_000)).toBe(true)
			expect(readFileSync(sideChatFiles(fixture.homeDir)[0], "utf-8")).toContain("Use the LRU cache.")
			trace.step("the side thread is saved to its own file after the reply")

			clickText(terminal, "✕")
			expect(await poll(() => !viewText(terminal).includes("Side chat ·"), 100, 5_000)).toBe(true)
			expect(viewText(terminal)).not.toContain("Use the LRU cache.")
			trace.step("✕ closes the side chat")

			terminal.write(CTRL_ALT_RIGHT)
			await waitForText(terminal, "Side chat · New side chat", { full: false })
			trace.step("ctrl+alt+right opens a blank side chat when none is open")

			clickText(terminal, "≡")
			await waitForText(terminal, "Which cache?  (1 question)", { full: false })
			clickText(terminal, "Which cache?  (1 question)")
			await waitForText(terminal, "Use the LRU cache.", { full: false })
			expect(viewText(terminal)).toContain("Side chat · Which cache?")
			trace.step("≡ lists the session's side chats and a click reopens one")

			terminal.write(CTRL_ALT_LEFT)
			await waitForText(terminal, "○ Side chat", { full: false })
			terminal.write(CTRL_ALT_RIGHT)
			await waitForText(terminal, "● Side chat", { full: false })
			trace.step("ctrl+alt+left focuses the main session and ctrl+alt+right the side chat")
		},
	)
})
