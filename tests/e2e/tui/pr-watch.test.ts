import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { fullText, viewText, waitForText } from "./support/assertions.js"
import { launchKimchi, PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { requestAdvertisesTool, toolResultText } from "./support/mcp-model-script.js"
import { createPRWatchTargets, git } from "./support/pr-watch-targets.js"
import { chatRequests } from "./support/wire-requests.js"

test.use(TUI_TEST_CONFIG)

for (const provider of ["github", "gitlab"] as const) {
	test(`adds requested ${provider} targets from a non-repository conversation and controls them together`, async ({
		terminal,
	}) => {
		const root = mkdtempSync(join(tmpdir(), "pr-watch-multiple-tui-"))
		const targets = createPRWatchTargets(root, [7, 8], provider)
		const label = provider === "github" ? "PR #" : "MR !"
		const plural = provider === "github" ? "PRs" : "MRs"
		const repository = provider === "github" ? "example/kimchi-lab" : "group/subgroup/kimchi-lab"
		const stateFile = join(root, "state.json")
		writeFileSync(stateFile, JSON.stringify({ targets: targets.map((target) => ({ ...target, kind: "passed" })) }))
		try {
			await runKimchiSession(
				terminal,
				{
					artifactName: `pr-watch-multiple-home-${provider}`,
					extraArgs: ["--yolo"],
					responses: targets.flatMap(({ url, cwd }, i) => [
						{
							toolCalls: [
								{
									id: `watch-${i}`,
									function: { name: "pr_watch", arguments: JSON.stringify({ targets: [{ url, cwd }] }) },
								},
							],
						},
						{ stream: [i === 0 ? "Watching the first requested PR." : "Second PR added to tracking."] },
					]),
					seedHome: (homeDir) => {
						const repo = process.env.KIMCHI_REPO_ROOT
						if (!repo) throw new Error("Run through scripts/run-tui-e2e.js")
						const extensions = join(homeDir, ".config/kimchi/harness/extensions")
						mkdirSync(extensions, { recursive: true })
						copyFileSync(
							join(repo, `tests/e2e/acp/support/pr-watch-${provider}-api.js`),
							join(extensions, "pr-watch-api.js"),
						)
						return {
							env: {
								GH_TOKEN: "pr-watch-fixture-token",
								GITLAB_TOKEN: "pr-watch-fixture-token",
								GITLAB_HOST: "gitlab.fixture.test",
								KIMCHI_TEST_PR_WATCH: stateFile,
							},
						}
					},
				},
				async (fixture, trace) => {
					expect(() => git(fixture.workDir, "rev-parse", "--show-toplevel")).toThrow()
					expect(viewText(terminal)).not.toContain("/pr-watch monitor")
					terminal.submit(`Watch ${targets[0].url} and fix CI`)
					await waitForText(terminal, "Watching the first requested PR.")
					await waitForText(terminal, `${label}7: Watching`, { full: false })
					expect(fullText(terminal)).toContain("CI only")
					trace.step("an explicit request starts CI-only tracking from outside a repository")
					terminal.submit(`Also watch ${targets[1].url} and fix CI`)
					await waitForText(terminal, "Second PR added to tracking.")
					await waitForText(terminal, `2 ${plural}: Watching`, { full: false })
					terminal.submit("/pr-watch monitor")
					await waitForText(terminal, `Monitor · 2 ${plural}`, { full: false })
					expect(viewText(terminal)).toContain(`${repository} ${label}7`)
					expect(viewText(terminal)).toContain(`${repository} ${label}8`)
					trace.step("the second request adds a target; Monitor lists both checkouts")
					terminal.keyPress("p")
					await waitForText(terminal, "Watch only", { full: false })
					terminal.keyPress("s")
					await waitForText(terminal, "Stopped", { full: false })
					terminal.keyEscape()
					await waitForText(terminal, PROMPT_READY, { full: false })
					expect(viewText(terminal)).not.toContain(`2 ${plural}: Watching`)
					for (const target of targets) expect(git(target.cwd, "rev-parse", "HEAD")).toBe(target.head)
					expect(chatRequests(fixture)).toHaveLength(4)
					trace.step("pause and stop apply to the set without opening another agent session")
				},
			)
		} finally {
			rmSync(root, { force: true, recursive: true })
		}
	})
}

for (const mode of ["regular", "fullscreen"] as const) {
	test(`PR watching and Monitor controls work in Plan mode (${mode})`, async ({ terminal }) => {
		let stateFile = ""
		await runKimchiSession(
			terminal,
			{
				artifactName: `pr-watch-monitor-${mode}`,
				startupText: "Enable automatic PR watching?",
				exitMarker: `PR_WATCH_EXIT_${mode}`,
				gitInit: true,
				responses:
					mode === "regular"
						? [
								{
									toolCalls: [
										{
											id: "watch",
											function: {
												name: "pr_watch",
												arguments: JSON.stringify({ url: "https://github.com/example/kimchi-lab/pull/7" }),
											},
										},
									],
								},
								{ stream: ["Tracking started; repairs wait until you leave Plan mode."] },
							]
						: [],
				extraArgs: ["--plan"],
				env: { KIMCHI_PERMISSIONS: "plan" },
				seedHome: (homeDir, workDir) => {
					const path = join(homeDir, ".config/kimchi/harness/settings.json")
					writeFileSync(
						path,
						JSON.stringify({
							...JSON.parse(readFileSync(path, "utf8")),
							tuiMode: mode,
							showHardwareCursor: true,
						}),
					)
					const repoRoot = process.env.KIMCHI_REPO_ROOT
					if (!repoRoot) throw new Error("Run through scripts/run-tui-e2e.js")
					const git = (...args: string[]) =>
						execFileSync("git", args, { cwd: workDir, encoding: "utf8", stdio: "pipe" }).trim()
					git("checkout", "-b", "feature")
					git(
						"-c",
						"user.name=Fixture",
						"-c",
						"user.email=fixture@example.invalid",
						"-c",
						"commit.gpgSign=false",
						"commit",
						"--allow-empty",
						"-m",
						"PR watch fixture",
					)
					git("remote", "add", "origin", "https://github.com/example/kimchi-lab.git")
					const bare = join(homeDir, "origin.git")
					git("init", "--bare", "--initial-branch=feature", bare)
					git("push", bare, "HEAD:feature")
					const state = join(homeDir, "pr.json")
					stateFile = state
					writeFileSync(state, JSON.stringify({ bare, head: git("rev-parse", "HEAD"), kind: "ci" }))
					const extensions = join(homeDir, ".config/kimchi/harness/extensions")
					mkdirSync(extensions, { recursive: true })
					copyFileSync(
						join(repoRoot, "tests/e2e/acp/support/pr-watch-github-api.js"),
						join(extensions, "pr-watch-api.js"),
					)
					return { env: { GH_TOKEN: "pr-watch-fixture-token", KIMCHI_TEST_PR_WATCH: state } }
				},
			},
			async (fixture, trace) => {
				expect(viewText(terminal)).not.toContain("PR #7:")
				expect(viewText(terminal)).not.toContain("[Monitor]")
				if (mode === "fullscreen") {
					terminal.submit("")
					await waitForText(terminal, "Watching PR #7 with auto-fix.")
					await waitForText(terminal, "PR #7: Needs attention", { full: false })
					trace.step("accepting enables fixes; Plan mode pauses repairs and Monitor stays closed")
				} else {
					terminal.keyEscape()
					await waitForText(terminal, PROMPT_READY, { full: false })
					expect(viewText(terminal)).not.toContain("PR #7:")
					trace.step("declining PR discovery leaves tracking hidden until explicitly requested")
					terminal.submit("watch this https://github.com/example/kimchi-lab/pull/7 pr")
					await waitForText(terminal, "Tracking started; repairs wait until you leave Plan mode.")
					expect(fullText(terminal)).toContain("PR #7 · Watching · Auto-fix on · CI only")
					expect(fullText(terminal)).not.toContain("lines returned")
					terminal.keyPress("o", { ctrl: true })
					await waitForText(terminal, "under normal permissions", { full: false })
					terminal.keyPress("o", { ctrl: true })
					await waitForText(terminal, "Tool output: collapsed", { full: false })
					expect(fixture.fake.requests.some((request) => requestAdvertisesTool(request, "pr_watch"))).toBe(true)
					expect(toolResultText(fixture.fake.requests, "watch")).toContain("Switch out of Plan mode")
					trace.step("a natural-language request starts tracking through the advertised pr_watch tool")
				}
				terminal.submit("/pr-watch")
				await waitForText(terminal, "Keep this Kimchi process open")
				await waitForText(terminal, "PR #7: Needs attention", { full: false })
				trace.step("tracking indicator stays visible while repairs pause in Plan mode")
				terminal.submit("/pr-watch monitor")
				await waitForText(terminal, "Monitor · PR #7", { full: false })
				expect(viewText(terminal)).toContain("failed: Parser tests")
				expect(viewText(terminal)).not.toMatch(/\[Script\]|\[Output\]/)
				terminal.resize(60, 20)
				await waitForText(terminal, "Esc close · R · P pause · S stop", { full: false })
				expect(viewText(terminal)).toContain("1 failed")
				expect(viewText(terminal)).toContain("Switch out of Plan mode")
				expect(viewText(terminal)).not.toContain("PR #7: Needs attention")
				terminal.resize(130, 40)
				await waitForText(terminal, "Esc close · R refresh · P pause fixes · S stop", { full: false })
				trace.step("compact Monitor fits narrow terminals without a duplicate tracking row")
				terminal.keyPress("p")
				await waitForText(terminal, "Watch only", { full: false })
				const seed = JSON.parse(readFileSync(stateFile, "utf8"))
				writeFileSync(stateFile, JSON.stringify({ ...seed, kind: "passed" }))
				terminal.keyPress("r")
				await waitForText(terminal, "CI: 1 passed · Review threads 0", { full: false })
				terminal.resize(60, 8)
				await waitForText(terminal, "Esc close · enlarge terminal to monitor", { full: false })
				terminal.resize(130, 40)
				await waitForText(terminal, "CI: 1 passed · Review threads 0", { full: false })
				trace.step("pause revokes fixes; refresh shows a changed provider snapshot")
				terminal.keyCtrlC()
				await waitForText(terminal, PROMPT_READY, { full: false })
				await waitForText(terminal, "PR #7: Watching", { full: false })
				terminal.submit("/pr-watch monitor")
				await waitForText(terminal, "Monitor · PR #7", { full: false })
				terminal.keyPress("s")
				await waitForText(terminal, "Stopped", { full: false })
				terminal.keyEscape()
				await waitForText(terminal, PROMPT_READY, { full: false })
				expect(viewText(terminal)).not.toContain("PR #7: Watching")
				trace.step("Ctrl+C closes inspection only; explicit stop removes tracking indicator")
				const preferencePath = join(fixture.agentDir, "pr-watch.json")
				expect(JSON.parse(readFileSync(preferencePath, "utf8"))).toEqual({ enabled: mode === "fullscreen" })
				if (mode === "fullscreen") {
					terminal.submit("/quit")
					await waitForText(terminal, `PR_WATCH_EXIT_${mode}`, { full: false })
					writeFileSync(stateFile, JSON.stringify({ ...seed, kind: "passed", number: 8 }))
					launchKimchi(terminal, fixture, ["--plan"], fixture.seedEnv, { exitMarker: "PR_WATCH_SECOND_EXIT" })
					await waitForText(terminal, "PR #8: Watching", { full: false })
					expect(viewText(terminal)).toContain("Switch out of Plan mode")
					expect(viewText(terminal)).not.toContain("Enable automatic PR watching?")
					trace.step("a new process and PR reuse the saved general opt-in without another question")
					terminal.submit("/pr-watch disable")
					await waitForText(terminal, "Automatic PR watching disabled for future PRs and sessions")
					expect(JSON.parse(readFileSync(preferencePath, "utf8"))).toEqual({ enabled: false })
					terminal.submit("/quit")
					await waitForText(terminal, "PR_WATCH_SECOND_EXIT", { full: false })
					writeFileSync(stateFile, JSON.stringify({ ...seed, kind: "passed", number: 9 }))
					launchKimchi(terminal, fixture, ["--plan"], fixture.seedEnv)
					await waitForText(terminal, "feature · PR #9 open", { full: false })
					expect(viewText(terminal)).not.toContain("Enable automatic PR watching?")
					expect(viewText(terminal)).not.toContain("PR #9: Watching")
					trace.step("disabling is remembered across another process and PR, leaving tracking hidden")
				}
				expect(execFileSync("git", ["--git-dir", seed.bare, "rev-parse", "feature"], { encoding: "utf8" }).trim()).toBe(
					seed.head,
				)
				expect(chatRequests(fixture)).toHaveLength(mode === "regular" ? 2 : 0)
			},
		)
	})
}
