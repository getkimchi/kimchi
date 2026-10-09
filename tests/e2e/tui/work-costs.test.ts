import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { test } from "@microsoft/tui-test"
import { waitForText } from "./support/assertions.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { BILLING_ACCOUNT, seedPendingWorkCost } from "./support/work-costs.js"

test.use(TUI_TEST_CONFIG)

/** The cost totals `/work` reads; the full `costs.json` is refreshed at most every five minutes. */
interface CostTotals {
	requests?: { total?: unknown }
	pullRequests?: { totalCostUsd?: unknown }[]
}

/** Background passes run every 30 seconds; wait for the one that publishes the expected totals. */
async function waitForTotals(path: string, ready: (totals: CostTotals) => boolean): Promise<void> {
	const deadline = Date.now() + 45_000
	while (Date.now() < deadline) {
		try {
			if (ready(JSON.parse(readFileSync(path, "utf8")))) return
		} catch {
			// Not published yet.
		}
		await sleep(250)
	}
	throw new Error(`Timed out waiting for ${path}`)
}

test("an open PR's pending cost becomes a confirmed and inferred total once it is billed and merged", async ({
	terminal,
}) => {
	const workId = randomUUID()
	const url = "https://github.com/example/kimchi-lab/pull/731"
	const extraArgs: string[] = []
	let billed = false
	let statePath = ""
	let totalsPath = ""
	let headSha = ""
	const setGitHub = (mode: string) => {
		writeFileSync(`${statePath}.next`, JSON.stringify({ mode, headSha }))
		renameSync(`${statePath}.next`, statePath)
	}
	await runKimchiSession(
		terminal,
		{
			artifactName: "work-costs",
			gitInit: true,
			extraArgs,
			account: BILLING_ACCOUNT,
			billingRows: () => (billed ? [{ id: "50000000-0000-4000-8000-000000000005", totalPrice: "0.000166000" }] : []),
			responses: [],
			seedHome(home, cwd, fakeBaseUrl) {
				const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
				git("config", "user.name", "PR Cost Test")
				git("config", "user.email", "costs@example.invalid")
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
				seedPendingWorkCost({
					agentDir,
					fakeBaseUrl,
					sessionId: session.getSessionId(),
					workId,
					cwd,
					repository: realpathSync(join(cwd, ".git")),
					worktree: realpathSync(cwd),
					headSha,
					pullRequest: {
						provider: "github",
						host: "github.com",
						repository: "example/kimchi-lab",
						number: 731,
						url,
						state: "open",
						headSha,
						mergeCommitSha: null,
						mergedAt: null,
						closedAt: null,
						checkedAt: new Date().toISOString(),
					},
				})
				totalsPath = join(agentDir, "work", workId, "cost-totals.json")
				const fixtureDir = join(home, "pr-api-fixture")
				mkdirSync(fixtureDir)
				statePath = join(fixtureDir, "state.json")
				const callsPath = join(fixtureDir, "calls.jsonl")
				setGitHub("open")
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
						KIMCHI_API_KEY: "",
						KIMCHI_TEST_PR_PROVIDER: "github",
						KIMCHI_TEST_PR_TOKEN: "pr-api-test-token",
						KIMCHI_TEST_PR_STATE: statePath,
						KIMCHI_TEST_PR_CALLS: callsPath,
					},
				}
			},
		},
		async (_fixture, trace) => {
			await waitForText(terminal, "PR #731 open", { full: false, timeoutMs: 10_000 })
			await waitForTotals(totalsPath, (totals) => totals.requests?.total === 1)
			terminal.submit("/work")
			await waitForText(terminal, "Cost so far: unknown; $0.000000000 USD priced (open)")
			await waitForText(terminal, "Prices: 0/1 requests priced, $0.000000000 USD known so far.")
			// The work panel shows the current work's cost lines; close it before opening it again.
			terminal.keyEscape()
			await waitForText(terminal, PROMPT_READY, { full: false })
			trace.step("an open PR's spend stays unknown while its request has no bill")
			billed = true
			setGitHub("merged")
			await waitForTotals(totalsPath, (totals) =>
				Boolean(totals.pullRequests?.some((row) => row.totalCostUsd === "0.000166000")),
			)
			terminal.submit("/work")
			await waitForText(terminal, `Cost: $0.000166000 USD — ${url}`)
			await waitForText(terminal, "Confirmed: $0.000000000 USD; inferred: $0.000166000 USD.")
			await waitForText(terminal, "Prices: 1/1 requests priced, $0.000166000 USD.")
			trace.step("the merged PR shows its billed total split into confirmed and inferred spend")
		},
	)
})
