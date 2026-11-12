import { execFileSync } from "node:child_process"
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { fullText, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("/pr-watch reports its local lifetime, respects Plan mode and stops without inference", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "pr-watch-local-controls",
			gitInit: true,
			responses: [],
			extraArgs: ["--plan"],
			env: { KIMCHI_PERMISSIONS: "plan" },
			seedHome: (homeDir, workDir) => {
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
			trace.step("local watch pauses in Plan mode")
			terminal.submit("/pr-watch stop")
			await waitForText(terminal, "PR watch · Local · idle")
			trace.step("watch stopped")
			expect(fixture.fake.requests.filter((request) => request.url.includes("chat/completions"))).toHaveLength(0)
		},
	)
})
