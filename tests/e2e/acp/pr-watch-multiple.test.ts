import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it, vi } from "vitest"
import { createPRWatchTargets, git } from "../tui/support/pr-watch-targets.js"
import { chatRequests } from "../tui/support/wire-requests.js"
import { startAcpFixture } from "./support/acp-fixture.js"
import { newSession } from "./support/scenarios.js"

it("offers to watch the PR of a commit the agent pushed from a non-repository session", async () => {
	const root = mkdtempSync(join(tmpdir(), "prw-work-acp-"))
	const [target] = createPRWatchTargets(root, [7])
	const stateFile = join(root, "state.json")
	writeFileSync(stateFile, JSON.stringify({ targets: [{ ...target, kind: "passed" }] }))
	vi.stubEnv("GH_TOKEN", "pr-watch-fixture-token")
	vi.stubEnv("KIMCHI_TEST_PR_WATCH", stateFile)
	vi.stubEnv("KIMCHI_E2E_RECONCILIATION_INTERVAL_MS", "1000")
	const fixture = await startAcpFixture({
		artifactName: "pr-watch-session-work",
		clientMeta: { "kimchi.dev": { prMonitoring: true, backgroundRuns: true } },
		extraArgs: ["--yolo"],
		extensionPath: fileURLToPath(new URL("../fixtures/pr-watch-github-api.js", import.meta.url)),
		responses: [
			{
				toolCalls: [
					{
						id: "push",
						function: {
							name: "bash",
							arguments: JSON.stringify({
								command: `cd '${target.cwd}'\nprintf 'fixed\\n' > answer.txt\ngit commit -qam 'Fix answer'\ngit push -q origin HEAD:${target.branch}`,
							}),
						},
					},
				],
			},
			{ stream: ["Pushed the fix to the PR branch."] },
		],
	})
	try {
		const sessionId = await newSession(fixture, fixture.workDir)
		await fixture.conn.request("session/prompt", {
			sessionId,
			prompt: [{ type: "text", text: "Fix the answer and push it" }],
		})
		await expect
			.poll(
				() =>
					fixture.client.extNotifications.some(
						({ params }) =>
							(params as { message?: string }).message ===
							"Watching PR #7 with auto-fix. /pr-watch watch pauses fixes. /pr-watch disable turns off automatic watching.",
					),
				{ timeout: 30_000 },
			)
			.toBe(true)
		expect(
			fixture.client.permissionRequests.filter(({ toolCall }) => toolCall.title === "Enable automatic PR watching?"),
		).toHaveLength(1)
		const before = fixture.client.agentTextBySession().get(sessionId)?.length ?? 0
		await fixture.conn.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/pr-watch status" }] })
		const status = fixture.client.agentTextBySession().get(sessionId)?.slice(before) ?? ""
		expect(status).toContain(`Checkout: ${realpathSync(target.cwd)}`)
		expect(status).toContain("Watching · Auto-fix on · CI only")
		expect(() => git(fixture.workDir, "rev-parse", "--show-toplevel")).toThrow()
	} finally {
		await fixture.stop()
		vi.unstubAllEnvs()
		rmSync(root, { force: true, recursive: true })
	}
}, 60_000)

it.each([
	"github",
	"gitlab",
] as const)("watches and repairs multiple %s targets from a non-repository session, with CI-only default", async (provider) => {
	const root = mkdtempSync(join(tmpdir(), "pr-watch-multiple-acp-"))
	const targets = createPRWatchTargets(root, [7, 8], provider)
	const stateFile = join(root, "state.json")
	writeFileSync(stateFile, JSON.stringify({ targets }))
	vi.stubEnv("GH_TOKEN", "pr-watch-fixture-token")
	vi.stubEnv("GITLAB_TOKEN", "pr-watch-fixture-token")
	vi.stubEnv("GITLAB_HOST", "gitlab.fixture.test")
	vi.stubEnv("KIMCHI_TEST_PR_WATCH", stateFile)
	const fixture = await startAcpFixture({
		artifactName: `pr-watch-multiple-home-${provider}`,
		clientMeta: { "kimchi.dev": { prMonitoring: true, backgroundRuns: true } },
		extraArgs: ["--yolo"],
		extensionPath: fileURLToPath(new URL(`../fixtures/pr-watch-${provider}-api.js`, import.meta.url)),
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
		const status = async () => {
			const before = fixture.client.agentTextBySession().get(sessionId)?.length ?? 0
			await fixture.conn.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/pr-watch status" }] })
			return fixture.client.agentTextBySession().get(sessionId)?.slice(before) ?? ""
		}
		expect(await status()).toContain("PR watch · Not watching")
		await fixture.conn.request("session/prompt", {
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
		await expect.poll(status, { timeout: 20_000 }).toContain("PR watch · 2 ")
		const watching = await status()
		for (const target of targets) expect(watching).toContain(`Checkout: ${target.cwd}`)
		expect(watching.split("Watching · Auto-fix on · CI only")).toHaveLength(3)
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
		expect((await status()).split("Review threads 1")).toHaveLength(3)
		expect(chatRequests(fixture)).toHaveLength(count)
		for (const target of targets)
			expect(readFileSync(join(target.cwd, "answer.txt"), "utf8")).toBe(`fixed ${target.number}\n`)
		await fixture.conn.request("session/prompt", { sessionId, prompt: [{ type: "text", text: "/pr-watch stop" }] })
		expect((await status()).split("Stopped · Auto-fix off")).toHaveLength(3)
		expect(chatRequests(fixture)).toHaveLength(count)
	} finally {
		await fixture.stop()
		vi.unstubAllEnvs()
		rmSync(root, { force: true, recursive: true })
	}
}, 60_000)
