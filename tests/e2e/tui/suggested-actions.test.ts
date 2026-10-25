import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import type { Terminal } from "@microsoft/tui-test/lib/terminal/term.js"
import { poll } from "@microsoft/tui-test/lib/utils/poll.js"
import { viewText, waitForText } from "./support/assertions.js"
import type { FakeResponseRequest } from "./support/fake-openai-server.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const PR_URL = "https://github.com/acme/app/pull/1531"

/** A request carrying the expanded `/skill:watch-pr <url>` prompt. */
const isWatchRequest = (request: FakeResponseRequest) =>
	JSON.stringify(request.body).includes('<skill name=\\"watch-pr\\"')

/** Click the first on-screen occurrence of `text`. */
function clickText(terminal: Terminal, text: string): void {
	const lines = viewText(terminal).split("\n")
	const row = lines.findIndex((line) => line.includes(text))
	expect(row).toBeGreaterThanOrEqual(0)
	terminal.mousePress(lines[row].indexOf(text), row)
}

test("a PR opened in the session offers a Watch PR chip that runs the watch-pr skill", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "suggested-actions-watch-pr",
			extraArgs: ["--plan=false"],
			sessionTuiMode: "fullscreen",
			env: { KIMCHI_PERMISSIONS: "yolo", KIMCHI_ENABLE_RESOURCES: "extensions.suggested-actions" },
			seedHome: (homeDir) => {
				// A `gh` stand-in that opens a PR without touching the network.
				const binDir = join(homeDir, "bin")
				mkdirSync(binDir)
				writeFileSync(join(binDir, "gh"), `#!/bin/sh\necho "Creating pull request for feat-x"\necho "${PR_URL}"\n`)
				chmodSync(join(binDir, "gh"), 0o755)
			},
			responses: [
				{
					toolCalls: [
						{
							id: "open-pr",
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: "$HOME/bin/gh pr create --fill", description: "Open the PR" }),
							},
						},
					],
				},
				{ stream: [`Opened ${PR_URL}`] },
				{ match: isWatchRequest, stream: ["Checks are green and the PR is approved."] },
			],
		},
		async (fixture, trace) => {
			const chatRequests = () =>
				fixture.fake.requests.filter((request) => request.url === "/openai/v1/chat/completions")

			terminal.submit("Open a PR for this branch")
			await waitForText(terminal, "◉ Watch PR #1531", { full: false })
			trace.step("a PR opened by this session's gh pr create shows a Watch PR chip under the editor")

			clickText(terminal, "Watch PR #1531")
			await waitForText(terminal, "Checks are green and the PR is approved.", { full: false })
			expect(chatRequests().some(isWatchRequest)).toBe(true)
			expect(JSON.stringify(chatRequests().find(isWatchRequest)?.body)).toContain(PR_URL)
			await waitForText(terminal, "◉ Watch PR #1531", { full: false })
			trace.step("a click sends /skill:watch-pr with the PR URL to the main session; the chip returns when it ends")

			clickText(terminal, "×")
			expect(await poll(() => !viewText(terminal).includes("Watch PR #1531"), 100, 5_000)).toBe(true)
			trace.step("× dismisses the chip")
		},
	)
})
