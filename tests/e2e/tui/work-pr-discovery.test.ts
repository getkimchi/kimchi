import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { expect, test } from "@microsoft/tui-test"
import { waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("pending work survives a GitHub login error and finds a PR while coding continues", async ({ terminal }) => {
	const workId = randomUUID()
	const extraArgs: string[] = []
	let statePath = ""
	let callsPath = ""
	let headSha = ""
	const setGitHub = (mode: string) => {
		writeFileSync(`${statePath}.next`, JSON.stringify({ mode, headSha }))
		renameSync(`${statePath}.next`, statePath)
	}
	await runKimchiSession(
		terminal,
		{
			artifactName: "work-pr-discovery",
			gitInit: true,
			extraArgs,
			responses: [{ stream: ["You can keep coding while GitHub is unavailable."] }],
			seedHome(home, cwd) {
				const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
				git("config", "user.name", "PR Discovery Test")
				git("config", "user.email", "discovery@example.invalid")
				git("config", "commit.gpgSign", "false")
				git("remote", "add", "origin", "https://github.com/example/kimchi-lab.git")
				writeFileSync(join(cwd, "hello.txt"), "hello\n")
				git("add", "hello.txt")
				git("commit", "-m", "Add greeting")
				headSha = git("rev-parse", "HEAD")
				const agentDir = join(home, ".config/kimchi/harness")
				const session = SessionManager.create(cwd, join(agentDir, "sessions"))
				session.appendCustomEntry("work_identity", { workId })
				const sessionFile = session.getSessionFile()
				if (!sessionFile) throw new Error("The resumed fixture needs a saved session")
				writeFileSync(
					sessionFile,
					`${[session.getHeader(), ...session.getEntries()].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
				)
				extraArgs.push("--session", sessionFile)
				const ledgerDir = join(agentDir, "work-attribution")
				mkdirSync(ledgerDir, { recursive: true })
				const identity = {
					version: 1,
					sessionId: session.getSessionId(),
					workId,
					cwd,
					recordedAt: new Date().toISOString(),
				}
				writeFileSync(
					join(ledgerDir, `${session.getSessionId()}.jsonl`),
					`${[
						{ ...identity, type: "work" },
						{
							...identity,
							type: "commit",
							sha: headSha,
							repository: realpathSync(join(cwd, ".git")),
							worktree: realpathSync(cwd),
							prLookup: { status: "pending", checkedAt: identity.recordedAt },
						},
					]
						.map((entry) => JSON.stringify(entry))
						.join("\n")}\n`,
				)
				const fixtureDir = join(home, "pr-api-fixture")
				mkdirSync(fixtureDir)
				statePath = join(fixtureDir, "state.json")
				callsPath = join(fixtureDir, "calls.jsonl")
				setGitHub("hold")
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
						KIMCHI_TEST_PR_PROVIDER: "github",
						KIMCHI_TEST_PR_TOKEN: "pr-api-test-token",
						KIMCHI_TEST_PR_STATE: statePath,
						KIMCHI_TEST_PR_CALLS: callsPath,
					},
				}
			},
		},
		async (fixture, trace) => {
			await waitForText(terminal, "PR/MR waiting", { full: false, timeoutMs: 5_000 })
			trace.step("resumed work is waiting for its pull request")
			setGitHub("auth")
			await waitForText(terminal, "PR/MR check /work", { full: false, timeoutMs: 10_000 })
			terminal.submit("/work")
			await waitForText(terminal, "GitHub authentication failed. Check the token for github.com.")
			trace.step("GitHub token rejection is visible while coding stays available")
			terminal.submit("Can I keep coding while GitHub is unavailable?")
			await waitForText(terminal, "You can keep coding while GitHub is unavailable.")
			setGitHub("open")
			await waitForText(terminal, "PR #731 open", { full: false, timeoutMs: 35_000 })
			terminal.submit("/work")
			await waitForText(terminal, "https://github.com/example/kimchi-lab/pull/731")
			trace.step("the next background check finds the externally created PR")
			const summary = JSON.parse(readFileSync(join(fixture.agentDir, "work", workId, "work.json"), "utf8"))
			expect(summary.commits).toHaveLength(1)
			expect(summary.commits[0]).toMatchObject({
				sha: headSha,
				prLookup: { status: "linked" },
				pullRequests: [{ number: 731, state: "open", headSha, repository: "example/kimchi-lab", host: "github.com" }],
			})
			const calls = readFileSync(callsPath, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
			// Turn completion can refresh discovery before the periodic retry.
			expect([...new Set(calls.filter((call) => call.kind === "commit").map((call) => call.mode))]).toEqual([
				"auth",
				"open",
			])
			expect(calls.every((call) => call.tokenMatched)).toBe(true)
		},
	)
})
