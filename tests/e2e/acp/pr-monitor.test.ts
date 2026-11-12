import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it, vi } from "vitest"
import type { PRMonitorState } from "../../../src/extensions/pr-monitor/types.js"
import { startAcpFixture } from "./support/acp-fixture.js"
import { newSession } from "./support/scenarios.js"

it.each([
	"ci",
	"review",
	"command",
	"flag",
])("auto-fixes a %s event over ACP while idle and pushes one real local commit", async (kind) => {
	const data = mkdtempSync(join(tmpdir(), "kimchi-pr-monitor-e2e-"))
	const stateFile = join(data, "state.json")
	const bare = join(data, "origin.git")
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim()
	git(data, "init", "--bare", "--initial-branch=feature", bare)
	vi.stubEnv("GH_TOKEN", "pr-monitor-fixture-token")
	vi.stubEnv("KIMCHI_TEST_PR_MONITOR", stateFile)
	const fixture = await startAcpFixture({
		artifactName: `pr-monitor-${kind}`,
		pretrustWorkDir: true,
		extraArgs: ["--yolo", ...(kind === "flag" ? ["--pr-watch"] : [])],
		extensionPath: fileURLToPath(new URL("./support/pr-monitor-api.js", import.meta.url)),
		responses: [
			{
				toolCalls: [
					{
						id: "repair",
						function: {
							name: "bash",
							arguments: JSON.stringify({
								command:
									"set -e\nprintf 'fixed\\n' > answer.txt\nnode -e \"require('node:assert/strict').equal(require('node:fs').readFileSync('answer.txt','utf8'),'fixed\\n')\"\ngit add answer.txt\ngit commit -m 'Fix parser'\ngit push origin HEAD:feature",
							}),
						},
					},
				],
			},
			{ stream: ["Fixed the parser, verified the file and pushed the repair commit."] },
		],
	})
	try {
		const cwd = fixture.workDir
		git(cwd, "init", "--initial-branch=feature")
		git(cwd, "config", "user.name", "PR monitor fixture")
		git(cwd, "config", "user.email", "fixture@example.invalid")
		git(cwd, "config", "commit.gpgSign", "false")
		git(cwd, "remote", "add", "origin", "https://github.com/example/kimchi-lab.git")
		git(cwd, "remote", "set-url", "--push", "origin", bare)
		writeFileSync(join(cwd, ".gitignore"), ".kimchi/\n")
		writeFileSync(join(cwd, "answer.txt"), "broken\n")
		git(cwd, "add", ".")
		git(cwd, "commit", "-m", "Add parser fixture")
		git(cwd, "push", "origin", "HEAD:feature")
		const before = git(cwd, "rev-parse", "HEAD")
		const seed = { bare, head: before, kind: kind === "review" ? "review" : "ci", exists: kind !== "flag" }
		writeFileSync(stateFile, JSON.stringify(seed))
		const sessionId = await newSession(fixture, cwd)
		await expect
			.poll(() =>
				fixture.client.sessionUpdates.some(
					({ update }) =>
						update.sessionUpdate === "available_commands_update" &&
						update.availableCommands.some((command) => command.name === "pr-watch"),
				),
			)
			.toBe(true)
		expect(fixture.initializeResponse.agentCapabilities?._meta?.["kimchi.dev"]).toMatchObject({
			pr_status: true,
			set_pr_monitor: true,
		})
		const initial = await fixture.conn.extMethod("_kimchi.dev/pr_status", { sessionId })
		expect(initial.state).toMatchObject({ enabled: kind === "flag", autoFix: false })
		if (kind === "flag") {
			expect((initial.state as PRMonitorState).pullRequest).toBeNull()
			writeFileSync(stateFile, JSON.stringify({ ...seed, exists: true }))
			const discovered = await fixture.conn.extMethod("_kimchi.dev/pr_status", { sessionId })
			expect(discovered.state).toMatchObject({ enabled: true, autoFix: false, pullRequest: { number: 7 } })
			expect(git(cwd, "rev-parse", "HEAD")).toBe(before)
		}
		if (kind === "command" || kind === "flag") {
			await fixture.conn.prompt({
				sessionId,
				prompt: [{ type: "text", text: "/pr-watch Fix only the parser fixture" }],
			})
		} else {
			await fixture.conn.extMethod("_kimchi.dev/set_pr_monitor", { sessionId, enabled: true, autoFix: true })
		}
		await expect
			.poll(() => git(data, "--git-dir", bare, "show", "feature:answer.txt"), { timeout: 20_000 })
			.toBe("fixed")
		await expect
			.poll(
				async () =>
					((await fixture.conn.extMethod("_kimchi.dev/pr_status", { sessionId })).state as PRMonitorState).phase,
				{ timeout: 20_000 },
			)
			.toBe("watching")
		const after = git(cwd, "rev-parse", "HEAD")
		expect(after).not.toBe(before)
		expect(git(cwd, "rev-list", "--count", `${before}..HEAD`)).toBe("1")
		expect(readFileSync(join(cwd, "answer.txt"), "utf8")).toBe("fixed\n")
		expect(fixture.client.extNotifications).toContainEqual({
			method: "_kimchi.dev/pr_update",
			params: expect.objectContaining({ sessionId, state: expect.objectContaining({ phase: "fixing" }) }),
		})
		expect(fixture.client.agentTextBySession().get(sessionId)).toContain("pushed the repair commit")
		if (kind === "command") {
			const requests = fixture.fake.requests.filter((request) => request.url.includes("chat/completions")).length
			await fixture.conn.prompt({ sessionId, prompt: [{ type: "text", text: "/pr-watch status" }] })
			expect(fixture.client.agentTextBySession().get(sessionId)).toContain("PR watch · Local · watching")
			await fixture.conn.prompt({ sessionId, prompt: [{ type: "text", text: "/pr-watch stop" }] })
			expect(fixture.client.agentTextBySession().get(sessionId)).toContain("PR watch · Local · idle")
			expect(fixture.fake.requests.filter((request) => request.url.includes("chat/completions")).length).toBe(requests)
		} else await fixture.conn.extMethod("_kimchi.dev/set_pr_monitor", { sessionId, enabled: false, autoFix: false })
	} finally {
		await fixture.stop()
		vi.unstubAllEnvs()
		rmSync(data, { recursive: true, force: true })
	}
}, 60_000)
