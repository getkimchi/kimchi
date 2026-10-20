import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, it, vi } from "vitest"
import { type AcpFixture, startAcpFixture } from "./support/acp-fixture.js"
import { newSession } from "./support/scenarios.js"

let fixture: AcpFixture | undefined
let apiDir: string | undefined

afterEach(async () => {
	await fixture?.stop()
	vi.unstubAllEnvs()
	if (apiDir) rmSync(apiDir, { recursive: true, force: true })
})

async function expectStatus(active: AcpFixture, sessionId: string, statusKey: string, statusText: string) {
	await expect
		.poll(() => active.client.extNotifications, { timeout: 15_000 })
		.toContainEqual({
			method: "_kimchi.dev/pi_notify",
			params: expect.objectContaining({ sessionId, method: "setStatus", statusKey, statusText }),
		})
}

it("shows the checked-out branch's GitLab MR in Studio's status without a model request", async () => {
	apiDir = mkdtempSync(join(tmpdir(), "kimchi-acp-pr-api-"))
	const statePath = join(apiDir, "state.json")
	const callsPath = join(apiDir, "calls.jsonl")
	writeFileSync(callsPath, "")
	writeFileSync(statePath, JSON.stringify({ mode: "hold", branch: "feature" }))
	vi.stubEnv("GITLAB_TOKEN", "pr-api-test-token")
	vi.stubEnv("GITLAB_HOST", "gitlab.com")
	for (const key of [
		"GH_TOKEN",
		"GH_HOST",
		"GL_HOST",
		"GL_TOKEN",
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
		artifactName: "branch-pr-footer",
		extensionPath: fileURLToPath(new URL("../tui/support/fixtures/pr-api.js", import.meta.url)),
		responses: [],
		pretrustWorkDir: true,
		clientMeta: { "kimchi.dev": { pi_notify: true } },
	})

	const cwd = fixture.workDir
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
	git("init", "--initial-branch=feature")
	git("remote", "add", "origin", "https://gitlab.com/example/group/kimchi-lab.git")

	const sessionId = await newSession(fixture, cwd)
	const url = "https://gitlab.com/example/group/kimchi-lab/-/merge_requests/731"
	writeFileSync(`${statePath}.tmp`, JSON.stringify({ mode: "open", branch: "feature" }))
	renameSync(`${statePath}.tmp`, statePath)
	await expectStatus(fixture, sessionId, "work-pr", "MR !731 open")
	await expectStatus(fixture, sessionId, "work-pr-url", url)
	// Studio gets readable text; only the terminal footer adds hyperlinks.
	expect(fixture.client.extNotifications).not.toContainEqual(
		expect.objectContaining({
			params: expect.objectContaining({ statusKey: "work-pr", statusText: expect.stringContaining("\x1b") }),
		}),
	)
	const calls = readFileSync(callsPath, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
	expect(calls.filter((call) => call.kind === "branch")).toEqual([
		{
			kind: "branch",
			mode: "open",
			tokenMatched: true,
			path: "/api/v4/projects/example%2Fgroup%2Fkimchi-lab/merge_requests",
		},
	])
	const modelRequests = fixture.fake.requests.filter((request) => request.url.includes("/chat/completions"))
	expect(modelRequests, "the footer's provider lookup must not ask a model").toHaveLength(0)
})
