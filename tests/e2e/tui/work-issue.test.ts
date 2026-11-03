import { execFileSync } from "node:child_process"
import { expect, test } from "@microsoft/tui-test"
import { waitForText } from "./support/assertions.js"
import { isWorkMatchingRequest, type RecordedRequest } from "./support/fake-openai-server.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { readWorkRecords } from "./support/work-summary.js"

test.use(TUI_TEST_CONFIG)

/** The work panel's current row, naming the selected issue after the work. */
function currentWorkWithIssue(text: string): boolean {
	return text.split("\n").some((line) => {
		const current = line.indexOf("Current: ● ")
		return current !== -1 && line.slice(current).includes(" ABC-123 ·")
	})
}

/** The issue on the line right below the work's last activity. */
function issueBelowLastActivity(text: string): boolean {
	const lines = text.split("\n")
	return lines.some(
		(line, index) => line.includes("Last activity: ") && lines[index + 1]?.trim().startsWith("Jira issue: ABC-123"),
	)
}

/** The branch suggestion printed after the implementation turn; the one printed before it does not count. */
function branchSuggestedAfterImplementation(text: string): boolean {
	const implemented = text.indexOf("Implemented the Jira integration.")
	const after = implemented === -1 ? "" : text.slice(implemented)
	const none = after.indexOf("Jira issue: none")
	return (
		none !== -1 &&
		after
			.slice(none + "Jira issue: none".length)
			.trimStart()
			.startsWith("Branch feature/ABC-123-add-jira names ABC-123")
	)
}

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
			const row = (request: RecordedRequest | undefined) =>
				readWorkRecords(fixture.agentDir).find(
					(record) => record.type === "request" && record.requestId === request?.headers["x-request-id"],
				)

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
			await waitForText(terminal, currentWorkWithIssue, { full: false })
			await waitForText(terminal, issueBelowLastActivity, { full: false })
			terminal.keyEscape()
			await waitForText(terminal, PROMPT_READY, { full: false })
			trace.step("/work shows the work's issue")

			terminal.submit("/work issue clear")
			await waitForText(terminal, "Jira issue ABC-123 cleared from this work.")
			terminal.submit("/work issue")
			// Only a suggestion printed after the implementation turn matches.
			await waitForText(terminal, branchSuggestedAfterImplementation)
			trace.step("clearing removes the issue and the branch key is suggested again")
		},
	)
})
