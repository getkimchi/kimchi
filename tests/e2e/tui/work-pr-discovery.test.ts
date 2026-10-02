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
				const bin = join(home, "gh-fixture")
				mkdirSync(bin)
				mkdirSync(join(bin, "config"))
				statePath = join(bin, "state.json")
				callsPath = join(bin, "calls.jsonl")
				setGitHub("hold")
				writeFileSync(callsPath, "")
				writeFileSync(
					join(bin, "gh"),
					`#!${process.execPath}\n` +
						String.raw`
const { appendFileSync, readFileSync } = require("node:fs")
const args = process.argv.slice(2)
const repoQuery = JSON.stringify(args) === JSON.stringify(["repo", "view", "--json", "nameWithOwner,url"])
const commitQuery = args.length === 8 && JSON.stringify(args.slice(0, 5)) === JSON.stringify(["api", "--method", "GET", "--hostname", "github.com"]) && /^repos\/example\/kimchi-lab\/commits\/[a-f0-9]{40}\/pulls$/.test(args[5]) && args[6] === "--paginate" && args[7] === "--slurp"
const credentialFree = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].every((name) => !process.env[name])
if (!(repoQuery || commitQuery) || !credentialFree) throw new Error("Unexpected command or inherited GitHub credentials")
if (repoQuery) {
  console.log(JSON.stringify({ nameWithOwner: "example/kimchi-lab", url: "https://github.com/example/kimchi-lab" }))
} else {
  let state
  const deadline = Date.now() + 8000
  do {
    state = JSON.parse(readFileSync(process.env.KIMCHI_TEST_GH_STATE, "utf8"))
    if (state.mode !== "hold") break
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
  } while (Date.now() < deadline)
  appendFileSync(process.env.KIMCHI_TEST_GH_CALLS, JSON.stringify({ mode: state.mode, args, credentialFree }) + "\n")
  if (state.mode === "auth") {
    console.error("To get started with GitHub CLI, please run: gh auth login")
    process.exitCode = 4
  } else if (state.mode === "open") {
    console.log(JSON.stringify([[{ html_url: "https://github.com/example/kimchi-lab/pull/731", number: 731, state: "open", head: { sha: state.headSha }, merge_commit_sha: null, merged_at: null, closed_at: null }]]))
  } else throw new Error("The test did not release the initial GitHub lookup")
}
`,
					{ mode: 0o700 },
				)
				return {
					env: {
						PATH: `${bin}:${process.env.PATH ?? ""}`,
						GH_CONFIG_DIR: join(bin, "config"),
						GH_TOKEN: "",
						GITHUB_TOKEN: "",
						GH_ENTERPRISE_TOKEN: "",
						GITHUB_ENTERPRISE_TOKEN: "",
						GH_HOST: "",
						GH_REPO: "",
						GH_DEBUG: "",
						KIMCHI_TEST_GH_STATE: statePath,
						KIMCHI_TEST_GH_CALLS: callsPath,
					},
				}
			},
		},
		async (fixture, trace) => {
			await waitForText(terminal, "PR: waiting", { full: false, timeoutMs: 5_000 })
			trace.step("resumed work is waiting for its pull request")
			setGitHub("auth")
			await waitForText(terminal, "PR: check /work", { full: false, timeoutMs: 10_000 })
			terminal.submit("/work")
			await waitForText(terminal, "gh auth login")
			trace.step("GitHub login error is visible with the recovery command")
			terminal.submit("Can I keep coding while GitHub is unavailable?")
			await waitForText(terminal, "You can keep coding while GitHub is unavailable.")
			setGitHub("open")
			await waitForText(terminal, "PR: #731 open", { full: false, timeoutMs: 35_000 })
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
			expect(calls.map((call) => call.mode)).toEqual(["auth", "open"])
			expect(calls.every((call) => call.credentialFree)).toBe(true)
		},
	)
})
