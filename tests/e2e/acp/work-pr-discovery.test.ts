import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, it, vi } from "vitest"
import { readWorkSummary } from "../tui/support/work-summary.js"
import { type AcpFixture, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

let fixture: AcpFixture | undefined
let apiDir: string | undefined

afterEach(async () => {
	await fixture?.stop()
	vi.unstubAllEnvs()
	if (apiDir) rmSync(apiDir, { recursive: true, force: true })
})

async function expectNotification(
	active: AcpFixture,
	sessionId: string,
	payload: Record<string, unknown>,
	after = 0,
): Promise<void> {
	await expect
		.poll(() => active.client.extNotifications.slice(after), { timeout: 10_000 })
		.toContainEqual({
			method: "_kimchi.dev/pi_notify",
			params: expect.objectContaining({ sessionId, ...payload }),
		})
}

it("shows pending and discovered GitLab MR details over ACP without a model request", async () => {
	apiDir = mkdtempSync(join(tmpdir(), "kimchi-acp-pr-api-"))
	const statePath = join(apiDir, "state.json")
	const callsPath = join(apiDir, "calls.jsonl")
	writeFileSync(callsPath, "")
	writeFileSync(statePath, JSON.stringify({ mode: "hold", headSha: "" }))
	vi.stubEnv("GH_TOKEN", "pr-api-test-token")
	vi.stubEnv("GITLAB_TOKEN", "pr-api-test-token")
	vi.stubEnv("GL_TOKEN", "pr-api-test-token")
	vi.stubEnv("GITLAB_HOST", "gitlab.com")
	for (const key of [
		"GH_HOST",
		"GL_HOST",
		"GITHUB_TOKEN",
		"GH_ENTERPRISE_TOKEN",
		"GITHUB_ENTERPRISE_TOKEN",
		"GITLAB_ACCESS_TOKEN",
	])
		vi.stubEnv(key, "")
	vi.stubEnv("KIMCHI_TEST_PR_PROVIDER", "gitlab")
	vi.stubEnv("KIMCHI_TEST_PR_TOKEN", "pr-api-test-token")
	vi.stubEnv("KIMCHI_TEST_PR_CALLS", callsPath)
	vi.stubEnv("KIMCHI_TEST_PR_STATE", statePath)
	fixture = await startAcpFixture({
		artifactName: "work-pr-discovery",
		extensionPath: fileURLToPath(new URL("../tui/support/fixtures/pr-api.js", import.meta.url)),
		responses: [],
		pretrustWorkDir: true,
		clientMeta: { "kimchi.dev": { pi_notify: true } },
	})

	const cwd = fixture.workDir
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
	git("init", "--initial-branch=main")
	git("config", "user.name", "PR Discovery Test")
	git("config", "user.email", "discovery@example.invalid")
	git("config", "commit.gpgSign", "false")
	git("remote", "add", "origin", "https://gitlab.com/example/group/kimchi-lab.git")
	writeFileSync(join(cwd, "hello.txt"), "hello\n")
	git("add", "hello.txt")
	git("commit", "-m", "Add greeting")
	const sha = git("rev-parse", "HEAD")
	writeFileSync(statePath, JSON.stringify({ mode: "hold", headSha: sha }))
	const workId = randomUUID()
	const agentDir = join(fixture.homeDir, ".config", "kimchi", "harness")
	const ledgerDir = join(agentDir, "work-attribution")
	mkdirSync(ledgerDir, { recursive: true })
	const identity = { version: 1, sessionId: "source", workId, cwd, recordedAt: new Date().toISOString() }
	writeFileSync(
		join(ledgerDir, "source.jsonl"),
		`${[
			{ ...identity, type: "work" },
			{
				...identity,
				type: "commit",
				sha,
				repository: realpathSync(join(cwd, ".git")),
				worktree: realpathSync(cwd),
				prLookup: { status: "pending", checkedAt: identity.recordedAt },
			},
		]
			.map((record) => JSON.stringify(record))
			.join("\n")}\n`,
	)
	mkdirSync(join(cwd, ".kimchi", "plans"), { recursive: true })
	writeFileSync(join(cwd, ".kimchi", "plans", "lookup.md"), `<!-- kimchi-work-id: ${workId} -->\n# Add a greeting\n`)

	const sessionId = await newSession(fixture, cwd)
	expect((await prompt(fixture, sessionId, "/work .kimchi/plans/lookup.md")).stopReason).toBe("end_turn")
	await expectNotification(fixture, sessionId, {
		method: "setStatus",
		statusKey: "work-pr",
		statusText: "PR/MR waiting",
	})
	const beforePending = fixture.client.extNotifications.length
	expect((await prompt(fixture, sessionId, "/work")).stopReason).toBe("end_turn")
	await expectNotification(
		fixture,
		sessionId,
		{
			method: "notify",
			notifyType: "info",
			message: expect.stringContaining(`Work ID: ${workId}\nPR/MR lookup: 1 commit waiting\nCost`),
		},
		beforePending,
	)

	const url = "https://gitlab.com/example/group/kimchi-lab/-/merge_requests/731"
	writeFileSync(`${statePath}.tmp`, JSON.stringify({ mode: "open", headSha: sha }))
	renameSync(`${statePath}.tmp`, statePath)
	await expectNotification(fixture, sessionId, {
		method: "setStatus",
		statusKey: "work-pr",
		statusText: "MR !731 open",
	})
	await expectNotification(fixture, sessionId, {
		method: "setStatus",
		statusKey: "work-pr-url",
		statusText: url,
	})
	expect(fixture.client.extNotifications).not.toContainEqual(
		expect.objectContaining({
			params: expect.objectContaining({ statusKey: "work-pr", statusText: expect.stringContaining("\x1b") }),
		}),
	)
	const beforeLinked = fixture.client.extNotifications.length
	expect((await prompt(fixture, sessionId, "/work")).stopReason).toBe("end_turn")
	await expectNotification(
		fixture,
		sessionId,
		{
			method: "notify",
			notifyType: "info",
			message: expect.stringContaining(`Work ID: ${workId}\nMR !731 open: ${url}\nCost`),
		},
		beforeLinked,
	)
	await expect
		.poll(() => readWorkSummary(agentDir, workId)?.commits)
		.toEqual([
			expect.objectContaining({
				sha,
				prLookup: expect.objectContaining({ status: "linked" }),
				pullRequests: [
					expect.objectContaining({
						url,
						provider: "gitlab",
						number: 731,
						state: "open",
						headSha: sha,
						repository: "example/group/kimchi-lab",
						host: "gitlab.com",
					}),
				],
			}),
		])
	const calls = readFileSync(callsPath, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
	expect(calls.filter((call) => call.kind === "commit")).toEqual([
		{
			kind: "commit",
			mode: "open",
			tokenMatched: true,
			path: `/api/v4/projects/example%2Fgroup%2Fkimchi-lab/repository/commits/${sha}/merge_requests`,
		},
	])
	expect(calls.every((call) => call.tokenMatched)).toBe(true)
	const modelRequests = fixture.fake.requests.filter((request) => request.url.includes("/chat/completions"))
	expect(modelRequests, "commands and background PR lookup must not ask a model").toHaveLength(0)
})
