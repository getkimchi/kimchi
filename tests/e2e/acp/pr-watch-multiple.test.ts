import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it, vi } from "vitest"
import type { PRMonitorState } from "../../../src/extensions/pr-monitor/types.js"
import { createPRWatchTargets, git } from "../tui/support/pr-watch-targets.js"
import { chatRequests } from "../tui/support/wire-requests.js"
import { startAcpFixture } from "./support/acp-fixture.js"
import { newSession } from "./support/scenarios.js"

it.each([
	"github",
	"gitlab",
] as const)("watches and repairs multiple %s targets from a non-repository session, with CI-only default", async (provider) => {
	const root = mkdtempSync(join(tmpdir(), "pr-watch-multiple-acp-"))
	const targets = createPRWatchTargets(root, [7, 8], provider)
	const stateFile = join(root, "state.json")
	writeFileSync(stateFile, JSON.stringify({ targets }))
	vi.stubEnv("GH_TOKEN", "pr-monitor-fixture-token")
	vi.stubEnv("GITLAB_TOKEN", "pr-monitor-fixture-token")
	vi.stubEnv("GITLAB_HOST", "gitlab.fixture.test")
	vi.stubEnv("KIMCHI_TEST_PR_MONITOR", stateFile)
	const fixture = await startAcpFixture({
		artifactName: `pr-watch-multiple-home-${provider}`,
		clientMeta: { "kimchi.dev": { prMonitoring: true, backgroundRuns: true } },
		extraArgs: ["--yolo"],
		extensionPath: fileURLToPath(
			new URL(provider === "github" ? "./support/pr-monitor-api.js" : "./support/mr-monitor-api.js", import.meta.url),
		),
		responses: [
			{
				toolCalls: [
					{
						id: "watch-both",
						function: {
							name: "pr_watch",
							arguments: JSON.stringify({ targets: targets.map(({ url, cwd }) => ({ url, cwd })) }),
						},
					},
				],
			},
			{ stream: ["Watching both requested PRs with CI-only automatic fixes."] },
			...targets.flatMap(({ cwd, branch, number }) => [
				{
					toolCalls: [
						{
							id: `repair-${number}`,
							function: {
								name: "bash",
								arguments: JSON.stringify({
									command: `cd '${cwd}'\nprintf 'fixed ${number}\\n' > answer.txt\ngit add answer.txt\ngit commit -m 'Fix ${number}'\ngit push origin HEAD:${branch}`,
								}),
							},
						},
					],
				},
				{ stream: [`Fixed and pushed PR ${number}.`] },
			]),
		],
	})
	try {
		const sessionId = await newSession(fixture, fixture.workDir)
		const initial = await fixture.conn.extMethod("_kimchi.dev/pr_status", { sessionId })
		expect(initial.state).toMatchObject({ enabled: false, autoFix: false, pullRequest: null })
		await fixture.conn.prompt({
			sessionId,
			prompt: [{ type: "text", text: `Watch and fix these PRs: ${targets.map(({ url }) => url).join(" ")}` }],
		})
		for (const target of targets) {
			await expect
				.poll(() => git(root, "--git-dir", target.bare, "show", `${target.branch}:answer.txt`), { timeout: 20_000 })
				.toBe(`fixed ${target.number}`)
			expect(git(target.cwd, "status", "--porcelain")).toBe("")
			expect(git(target.cwd, "rev-list", "--count", `${target.head}..HEAD`)).toBe("1")
		}
		await expect
			.poll(async () => (await fixture.conn.extMethod("_kimchi.dev/pr_status", { sessionId })).state, {
				timeout: 20_000,
			})
			.toMatchObject({
				enabled: true,
				phase: "watching",
				watches: [
					{ cwd: targets[0].cwd, state: { mode: "ci" } },
					{ cwd: targets[1].cwd, state: { mode: "ci" } },
				],
			})
		expect(() => git(fixture.workDir, "rev-parse", "--show-toplevel")).toThrow()
		expect(fixture.client.agentTextBySession().get(sessionId)).toContain("Fixed and pushed PR 8.")
		expect(
			fixture.client.permissionRequests.filter(({ toolCall }) => toolCall.title === "Enable automatic PR watching?"),
		).toHaveLength(0)
		const count = chatRequests(fixture).length
		writeFileSync(
			stateFile,
			JSON.stringify({
				targets: targets.map((target) => ({ ...target, head: git(target.cwd, "rev-parse", "HEAD"), kind: "review" })),
			}),
		)
		const reviews = (await fixture.conn.extMethod("_kimchi.dev/pr_status", { sessionId })).state as PRMonitorState
		expect(reviews.watches?.every(({ state }) => state.pullRequest?.feedback.length === 1 && state.mode === "ci")).toBe(
			true,
		)
		expect(chatRequests(fixture)).toHaveLength(count)
		for (const target of targets)
			expect(readFileSync(join(target.cwd, "answer.txt"), "utf8")).toBe(`fixed ${target.number}\n`)
		await fixture.conn.prompt({ sessionId, prompt: [{ type: "text", text: "/pr-watch stop" }] })
		const stopped = (await fixture.conn.extMethod("_kimchi.dev/pr_status", { sessionId })).state as PRMonitorState
		expect(stopped.watches?.every(({ state }) => !state.enabled && !state.autoFix)).toBe(true)
		expect(chatRequests(fixture)).toHaveLength(count)
	} finally {
		await fixture.stop()
		vi.unstubAllEnvs()
		rmSync(root, { force: true, recursive: true })
	}
}, 60_000)
