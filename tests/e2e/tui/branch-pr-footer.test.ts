import { execFileSync } from "node:child_process"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("the footer shows the branch's PR after a rejected GitHub token is fixed and the agent pushes", async ({
	terminal,
}) => {
	let statePath = ""
	let callsPath = ""
	const setGitHub = (mode: string) => {
		writeFileSync(`${statePath}.next`, JSON.stringify({ mode, branch: "feature" }))
		renameSync(`${statePath}.next`, statePath)
	}
	await runKimchiSession(
		terminal,
		{
			artifactName: "branch-pr-footer",
			gitInit: true,
			responses: [
				{
					toolCalls: [
						{
							function: { name: "bash", arguments: JSON.stringify({ command: "echo 'pretend git push'" }) },
						},
					],
				},
				{ stream: ["Pushed the branch."] },
			],
			seedHome(home, cwd) {
				const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
				git("checkout", "-q", "-b", "feature")
				git("remote", "add", "origin", "https://github.com/example/kimchi-lab.git")
				const agentDir = join(home, ".config/kimchi/harness")
				const fixtureDir = join(home, "pr-api-fixture")
				mkdirSync(fixtureDir)
				statePath = join(fixtureDir, "state.json")
				callsPath = join(fixtureDir, "calls.jsonl")
				setGitHub("auth")
				writeFileSync(callsPath, "")
				const extensionsDir = join(agentDir, "extensions")
				mkdirSync(extensionsDir, { recursive: true })
				writeFileSync(
					join(extensionsDir, "pr-api.js"),
					readFileSync(new URL("./support/fixtures/pr-api.js", import.meta.url), "utf8"),
				)
				return {
					env: {
						GH_TOKEN: "pr-api-test-token",
						GITHUB_TOKEN: "",
						GH_ENTERPRISE_TOKEN: "",
						GITHUB_ENTERPRISE_TOKEN: "",
						GH_HOST: "",
						GITLAB_HOST: "",
						GL_HOST: "",
						GITLAB_TOKEN: "",
						GITLAB_ACCESS_TOKEN: "",
						GL_TOKEN: "",
						GH_REPO: "",
						GH_DEBUG: "",
						KIMCHI_DISABLE_NUDGE_CONTINUATION: "1",
						KIMCHI_TEST_PR_PROVIDER: "github",
						KIMCHI_TEST_PR_TOKEN: "pr-api-test-token",
						KIMCHI_TEST_PR_STATE: statePath,
						KIMCHI_TEST_PR_CALLS: callsPath,
					},
				}
			},
		},
		async (_fixture, trace) => {
			await waitForText(terminal, "PR/MR unavailable", { full: false, timeoutMs: 10_000 })
			await waitForText(terminal, "GitHub authentication failed. Check the token for github.com.")
			trace.step("a rejected token shows in the footer with one warning")

			setGitHub("open")
			terminal.submit("Push the branch.")
			await waitForText(terminal, "Pushed the branch.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "PR #731 open", { full: false, timeoutMs: 10_000 })
			trace.step("the agent's push asks GitHub again and the footer shows the branch's PR")

			const calls = readFileSync(callsPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
			expect(calls.filter((call) => call.kind === "branch").map((call) => call.mode)).toEqual(["auth", "open"])
			expect(calls.every((call) => call.tokenMatched)).toBe(true)
		},
	)
})
