import type { ExecFileOptions } from "node:child_process"
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { readWorkPullRequestUpdates, reconcileWorkPullRequests, type WorkPullRequestUpdate } from "./pull-requests.js"
import * as summaries from "./summary.js"

const cli = vi.hoisted(() => ({
	run: vi.fn<(args: string[], options: ExecFileOptions) => Promise<unknown>>(),
}))
vi.mock("node:child_process", async (original) => ({
	...(await original<typeof import("node:child_process")>()),
	execFile: vi.fn((command, args, options, callback) => {
		expect(command).toBe("gh")
		void cli.run(args, options).then(
			(value) => callback(null, JSON.stringify(value), ""),
			(error) => callback(error, "", error.stderr ?? ""),
		)
	}),
}))

const workId = "11111111-1111-4111-8111-111111111111"
const otherWorkId = "22222222-2222-4222-8222-222222222222"
const sha = "a".repeat(40)
let directory: string
let repository: string
let agentDir: string
let updates: WorkPullRequestUpdate[]

function seed(overrides: Record<string, unknown> = {}, transitions = false): void {
	const source = join(agentDir, "work-attribution", ...(transitions ? ["transitions"] : []))
	mkdirSync(source, { recursive: true })
	appendFileSync(
		join(source, "source.jsonl"),
		`${JSON.stringify({
			version: 1,
			type: "commit",
			workId,
			sessionId: "writer",
			cwd: join(directory, "removed-worktree"),
			worktree: join(directory, "removed-worktree"),
			repository,
			sha,
			...overrides,
		})}\n`,
	)
}
function pull(number = 7, overrides: Record<string, unknown> = {}) {
	return {
		html_url: `https://github.com/team/repo/pull/${number}`,
		number,
		state: "open",
		head: { sha },
		merge_commit_sha: null,
		merged_at: null,
		closed_at: null,
		...overrides,
	}
}
function lookup(signal = new AbortController().signal, assertLease = () => {}): Promise<void> {
	return reconcileWorkPullRequests(agentDir, signal, assertLease, (update) => updates.push(update))
}
function saved(sessionId = "writer") {
	return readFileSync(join(agentDir, "work-attribution", `${sessionId}.jsonl`), "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
}
function apiCalls() {
	return cli.run.mock.calls.filter(([args]) => args[0] === "api").map(([args]) => args)
}

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "kimchi-pull-requests-"))
	repository = join(directory, "repo.git")
	agentDir = join(directory, "agent")
	mkdirSync(repository)
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir)
	updates = []
	cli.run.mockReset()
	cli.run.mockImplementation(async (args) =>
		args[0] === "repo" ? { nameWithOwner: "team/repo", url: "https://github.com/team/repo" } : [[]],
	)
})
afterEach(async () => {
	await summaries.flushWorkSummaries()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	rmSync(directory, { recursive: true, force: true })
})

