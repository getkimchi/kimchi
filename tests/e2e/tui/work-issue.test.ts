import { execFileSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { waitForText } from "./support/assertions.js"
import { isWorkMatchingRequest, type RecordedRequest } from "./support/fake-openai-server.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("the branch's Jira issue is only suggested; once selected it binds the next prompt, shows in /work and clears", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "work-issue",
			gitInit: true,
			responses: [{ stream: ["Planned the Jira integration."] }, { stream: ["Implemented the Jira integration."] }],
			seedHome(_homeDir, workDir) {
				execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/feature/ABC-123-add-jira"], { cwd: workDir })
			},
		},
		async (fixture, trace) => {
			const chats = () =>
				fixture.fake.requests.filter(
					(request) => request.url.startsWith("/openai/v1/chat/completions") && !isWorkMatchingRequest(request),
				)
			const ledger = join(fixture.agentDir, "work-attribution")
			const row = (request: RecordedRequest | undefined) =>
				readdirSync(ledger)
					.filter((file) => file.endsWith(".jsonl"))
					.flatMap((file) => readFileSync(join(ledger, file), "utf8").split("\n").filter(Boolean))
					.map((line) => JSON.parse(line))
					.find((record) => record.type === "request" && record.requestId === request?.headers["x-request-id"])

			terminal.submit("Plan the Jira integration for ABC-123")
			await waitForText(terminal, "Planned the Jira integration.")
			terminal.submit("/work issue")
			await waitForText(terminal, "Branch feature/ABC-123-add-jira names ABC-123. Select it with: /work issue ABC-123")
			trace.step("a key in the prompt or the branch name is only suggested")

			terminal.submit("/work issue ABC-123")
			await waitForText(terminal, "Jira issue ABC-123 selected for this work.")
			terminal.submit("Implement it")
			await waitForText(terminal, "Implemented the Jira integration.")
			const planning = row(chats().at(0))
			const implementation = row(chats().at(-1))
			expect(planning.workId).toBe(implementation.workId)
			expect(planning.issue).toBeUndefined()
			expect(implementation.issue).toEqual({ key: "ABC-123", revision: 1 })
			trace.step("the selection binds the next prompt's request, not the earlier one")

			terminal.submit("/work")
			// Only the work panel shows the row label and the issue below the work's last activity.
			await waitForText(terminal, /Current: ● \S+ ABC-123 ·/, { full: false })
			await waitForText(terminal, /Last activity: .+\n\s+Jira issue: ABC-123/, { full: false })
			terminal.keyEscape()
			await waitForText(terminal, PROMPT_READY, { full: false })
			trace.step("/work shows the work's issue")

			terminal.submit("/work issue clear")
			await waitForText(terminal, "Jira issue ABC-123 cleared from this work.")
			terminal.submit("/work issue")
			// Only a suggestion printed after the implementation turn matches.
			await waitForText(
				terminal,
				/Implemented the Jira integration\.[\s\S]*Jira issue: none\s+Branch feature\/ABC-123-add-jira names ABC-123/,
			)
			trace.step("clearing removes the issue and the branch key is suggested again")
		},
	)
})
