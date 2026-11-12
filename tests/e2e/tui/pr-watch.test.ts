import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, Key, test } from "@microsoft/tui-test"
import { fullText, viewText, waitForText } from "./support/assertions.js"
import { PROMPT_READY, runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

for (const mode of ["regular", "fullscreen"] as const) {
	test(`/pr-watch Monitor updates, pauses and stops without inference in ${mode} mode`, async ({ terminal }) => {
		let stateFile = ""
		await runKimchiSession(
			terminal,
			{
				artifactName: `pr-watch-monitor-${mode}`,
				gitInit: true,
				responses: [],
				extraArgs: ["--plan"],
				env: { KIMCHI_PERMISSIONS: "plan" },
				seedHome: (homeDir, workDir) => {
					if (mode === "fullscreen") {
						const path = join(homeDir, ".config/kimchi/harness/settings.json")
						writeFileSync(
							path,
							JSON.stringify({
								...JSON.parse(readFileSync(path, "utf8")),
								tuiMode: "fullscreen",
								showHardwareCursor: true,
							}),
						)
					}
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
					copyFileSync(join(repoRoot, "tests/e2e/acp/support/pr-monitor-api.js"), join(extensions, "pr-monitor-api.js"))
					return { env: { GH_TOKEN: "pr-monitor-fixture-token", KIMCHI_TEST_PR_MONITOR: state } }
				},
			},
			async (fixture, trace) => {
				terminal.submit("/pr-watch")
				await waitForText(terminal, "Switch out of Plan mode")
				expect(fullText(terminal)).toContain("Keep this Kimchi process open")
				await waitForText(terminal, "PR #7: needs attention", { full: false })
				trace.step("tracking indicator stays visible while repairs pause in Plan mode")
				terminal.submit("/pr-watch monitor")
				await waitForText(terminal, "[Monitor]", { full: false })
				expect(viewText(terminal)).toContain("failed: Parser tests")
				expect(viewText(terminal)).not.toMatch(/\[Script\]|\[Output\]/)
				terminal.resize(60, 20)
				await waitForText(terminal, "1–4 of 7", { full: false })
				terminal.keyPress(Key.End)
				await waitForText(terminal, "4–7 of 7", { full: false })
				terminal.keyPress(Key.Home)
				await waitForText(terminal, "1–4 of 7", { full: false })
				terminal.resize(130, 40)
				await waitForText(terminal, "1–7 of 7", { full: false })
				trace.step("single Monitor tab supports resize and paging")
				terminal.keyPress("p")
				await waitForText(terminal, "watching · auto-fix off", { full: false })
				const seed = JSON.parse(readFileSync(stateFile, "utf8"))
				writeFileSync(stateFile, JSON.stringify({ ...seed, kind: "passed" }))
				terminal.keyPress("r")
				await waitForText(terminal, "passed: Parser tests", { full: false })
				trace.step("pause revokes fixes; refresh shows a changed provider snapshot")
				terminal.keyCtrlC()
				await waitForText(terminal, PROMPT_READY, { full: false })
				await waitForText(terminal, "PR #7: watching", { full: false })
				terminal.submit("/pr-watch monitor")
				await waitForText(terminal, "[Monitor]", { full: false })
				terminal.keyPress("s")
				await waitForText(terminal, "stopped · auto-fix off", { full: false })
				terminal.keyEscape()
				await waitForText(terminal, PROMPT_READY, { full: false })
				expect(viewText(terminal)).not.toContain("PR #7: watching")
				trace.step("Ctrl+C closes inspection only; explicit stop removes tracking indicator")
				expect(fixture.fake.requests.filter((request) => request.url.includes("chat/completions"))).toHaveLength(0)
			},
		)
	})
}