describe("work pull request discovery", () => {
	it("reads another process's durable PR updates without network requests or ledger writes", () => {
		seed()
		const first = readWorkPullRequestUpdates(agentDir)
		expect(first).toMatchObject([{ workId, sessionId: "writer", repository, sha, pullRequests: [] }])
		expect(first[0].prLookup).toBeUndefined()
		const checkedAt = new Date().toISOString()
		seed({
			prLookup: { status: "linked", checkedAt },
			pullRequests: [
				{
					url: "https://github.com/team/repo/pull/7",
					number: 7,
					state: "closed",
					repository: "team/repo",
					host: "github.com",
					headSha: sha,
					mergeCommitSha: null,
					mergedAt: null,
					closedAt: checkedAt,
					checkedAt,
				},
			],
		})
		const sourcePath = join(agentDir, "work-attribution", "source.jsonl")
		const sourceBefore = readFileSync(sourcePath, "utf8")
		const latest = readWorkPullRequestUpdates(agentDir)
		expect(latest).toHaveLength(1)
		expect(latest[0]).toMatchObject({
			workId,
			sessionId: "writer",
			repository,
			sha,
			cwd: join(directory, "removed-worktree"),
			worktree: join(directory, "removed-worktree"),
			prLookup: { status: "linked", checkedAt },
			pullRequests: [{ number: 7, state: "closed" }],
		})
		expect(readFileSync(sourcePath, "utf8")).toBe(sourceBefore)
		expect(() => saved()).toThrow()
		expect(cli.run).not.toHaveBeenCalled()
	})

	it("reads both source journals without a summary and fans one lookup out to the original contributors", async () => {
		seed()
		seed({ workId: otherWorkId, sessionId: "second" }, true)
		cli.run.mockImplementation(async (args) =>
			args[0] === "repo" ? { nameWithOwner: "team/repo", url: "https://github.com/team/repo" } : [[pull()]],
		)
		await lookup()
		expect(apiCalls()).toEqual([
			[
				"api",
				"--method",
				"GET",
				"--hostname",
				"github.com",
				`repos/team/repo/commits/${sha}/pulls`,
				"--paginate",
				"--slurp",
			],
		])
		for (const [sessionId, expectedWorkId] of [
			["writer", workId],
			["second", otherWorkId],
		]) {
			expect(saved(sessionId).at(-1)).toMatchObject({
				type: "commit",
				workId: expectedWorkId,
				sessionId,
				repository,
				sha,
				cwd: join(directory, "removed-worktree"),
				worktree: join(directory, "removed-worktree"),
				prLookup: { status: "linked" },
				pullRequests: [
					{
						url: "https://github.com/team/repo/pull/7",
						number: 7,
						state: "open",
						repository: "team/repo",
						host: "github.com",
						headSha: sha,
						mergeCommitSha: null,
						mergedAt: null,
						closedAt: null,
					},
				],
			})
		}
		expect(updates.map((update) => update.workId)).toContain(otherWorkId)
		expect(cli.run.mock.calls[0][1].cwd).toBe(repository)
	})

	it("keeps an unassociated commit pending and finds a PR created between polls, including every page", async () => {
		seed()
		await lookup()
		expect(saved().at(-1).prLookup.status).toBe("pending")
		cli.run.mockImplementation(async (args) =>
			args[0] === "repo"
				? { nameWithOwner: "team/repo", url: "https://github.com/team/repo" }
				: [[pull()], [pull(8), pull()]],
		)
		await lookup()
		expect(
			saved()
				.at(-1)
				.pullRequests.map((entry: { number: number }) => entry.number),
		).toEqual([7, 8])
	})

	it("refreshes a known PR after the original commit disappears in a squash or force push", async () => {
		seed()
		cli.run.mockImplementation(async (args) =>
			args[0] === "repo" ? { nameWithOwner: "team/repo", url: "https://github.com/team/repo" } : [[pull()]],
		)
		await lookup()
		cli.run.mockImplementation(async (args) => {
			if (args[0] === "repo") return { nameWithOwner: "team/repo", url: "https://github.com/team/repo" }
			if (args.includes(`repos/team/repo/commits/${sha}/pulls`)) return [[]]
			return pull(7, {
				state: "closed",
				head: { sha: "b".repeat(40) },
				merge_commit_sha: "c".repeat(40),
				merged_at: "2026-10-02T12:00:00Z",
				closed_at: "2026-10-02T12:00:00Z",
			})
		})
		await lookup()
		expect(apiCalls().at(-1)).toEqual(["api", "--method", "GET", "--hostname", "github.com", "repos/team/repo/pulls/7"])
		expect(saved().at(-1)).toMatchObject({
			prLookup: { status: "linked" },
			pullRequests: [{ state: "merged", headSha: "b".repeat(40), mergeCommitSha: "c".repeat(40) }],
		})
		cli.run.mockClear()
		updates = []
		await lookup()
		expect(cli.run).not.toHaveBeenCalled()
		expect(updates.at(-1)?.pullRequests[0].state).toBe("merged")
	})

	it("clears ambient repository overrides and bounds CLI output and execution time", async () => {
		seed()
		vi.stubEnv("GH_REPO", "wrong/remote")
		vi.stubEnv("GIT_DIR", "/another/repository")
		await lookup()
		for (const [, options] of cli.run.mock.calls) {
			expect(options.env?.GH_REPO).toBeUndefined()
			expect(options.env?.GIT_DIR).toBeUndefined()
			expect(options.env?.GH_PROMPT_DISABLED).toBe("1")
			expect(options.timeout).toBeGreaterThan(0)
			expect(options.timeout).toBeLessThanOrEqual(10_000)
			expect(options.maxBuffer).toBeLessThanOrEqual(8 * 1024 * 1024)
			expect(options.signal).toBeInstanceOf(AbortSignal)
		}
	})

	it("records a safe retryable authentication error without copying credentials from stderr", async () => {
		seed()
		cli.run.mockRejectedValue(
			Object.assign(new Error("secret ghp_should_not_escape"), {
				code: 4,
				stderr: "token=ghp_should_not_escape HTTP 401",
			}),
		)
		await lookup()
		expect(saved().at(-1).prLookup).toMatchObject({
			status: "error",
			error: "GitHub CLI is not signed in. Run gh auth login.",
		})
		expect(JSON.stringify(saved())).not.toContain("should_not_escape")
		cli.run.mockImplementation(async (args) =>
			args[0] === "repo" ? { nameWithOwner: "team/repo", url: "https://github.com/team/repo" } : [[pull()]],
		)
		await lookup()
		expect(saved().at(-1).prLookup).toMatchObject({ status: "linked" })
		expect(saved().at(-1).prLookup.error).toBeUndefined()
	})

	it("does not publish after cancellation or losing the reconciliation lease", async () => {
		seed()
		const controller = new AbortController()
		cli.run.mockImplementation(async () => {
			controller.abort()
			return { nameWithOwner: "team/repo", url: "https://github.com/team/repo" }
		})
		await expect(lookup(controller.signal)).rejects.toThrow()
		expect(() => saved()).toThrow()
		cli.run.mockImplementation(async (args) =>
			args[0] === "repo" ? { nameWithOwner: "team/repo", url: "https://github.com/team/repo" } : [[pull()]],
		)
		await expect(
			lookup(undefined, () => {
				throw new Error("lease lost")
			}),
		).rejects.toThrow("lease lost")
		expect(() => saved()).toThrow()
	})

	it("catches up a contributor whose journal still has an older PR state", async () => {
		seed()
		cli.run.mockImplementation(async (args) =>
			args[0] === "repo"
				? { nameWithOwner: "team/repo", url: "https://github.com/team/repo" }
				: [[pull(7, { state: "closed", merged_at: "2026-10-01T12:00:00Z", closed_at: "2026-10-01T12:00:00Z" })]],
		)
		await lookup()
		seed({
			workId: otherWorkId,
			sessionId: "second",
			prLookup: { status: "linked", checkedAt: "2026-10-01T10:00:00Z" },
			pullRequests: [
				{
					...saved().at(-1).pullRequests[0],
					state: "open",
					mergedAt: null,
					closedAt: null,
					checkedAt: "2026-10-01T10:00:00Z",
				},
			],
		})
		await lookup()
		expect(saved("second").at(-1).pullRequests[0].state).toBe("merged")
	})

	it("does not hide a failed known-PR refresh when another known PR succeeds", async () => {
		seed()
		cli.run.mockImplementation(async (args) =>
			args[0] === "repo" ? { nameWithOwner: "team/repo", url: "https://github.com/team/repo" } : [[pull(), pull(8)]],
		)
		await lookup()
		cli.run.mockImplementation(async (args) => {
			if (args[0] === "repo") return { nameWithOwner: "team/repo", url: "https://github.com/team/repo" }
			if (args.includes("repos/team/repo/pulls/8")) return pull(8)
			throw Object.assign(new Error("not found"), { stderr: "HTTP 404" })
		})
		await lookup()
		expect(saved().at(-1).prLookup.status).toBe("error")
		expect(saved().at(-1).pullRequests).toHaveLength(2)
	})

	it("replays source records after restart and follows a closed PR when it reopens", async () => {
		seed()
		cli.run.mockImplementation(async (args) =>
			args[0] === "repo"
				? { nameWithOwner: "team/repo", url: "https://github.com/team/repo" }
				: [[pull(7, { state: "closed", closed_at: "2026-10-01T12:00:00Z" })]],
		)
		await lookup()
		await summaries.flushWorkSummaries()
		rmSync(join(agentDir, "work"), { recursive: true, force: true })
		vi.resetModules()
		const relaunched = await import("./pull-requests.js")
		cli.run.mockImplementation(async (args) => {
			if (args[0] === "repo") return { nameWithOwner: "team/repo", url: "https://github.com/team/repo" }
			return args.includes("--paginate") ? [[]] : pull()
		})
		try {
			await relaunched.reconcileWorkPullRequests(agentDir, new AbortController().signal, () => {})
			expect(saved().at(-1)).toMatchObject({
				prLookup: { status: "linked" },
				pullRequests: [{ state: "open", closedAt: null }],
			})
		} finally {
			await (await import("./summary.js")).flushWorkSummaries()
		}
	})

	it("starts with a waiting update before GitHub responds and does not overlap concurrent passes", async () => {
		seed()
		let finish!: () => void
		const gate = new Promise<void>((resolve) => {
			finish = resolve
		})
		cli.run.mockImplementation(async (args) => {
			expect(updates[0]).toMatchObject({ sha, pullRequests: [] })
			expect(updates[0].prLookup).toBeUndefined()
			await gate
			return args[0] === "repo" ? { nameWithOwner: "team/repo", url: "https://github.com/team/repo" } : [[pull()]]
		})
		const first = lookup()
		const second = lookup()
		try {
			expect(first).toBe(second)
			expect(cli.run).toHaveBeenCalledTimes(1)
		} finally {
			finish()
		}
		await first
		expect(apiCalls()).toHaveLength(1)
		expect(saved()).toHaveLength(1)
	})

	it("moves a slow commit behind the other commits on the next bounded pass", async () => {
		seed()
		const otherSha = "b".repeat(40)
		seed({ sha: otherSha })
		let now = 0
		vi.spyOn(Date, "now").mockImplementation(() => now)
		cli.run.mockImplementation(async (args) => {
			if (args[0] === "repo") return { nameWithOwner: "team/repo", url: "https://github.com/team/repo" }
			if (args.includes(`repos/team/repo/commits/${sha}/pulls`)) now += 10_001
			return [[]]
		})
		await lookup()
		expect(apiCalls()).toHaveLength(1)
		await lookup()
		expect(apiCalls().map((args) => args[5])).toEqual([
			`repos/team/repo/commits/${sha}/pulls`,
			`repos/team/repo/commits/${otherSha}/pulls`,
			`repos/team/repo/commits/${sha}/pulls`,
		])
	})

	it("deduplicates the provider request across separate clones of the same repository", async () => {
		seed()
		const secondRepository = join(directory, "second.git")
		mkdirSync(secondRepository)
		seed({ repository: secondRepository, sessionId: "second", workId: otherWorkId })
		await lookup()
		expect(cli.run.mock.calls.filter(([args]) => args[0] === "repo")).toHaveLength(2)
		expect(apiCalls()).toHaveLength(1)
		expect(saved("second").at(-1).repository).toBe(secondRepository)
	})

	it("uses the host returned by gh for an Enterprise repository", async () => {
		seed()
		cli.run.mockImplementation(async (args) =>
			args[0] === "repo"
				? { nameWithOwner: "team/repo", url: "https://github.company.example/team/repo" }
				: [[pull(7, { html_url: "https://github.company.example/team/repo/pull/7" })]],
		)
		await lookup()
		expect(apiCalls()[0]).toContain("github.company.example")
		expect(saved().at(-1).pullRequests[0].host).toBe("github.company.example")
	})

	it.each([
		[{ code: "ENOENT" }, "GitHub CLI is not installed."],
		[{ stderr: "HTTP 429 rate limit token=secret" }, "GitHub rate limit reached. Kimchi will retry."],
		[{ stderr: "HTTP 403" }, "GitHub denied access. Check gh authentication and repository permissions."],
		[{ killed: true }, "GitHub lookup timed out. Kimchi will retry."],
		[{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }, "GitHub response exceeded the lookup limit."],
	])("reports a bounded safe error for %j", async (failure, message) => {
		seed()
		cli.run.mockRejectedValue(Object.assign(new Error("secret"), failure))
		await lookup()
		expect(saved().at(-1).prLookup).toMatchObject({ status: "error", error: message })
	})

	it("retains known links when GitHub returns malformed pages", async () => {
		seed()
		cli.run.mockImplementation(async (args) =>
			args[0] === "repo" ? { nameWithOwner: "team/repo", url: "https://github.com/team/repo" } : [[pull()]],
		)
		await lookup()
		cli.run.mockImplementation(async (args) => {
			if (args[0] === "repo") return { nameWithOwner: "team/repo", url: "https://github.com/team/repo" }
			return args.includes("--paginate") ? { unexpected: "response" } : pull()
		})
		await lookup()
		expect(saved().at(-1)).toMatchObject({
			prLookup: { status: "error", error: "GitHub returned invalid pull request pages." },
			pullRequests: [{ number: 7 }],
		})
	})

	it("retains a known PR when the old commit returns 404 but the PR itself still exists", async () => {
		seed()
		cli.run.mockImplementation(async (args) =>
			args[0] === "repo" ? { nameWithOwner: "team/repo", url: "https://github.com/team/repo" } : [[pull()]],
		)
		await lookup()
		cli.run.mockImplementation(async (args) => {
			if (args[0] === "repo") return { nameWithOwner: "team/repo", url: "https://github.com/team/repo" }
			if (args.includes("--paginate")) throw Object.assign(new Error("gone"), { stderr: "HTTP 404" })
			return pull()
		})
		await lookup()
		expect(saved().at(-1)).toMatchObject({ prLookup: { status: "linked" }, pullRequests: [{ number: 7 }] })
	})

	it("reads only changed journals after startup and does not advance past a failed source read", async () => {
		seed()
		const reads = vi.spyOn(summaries, "readWorkRecords")
		await lookup()
		expect(reads.mock.calls[0]).toEqual([agentDir, undefined])
		reads.mockImplementationOnce(() => {
			throw new Error("ledger unavailable")
		})
		await expect(lookup()).rejects.toThrow("ledger unavailable")
		const failedCheckpoint = reads.mock.calls[1][1]
		expect(failedCheckpoint).toEqual(expect.any(Number))
		await lookup()
		expect(reads.mock.calls[2][1]).toBe(failedCheckpoint)
		expect(apiCalls()).toHaveLength(2)
	})
})
