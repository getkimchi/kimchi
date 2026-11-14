import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it, vi } from "vitest"
import { requestAdvertisesTool, toolResultText } from "../tui/support/mcp-model-script.js"
import { chatRequests } from "../tui/support/wire-requests.js"
import { startAcpFixture } from "./support/acp-fixture.js"
import { newSession } from "./support/scenarios.js"

it.each([
	"ci",
	"review",
	"command",
	"flag",
	"offer",
	"natural",
	"natural-plan",
])("handles %s PR watching over ACP and repairs only outside Plan mode", async (kind) => {
	const natural = kind === "natural" || kind === "natural-plan"
	const data = mkdtempSync(join(tmpdir(), "kimchi-pr-watch-e2e-"))
	const stateFile = join(data, "state.json")
	const bare = join(data, "origin.git")
	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim()
	git(data, "init", "--bare", "--initial-branch=feature", bare)
	vi.stubEnv("GH_TOKEN", "pr-watch-fixture-token")
	vi.stubEnv("KIMCHI_TEST_PR_WATCH", stateFile)
	const fixture = await startAcpFixture({
		artifactName: `pr-watch-${kind}`,
		clientMeta: { "kimchi.dev": { prMonitoring: true, backgroundRuns: true } },
		pretrustWorkDir: true,
		extraArgs: [kind === "natural-plan" ? "--plan" : "--yolo", ...(kind === "flag" ? ["--pr-watch"] : [])],
		extensionPath: fileURLToPath(new URL("./support/pr-watch-github-api.js", import.meta.url)),
		responses: [
			...(natural
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
						{
							stream: [
								kind === "natural-plan"
									? "Watching the requested PR. Switch out of Plan mode before auto-fixing."
									: "Watching the requested PR with automatic fixes enabled.",
							],
						},
					]
				: []),
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
		git(cwd, "config", "user.name", "PR watch fixture")
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
		const seed = { bare, head: before, kind: kind === "review" ? "review" : "ci" }
		writeFileSync(stateFile, JSON.stringify(seed))
		if (kind !== "offer") fixture.client.answerNextPermissionWith({ kind: "reject_once" })
		const sessionId = await newSession(fixture, cwd)
		const status = async (id: string) => {
			const before = fixture.client.agentTextBySession().get(id)?.length ?? 0
			await fixture.conn.prompt({ sessionId: id, prompt: [{ type: "text", text: "/pr-watch status" }] })
			return fixture.client.agentTextBySession().get(id)?.slice(before) ?? ""
		}
		if (kind !== "flag") {
			await expect
				.poll(
					() =>
						fixture.client.permissionRequests.filter(
							(request) => request.toolCall.title === "Enable automatic PR watching?",
						).length,
				)
				.toBe(1)
		}
		if (kind === "offer") {
			await expect
				.poll(() =>
					fixture.client.extNotifications.some(
						({ params }) =>
							(params as { message?: string }).message ===
							"Watching PR #7 with auto-fix. /pr-watch watch pauses fixes. /pr-watch disable turns off automatic watching.",
					),
				)
				.toBe(true)
		}
		await expect
			.poll(() =>
				fixture.client.sessionUpdates.some(
					({ update }) =>
						update.sessionUpdate === "available_commands_update" &&
						update.availableCommands.some((command) => command.name === "pr-watch"),
				),
			)
			.toBe(true)
		expect(fixture.initializeResponse.agentCapabilities?._meta?.["kimchi.dev"]).toMatchObject({ prMonitoring: true })
		if (kind === "flag") {
			await expect.poll(() => status(sessionId)).toContain("PR #7 Fix parser")
			expect(await status(sessionId)).toContain("Watching · Watch only")
			expect(git(cwd, "rev-parse", "HEAD")).toBe(before)
		} else if (kind !== "offer") expect(await status(sessionId)).toContain("PR watch · Not watching")
		if (natural) {
			await fixture.conn.prompt({
				sessionId,
				prompt: [{ type: "text", text: "watch this https://github.com/example/kimchi-lab/pull/7 pr" }],
			})
			expect(fixture.fake.requests.some((request) => requestAdvertisesTool(request, "pr_watch"))).toBe(true)
		} else if (kind === "command" || kind === "flag") {
			await fixture.conn.prompt({
				sessionId,
				prompt: [{ type: "text", text: "/pr-watch Fix only the parser fixture" }],
			})
		} else if (kind === "review") {
			await fixture.conn.prompt({ sessionId, prompt: [{ type: "text", text: "/pr-watch reviews" }] })
		} else if (kind !== "offer") {
			await fixture.conn.prompt({ sessionId, prompt: [{ type: "text", text: "/pr-watch ci" }] })
		}
		if (kind === "natural-plan") {
			expect(toolResultText(fixture.fake.requests, "watch")).toContain("Switch out of Plan mode")
			await expect.poll(() => status(sessionId)).toContain("Needs attention · Auto-fix on · CI only")
			expect(await status(sessionId)).toContain("Switch out of Plan mode before auto-fixing this PR.")
			expect(git(cwd, "rev-parse", "HEAD")).toBe(before)
			expect(git(data, "--git-dir", bare, "rev-parse", "feature")).toBe(before)
			expect(readFileSync(join(cwd, "answer.txt"), "utf8")).toBe("broken\n")
			expect(chatRequests(fixture)).toHaveLength(2)
			expect(fixture.client.agentTextBySession().get(sessionId)).toContain("Switch out of Plan mode")
			return
		}
		await expect
			.poll(() => git(data, "--git-dir", bare, "show", "feature:answer.txt"), { timeout: 20_000 })
			.toBe("fixed")
		await expect.poll(() => status(sessionId), { timeout: 20_000 }).toContain("Watching · Auto-fix on")
		const after = git(cwd, "rev-parse", "HEAD")
		expect(after).not.toBe(before)
		expect(git(cwd, "rev-list", "--count", `${before}..HEAD`)).toBe("1")
		expect(readFileSync(join(cwd, "answer.txt"), "utf8")).toBe("fixed\n")
		expect(fixture.client.agentTextBySession().get(sessionId)).toContain("pushed the repair commit")
		if (kind === "ci") {
			await expect
				.poll(
					() =>
						fixture.client.extNotifications.filter(({ method }) => method === "_kimchi.dev/background_run_end").length,
				)
				.toBe(1)
			expect(
				fixture.client.extNotifications.filter(({ method }) => method === "_kimchi.dev/background_run_start"),
			).toHaveLength(1)
		}
		if (kind === "command") {
			const requests = fixture.fake.requests.filter((request) => request.url.includes("chat/completions")).length
			expect(await status(sessionId)).toContain("PR watch · PR #7 · Watching")
			await fixture.conn.prompt({ sessionId, prompt: [{ type: "text", text: "/pr-watch stop" }] })
			expect(fixture.client.agentTextBySession().get(sessionId)).toContain("PR watch · Not watching")
			await fixture.conn.prompt({ sessionId, prompt: [{ type: "text", text: "/pr-watch monitor" }] })
			expect(fixture.fake.requests.filter((request) => request.url.includes("chat/completions")).length).toBe(requests)
		} else await fixture.conn.prompt({ sessionId, prompt: [{ type: "text", text: "/pr-watch stop" }] })
		if (kind === "offer") {
			const preferencePath = join(fixture.homeDir, ".config/kimchi/harness/pr-watch.json")
			expect(JSON.parse(readFileSync(preferencePath, "utf8"))).toEqual({ enabled: true })
			writeFileSync(stateFile, JSON.stringify({ ...seed, number: 8 }))
			const second = await newSession(fixture, cwd)
			await expect.poll(() => status(second)).toContain("PR #8 Fix parser")
			expect(await status(second)).toContain("Auto-fix on · CI only")
			expect(
				fixture.client.permissionRequests.filter(
					(request) => request.toolCall.title === "Enable automatic PR watching?",
				),
			).toHaveLength(1)
			await fixture.conn.prompt({ sessionId: second, prompt: [{ type: "text", text: "/pr-watch disable" }] })
			expect(JSON.parse(readFileSync(preferencePath, "utf8"))).toEqual({ enabled: false })
			writeFileSync(stateFile, JSON.stringify({ ...seed, number: 9 }))
			const third = await newSession(fixture, cwd)
			expect(await status(third)).toContain("PR watch · Not watching")
			expect(
				fixture.client.permissionRequests.filter(
					(request) => request.toolCall.title === "Enable automatic PR watching?",
				),
			).toHaveLength(1)
		}
	} finally {
		await fixture.stop()
		vi.unstubAllEnvs()
		rmSync(data, { recursive: true, force: true })
	}
}, 60_000)
