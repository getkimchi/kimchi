import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, expect, it, vi } from "vitest"
import { BILLING_ACCOUNT, seedPendingWorkCost } from "../tui/support/work-costs.js"
import { type AcpFixture, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt, waitFor } from "./support/scenarios.js"

let fixture: AcpFixture | undefined
let apiDir: string | undefined

afterEach(async () => {
	await fixture?.stop()
	vi.unstubAllEnvs()
	if (apiDir) rmSync(apiDir, { recursive: true, force: true })
})

function notifyMessage({ method, params }: { method: string; params: unknown }, sessionId: string) {
	if (method !== "_kimchi.dev/pi_notify" || typeof params !== "object" || params === null) return undefined
	if (!("sessionId" in params) || params.sessionId !== sessionId || !("method" in params) || params.method !== "notify")
		return undefined
	return "message" in params && typeof params.message === "string" ? params.message : undefined
}

/** Runs `/work` and returns the details it shows, as the ACP client receives them. */
async function workDetails(active: AcpFixture, sessionId: string): Promise<string> {
	const before = active.client.extNotifications.length
	expect((await prompt(active, sessionId, "/work")).stopReason).toBe("end_turn")
	const message = await waitFor(
		() =>
			active.client.extNotifications
				.slice(before)
				.map((entry) => notifyMessage(entry, sessionId))
				.find((text) => text?.startsWith("Work ID:")),
		(text) => text !== undefined,
		10_000,
	)
	return message ?? ""
}

it("shows an open MR's pending cost, then its confirmed and inferred total once billed and merged over ACP", async () => {
	apiDir = mkdtempSync(join(tmpdir(), "kimchi-acp-cost-api-"))
	const statePath = join(apiDir, "state.json")
	const callsPath = join(apiDir, "calls.jsonl")
	writeFileSync(callsPath, "")
	writeFileSync(statePath, JSON.stringify({ mode: "open", headSha: "" }))
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
		"KIMCHI_API_KEY",
	])
		vi.stubEnv(key, "")
	vi.stubEnv("KIMCHI_TEST_PR_PROVIDER", "gitlab")
	vi.stubEnv("KIMCHI_TEST_PR_TOKEN", "pr-api-test-token")
	vi.stubEnv("KIMCHI_TEST_PR_CALLS", callsPath)
	vi.stubEnv("KIMCHI_TEST_PR_STATE", statePath)
	let billed = false
	fixture = await startAcpFixture({
		artifactName: "work-costs",
		extensionPath: fileURLToPath(new URL("../tui/support/fixtures/pr-api.js", import.meta.url)),
		responses: [],
		account: BILLING_ACCOUNT,
		billingRows: () => (billed ? [{ id: "50000000-0000-4000-8000-000000000005", totalPrice: "0.000166000" }] : []),
		pretrustWorkDir: true,
		clientMeta: { "kimchi.dev": { pi_notify: true } },
	})

	const cwd = fixture.workDir
	const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim()
	git("init", "--initial-branch=main")
	git("config", "user.name", "PR Cost Test")
	git("config", "user.email", "costs@example.invalid")
	git("config", "commit.gpgSign", "false")
	git("remote", "add", "origin", "https://gitlab.com/example/group/kimchi-lab.git")
	writeFileSync(join(cwd, "hello.txt"), "hello\n")
	git("add", "hello.txt")
	git("commit", "-m", "Add greeting")
	const sha = git("rev-parse", "HEAD")
	const setGitLab = (mode: string) => {
		writeFileSync(`${statePath}.next`, JSON.stringify({ mode, headSha: sha }))
		renameSync(`${statePath}.next`, statePath)
	}
	setGitLab("open")
	const workId = randomUUID()
	const url = "https://gitlab.com/example/group/kimchi-lab/-/merge_requests/731"
	const agentDir = join(fixture.homeDir, ".config", "kimchi", "harness")
	seedPendingWorkCost({
		agentDir,
		fakeBaseUrl: fixture.fake.baseUrl,
		sessionId: "source",
		workId,
		cwd,
		repository: realpathSync(join(cwd, ".git")),
		worktree: realpathSync(cwd),
		headSha: sha,
		pullRequest: {
			provider: "gitlab",
			host: "gitlab.com",
			repository: "example/group/kimchi-lab",
			number: 731,
			url,
			state: "open",
			headSha: sha,
			mergeCommitSha: null,
			mergedAt: null,
			closedAt: null,
			checkedAt: new Date().toISOString(),
		},
	})
	mkdirSync(join(cwd, ".kimchi", "plans"), { recursive: true })
	writeFileSync(join(cwd, ".kimchi", "plans", "costs.md"), `<!-- kimchi-work-id: ${workId} -->\n# Add a greeting\n`)
	const costsPath = join(agentDir, "work", workId, "costs.json")
	const costs = () => {
		try {
			return JSON.parse(readFileSync(costsPath, "utf8"))
		} catch {
			return undefined
		}
	}

	const sessionId = await newSession(fixture, cwd)
	expect((await prompt(fixture, sessionId, "/work .kimchi/plans/costs.md")).stopReason).toBe("end_turn")
	await waitFor(costs, (value) => value?.requests?.length === 1, 45_000)
	const pending = await workDetails(fixture, sessionId)
	expect(pending).toContain("Cost so far: unknown; $0.000000000 USD priced (open)")
	expect(pending).toContain("Prices: 0/1 requests priced, $0.000000000 USD known so far.")

	billed = true
	setGitLab("merged")
	await waitFor(
		costs,
		(value) => value?.pullRequests?.some((row: { totalCostUsd?: unknown }) => row.totalCostUsd === "0.000166000"),
		75_000,
	)
	const priced = await workDetails(fixture, sessionId)
	expect(priced).toContain(`Cost: $0.000166000 USD — ${url}`)
	expect(priced).toContain("Confirmed: $0.000000000 USD; inferred: $0.000166000 USD.")
	expect(priced).toContain("Prices: 1/1 requests priced, $0.000166000 USD.")
	const modelRequests = fixture.fake.requests.filter((request) => request.url.includes("/chat/completions"))
	expect(modelRequests, "commands and background pricing must not ask a model").toHaveLength(0)
})
