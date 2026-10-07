import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { viewText, waitForText, waitForTurnToSettle } from "./support/assertions.js"
import type { FakeResponseRequest, FakeResponseScript } from "./support/fake-openai-server.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const FIRST_PROMPT = "Write one into notes.txt"
const SECOND_PROMPT = "Write two into notes.txt"

function chatMessages(request: FakeResponseRequest): unknown[] {
	const body = request.body
	if (!body || typeof body !== "object" || !("messages" in body) || !Array.isArray(body.messages)) return []
	return body.messages
}

function sendsTools(request: FakeResponseRequest): boolean {
	const body = request.body
	return !!body && typeof body === "object" && "tools" in body && Array.isArray(body.tools) && body.tools.length > 0
}

// Session naming also asks the fake model for a title after the first turn, so each script is
// reserved for the agent's own request: it sends tools, and whether its tool result came back
// after the prompt tells the two steps apart.
function agentRequest(prompt: string, afterToolResult: boolean) {
	return (request: FakeResponseRequest) => {
		if (!sendsTools(request)) return false
		const messages = chatMessages(request).map((message) => JSON.stringify(message))
		const promptIndex = messages.findLastIndex((message) => message.includes(prompt))
		if (promptIndex < 0 || (prompt === FIRST_PROMPT && messages.some((message) => message.includes(SECOND_PROMPT)))) {
			return false
		}
		return messages.slice(promptIndex + 1).some((message) => message.includes('"role":"tool"')) === afterToolResult
	}
}

function writeNotes(prompt: string, content: string, reply: string): FakeResponseScript[] {
	return [
		{
			match: agentRequest(prompt, false),
			stream: [],
			toolCalls: [{ function: { name: "write", arguments: JSON.stringify({ path: "notes.txt", content }) } }],
			finishReason: "tool_calls",
		},
		{ match: agentRequest(prompt, true), stream: [reply], finishReason: "stop" },
	]
}

test("/rewind restores the files from before the chosen prompt", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "rewind-restore-files",
			gitInit: true,
			extraArgs: ["--plan=false"],
			env: {
				KIMCHI_ENABLE_RESOURCES: "extensions.rewind",
				// Snapshots are git commits, and the test home has no git identity.
				GIT_AUTHOR_NAME: "Rewind Test",
				GIT_AUTHOR_EMAIL: "rewind@example.invalid",
				GIT_COMMITTER_NAME: "Rewind Test",
				GIT_COMMITTER_EMAIL: "rewind@example.invalid",
			},
			responses: [
				...writeNotes(FIRST_PROMPT, "one\n", "Wrote one."),
				...writeNotes(SECOND_PROMPT, "two\n", "Wrote two."),
			],
		},
		async (fixture, trace) => {
			const notes = join(fixture.workDir, "notes.txt")

			terminal.submit(FIRST_PROMPT)
			await waitForText(terminal, "Wrote one.", { full: false })
			await waitForTurnToSettle(fixture.fake.requests)
			terminal.submit(SECOND_PROMPT)
			await waitForText(terminal, "Wrote two.", { full: false })
			await waitForTurnToSettle(fixture.fake.requests)
			expect(readFileSync(notes, "utf-8")).toBe("two\n")
			trace.step("two prompts wrote notes.txt")

			terminal.submit("/rewind")
			await waitForText(terminal, "Rewind to before which prompt?", { full: false })
			terminal.submit("")
			await waitForText(terminal, "Restore files to that point", { full: false })
			trace.step("picked the second prompt; the file restore is offered")

			terminal.keyDown()
			terminal.submit("")
			await waitForText(terminal, "Navigated to selected point", { full: false })
			expect(readFileSync(notes, "utf-8")).toBe("one\n")
			expect(viewText(terminal)).toContain(`❯ ${SECOND_PROMPT}`)
			trace.step("files are back to before the second prompt, and the prompt is back in the editor")
		},
	)
})
