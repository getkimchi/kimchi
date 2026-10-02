import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, it, vi } from "vitest"
import { type AcpFixture, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

let fixture: AcpFixture | undefined
let ghDir: string | undefined

afterEach(async () => {
	await fixture?.stop()
	vi.unstubAllEnvs()
	if (ghDir) rmSync(ghDir, { recursive: true, force: true })
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

it("shows pending and discovered PR details over ACP without a model request", async () => {
	ghDir = mkdtempSync(join(tmpdir(), "kimchi-acp-gh-"))
	const responsePath = join(ghDir, "response.json")
	const callsPath = join(ghDir, "calls.jsonl")
	mkdirSync(join(ghDir, "config"))
	writeFileSync(callsPath, "")
	writeFileSync(
		join(ghDir, "gh"),
		`#!${process.execPath}\n` +
			String.raw`
const fs = require("node:fs")
const args = process.argv.slice(2)
const credentialFree = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"].every((key) => !process.env[key])
if (!credentialFree) throw new Error("The fixture inherited GitHub credentials")
fs.appendFileSync(process.env.KIMCHI_TEST_GH_CALLS, JSON.stringify({ args, credentialFree }) + "\n")
if (JSON.stringify(args) === JSON.stringify(["repo", "view", "--json", "nameWithOwner,url"])) {
  console.log(JSON.stringify({ nameWithOwner: "example/kimchi-lab", url: "https://github.com/example/kimchi-lab" }))
} else if (args.length === 8 && JSON.stringify(args.slice(0, 5)) === JSON.stringify(["api", "--method", "GET", "--hostname", "github.com"]) && /^repos\/example\/kimchi-lab\/commits\/[a-f0-9]{40}\/pulls$/.test(args[5]) && args[6] === "--paginate" && args[7] === "--slurp") {
  const deadline = Date.now() + 8000
  while (!fs.existsSync(process.env.KIMCHI_TEST_GH_RESPONSE) && Date.now() < deadline) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25)
  }
  console.log(fs.readFileSync(process.env.KIMCHI_TEST_GH_RESPONSE, "utf8"))
} else throw new Error("Unexpected GitHub CLI command")
`,
		{ mode: 0o700 },
	)
	vi.stubEnv("PATH", `${ghDir}:${process.env.PATH ?? ""}`)
	vi.stubEnv("GH_CONFIG_DIR", join(ghDir, "config"))
	for (const key of [
		"GH_TOKEN",
		"GITHUB_TOKEN",
		"GH_ENTERPRISE_TOKEN",
		"GITHUB_ENTERPRISE_TOKEN",
		"GH_HOST",
		"GH_REPO",
		"GH_DEBUG",
	]) {
		vi.stubEnv(key, "")
	}
	vi.stubEnv("KIMCHI_TEST_GH_CALLS", callsPath)
	vi.stubEnv("KIMCHI_TEST_GH_RESPONSE", responsePath)
	fixture = await startAcpFixture({
		artifactName: "work-pr-discovery",
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
	git("remote", "add", "origin", "https://github.com/example/kimchi-lab.git")
	writeFileSync(join(cwd, "hello.txt"), "hello\n")
	git("add", "hello.txt")
	git("commit", "-m", "Add greeting")
	const sha = git("rev-parse", "HEAD")
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
	await expectNotification(fixture, sessionId, { method: "setStatus", statusKey: "work-pr", statusText: "PR: waiting" })
	const beforePending = fixture.client.extNotifications.length
	expect((await prompt(fixture, sessionId, "/work")).stopReason).toBe("end_turn")
	await expectNotification(
		fixture,
		sessionId,
		{ method: "notify", notifyType: "info", message: `Work ID: ${workId}\nPR lookup: 1 commit waiting` },
		beforePending,
	)

	const url = "https://github.com/example/kimchi-lab/pull/731"
	writeFileSync(
		`${responsePath}.tmp`,
		JSON.stringify([
			[
				{
					html_url: url,
					number: 731,
					state: "open",
					head: { sha },
					merge_commit_sha: null,
					merged_at: null,
					closed_at: null,
				},
			],
		]),
	)
	renameSync(`${responsePath}.tmp`, responsePath)
	await expectNotification(fixture, sessionId, {
		method: "setStatus",
		statusKey: "work-pr",
		statusText: "PR: #731 open",
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
		{ method: "notify", notifyType: "info", message: `Work ID: ${workId}\nPR #731 open: ${url}` },
		beforeLinked,
	)
	await expect
		.poll(() => JSON.parse(readFileSync(join(agentDir, "work", workId, "work.json"), "utf8")).commits)
		.toEqual([
			expect.objectContaining({
				sha,
				prLookup: expect.objectContaining({ status: "linked" }),
				pullRequests: [expect.objectContaining({ url, number: 731, state: "open", headSha: sha })],
			}),
		])
	const calls = readFileSync(callsPath, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
	expect(calls.filter((call) => call.args[0] === "api")).toEqual([
		{
			args: [
				"api",
				"--method",
				"GET",
				"--hostname",
				"github.com",
				`repos/example/kimchi-lab/commits/${sha}/pulls`,
				"--paginate",
				"--slurp",
			],
			credentialFree: true,
		},
	])
	const modelRequests = fixture.fake.requests.filter((request) => request.url.includes("/chat/completions"))
	expect(modelRequests, "commands and background PR lookup must not ask a model").toHaveLength(0)
})
