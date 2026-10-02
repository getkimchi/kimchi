import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createCommandContext, createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import * as supervisor from "../work-attribution/reconcile-supervisor.js"
import { flushWorkSummaries } from "../work-attribution/summary.js"
import { createWorkAttributionExtension, getWorkId, setWorkId } from "../work-attribution.js"
import pullRequestStatusExtension from "./index.js"
import * as discovery from "./pull-requests.js"

vi.mock("../work-attribution/reconcile-supervisor.js", () => ({
	subscribeFileReconciliation: vi.fn(),
	subscribePullRequestReconciliation: vi.fn(),
	RECONCILIATION_INTERVAL_MS: 30_000,
}))
vi.mock("./pull-requests.js", async (original) => ({
	...(await original<typeof discovery>()),
	lookupBranchPullRequest: vi.fn(),
}))

let directory: string
let ctx: ExtensionContext
const pr = {
	url: "https://github.com/example/repo/pull/7",
	number: 7,
	state: "open" as const,
	repository: "example/repo",
	host: "github.com",
	headSha: "a".repeat(40),
	mergeCommitSha: null,
	mergedAt: null,
	closedAt: null,
	checkedAt: "2026-10-02T10:00:00Z",
}
const mr = {
	...pr,
	provider: "gitlab" as const,
	url: "https://gitlab.com/example/team/repo/-/merge_requests/7",
	repository: "example/team/repo",
	host: "gitlab.com",
}
const shutdowns: (() => Promise<unknown>)[] = []
async function start(api: ReturnType<typeof createExtensionApi>) {
	for (const handler of api.getHandlers<SessionStartEvent>("session_start"))
		await handler({ type: "session_start", reason: "new" }, ctx)
	shutdowns.push(async () => {
		for (const handler of api.getHandlers("session_shutdown"))
			await handler({ type: "session_shutdown", reason: "quit" }, ctx)
	})
}
function contribution(workId: string): discovery.WorkPullRequestUpdate {
	return {
		workId,
		sessionId: "writer",
		cwd: directory,
		repository: join(directory, ".git"),
		worktree: directory,
		sha: pr.headSha,
		prLookup: { status: "linked", checkedAt: pr.checkedAt },
		pullRequests: [pr],
	}
}
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "kimchi-pr-status-"))
	vi.stubEnv("PI_CODING_AGENT_DIR", directory)
	ctx = createContext({ cwd: directory })
	vi.mocked(supervisor.subscribeFileReconciliation).mockReturnValue(async () => {})
	vi.mocked(supervisor.subscribePullRequestReconciliation).mockReturnValue(async () => {})
	vi.mocked(discovery.lookupBranchPullRequest).mockResolvedValue({ branch: "feature", pullRequest: pr })
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
})
afterEach(async () => {
	for (const shutdown of shutdowns.splice(0).reverse()) await shutdown()
	await flushWorkSummaries()
	vi.useRealTimers()
	vi.clearAllMocks()
	vi.unstubAllEnvs()
	rmSync(directory, { recursive: true, force: true })
})

describe("PR status extension", () => {
	it("shows pending PRs, explains errors once, and clears the status when work changes", async () => {
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		const status = createExtensionApi()
		pullRequestStatusExtension({ ...status.api, events: api.api.events })
		await start(api)
		await start(status)
		const update = vi.mocked(supervisor.subscribePullRequestReconciliation).mock.calls[0][0]?.onPullRequest
		const commit = {
			workId: getWorkId(ctx),
			sessionId: ctx.sessionManager.getSessionId(),
			cwd: directory,
			repository: join(directory, ".git"),
			worktree: directory,
			sha: "a".repeat(40),
			pullRequests: [],
		}
		update?.(commit)
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "PR/MR: waiting")
		const failed = {
			...commit,
			prLookup: { status: "error" as const, checkedAt: new Date().toISOString(), error: "Run gh auth login" },
		}
		update?.(failed)
		update?.(failed)
		await Promise.resolve()
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "PR/MR: check /work")
		expect(ctx.ui.notify).toHaveBeenCalledTimes(1)
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("gh auth login"), "warning")
		const linked = {
			...commit,
			prLookup: { status: "linked" as const, checkedAt: new Date().toISOString() },
			pullRequests: [
				{
					url: "https://github.com/example/repo/pull/7",
					number: 7,
					state: "open" as const,
					repository: "example/repo",
					host: "github.com",
					headSha: commit.sha,
					mergeCommitSha: null,
					mergedAt: null,
					closedAt: null,
					checkedAt: new Date().toISOString(),
				},
			],
		}
		update?.(linked)
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "PR: #7 open")
		const checkedAt = new Date(Date.now() + 1000).toISOString()
		update?.({
			...linked,
			sessionId: "newer-contributor",
			prLookup: { status: "linked", checkedAt },
			pullRequests: [{ ...linked.pullRequests[0], state: "merged", mergedAt: checkedAt, checkedAt }],
		})
		// Snapshot replay can still contain another contributor's older observation.
		update?.(linked)
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "PR: #7 merged")
		const warningCount = vi.mocked(ctx.ui.notify).mock.calls.length
		const otherSha = "b".repeat(40)
		update?.({
			...failed,
			sha: otherSha,
			prLookup: { ...failed.prLookup, error: "Old access failure" },
		})
		update?.({
			...linked,
			sha: otherSha,
			sessionId: "newer-contributor",
			prLookup: { status: "linked", checkedAt },
		})
		await Promise.resolve()
		expect(ctx.ui.notify).toHaveBeenCalledTimes(warningCount)
		const commandCtx = { ...createCommandContext(), ...ctx }
		await api.getRegisteredCommand("work").handler("", commandCtx)
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining(linked.pullRequests[0].url), "info")
		await api.getRegisteredCommand("work").handler("new", commandCtx)
		update?.(linked)
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", undefined)
	})
	it("checks the current branch without work tracking and writes no work records", async () => {
		const api = createExtensionApi()
		pullRequestStatusExtension(api.api)
		await start(api)
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenCalledWith("work-pr", "PR: #7 open"))
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("work-pr-url", pr.url)
		expect(supervisor.subscribeFileReconciliation).not.toHaveBeenCalled()
		expect(supervisor.subscribePullRequestReconciliation).not.toHaveBeenCalled()
		expect(existsSync(join(directory, "work-attribution"))).toBe(false)
		await vi.advanceTimersByTimeAsync(30_000)
		expect(discovery.lookupBranchPullRequest).toHaveBeenCalledTimes(2)
	})

	it("shows GitLab merge requests without work tracking and keeps their URL separate from text", async () => {
		vi.mocked(discovery.lookupBranchPullRequest).mockResolvedValue({ branch: "feature", pullRequest: mr })
		const api = createExtensionApi()
		pullRequestStatusExtension(api.api)
		await start(api)
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenCalledWith("work-pr", "MR: !7 open"))
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("work-pr-url", mr.url)
		expect(existsSync(join(directory, "work-attribution"))).toBe(false)
		expect(supervisor.subscribePullRequestReconciliation).not.toHaveBeenCalled()
	})

	it("names tracked GitLab links in the footer and work details", async () => {
		const work = createExtensionApi()
		const status = createExtensionApi()
		createWorkAttributionExtension()(work.api)
		pullRequestStatusExtension({ ...status.api, events: work.api.events })
		await start(work)
		await start(status)
		const update = vi.mocked(supervisor.subscribePullRequestReconciliation).mock.calls[0][0].onPullRequest
		update({ ...contribution(getWorkId(ctx)), pullRequests: [mr] })
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "MR: !7 open")
		await work.getRegisteredCommand("work").handler("", { ...createCommandContext(), ...ctx })
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining(`MR !7 open: ${mr.url}`), "info")
	})

	it("keeps a branch without a PR quiet and reports auth errors without suggesting an absent command", async () => {
		vi.mocked(discovery.lookupBranchPullRequest).mockResolvedValue({ branch: "feature" })
		const api = createExtensionApi()
		pullRequestStatusExtension(api.api)
		await start(api)
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", undefined))
		expect(ctx.ui.notify).not.toHaveBeenCalled()
		vi.mocked(discovery.lookupBranchPullRequest).mockRejectedValue(new Error("Run gh auth login"))
		await vi.advanceTimersByTimeAsync(30_000)
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "PR/MR: unavailable"))
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("gh auth login"), "warning")
		expect(JSON.stringify(vi.mocked(ctx.ui.setStatus).mock.calls)).not.toContain("/work")
		expect(existsSync(join(directory, "work-attribution"))).toBe(false)
	})

	it("clears the previous branch link before waiting for its replacement and never overlaps polls", async () => {
		const api = createExtensionApi()
		pullRequestStatusExtension(api.api)
		await start(api)
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "PR: #7 open"))
		let finish!: (result: discovery.BranchPullRequest) => void
		const pending = new Promise<discovery.BranchPullRequest>((resolve) => {
			finish = resolve
		})
		vi.mocked(discovery.lookupBranchPullRequest).mockImplementation(async (_cwd, _signal, onBranch) => {
			onBranch?.("other")
			return pending
		})
		try {
			await vi.advanceTimersByTimeAsync(30_000)
			expect(ctx.ui.setStatus).toHaveBeenCalledWith("work-pr-url", undefined)
			expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", undefined)
			await vi.advanceTimersByTimeAsync(60_000)
			expect(discovery.lookupBranchPullRequest).toHaveBeenCalledTimes(2)
		} finally {
			finish({ branch: "other", pullRequest: { ...pr, number: 8, url: "https://github.com/example/repo/pull/8" } })
		}
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "PR: #8 open"))
	})

	it("cancels a stale repository lookup after the session changes", async () => {
		let finish!: (result: discovery.BranchPullRequest) => void
		const pending = new Promise<discovery.BranchPullRequest>((resolve) => {
			finish = resolve
		})
		vi.mocked(discovery.lookupBranchPullRequest).mockReturnValueOnce(pending)
		const api = createExtensionApi()
		pullRequestStatusExtension(api.api)
		await start(api)
		const signal = vi.mocked(discovery.lookupBranchPullRequest).mock.calls[0][1]
		const second = createContext({ cwd: join(directory, "second"), sessionManager: { getSessionId: () => "second" } })
		vi.mocked(discovery.lookupBranchPullRequest).mockResolvedValue({
			branch: "second",
			pullRequest: { ...pr, number: 8, url: "https://github.com/example/repo/pull/8" },
		})
		await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "new" }, second)
		expect(signal.aborted).toBe(true)
		finish({ branch: "old", pullRequest: pr })
		await vi.waitFor(() => expect(second.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "PR: #8 open"))
		expect(second.ui.setStatus).not.toHaveBeenCalledWith("work-pr-url", pr.url)
	})

	it("aborts and drains a standalone lookup on shutdown", async () => {
		vi.mocked(discovery.lookupBranchPullRequest).mockImplementation(async (_cwd, signal) => {
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
			return undefined
		})
		const api = createExtensionApi()
		pullRequestStatusExtension(api.api)
		await start(api)
		const signal = vi.mocked(discovery.lookupBranchPullRequest).mock.calls[0][1]
		await api.getHandler("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx)
		expect(signal.aborted).toBe(true)
		await vi.advanceTimersByTimeAsync(60_000)
		expect(discovery.lookupBranchPullRequest).toHaveBeenCalledOnce()
		expect(ctx.ui.notify).not.toHaveBeenCalled()
	})

	it("stops standalone work when attribution activates without applying the old branch result", async () => {
		let finish!: (result: discovery.BranchPullRequest) => void
		const pending = new Promise<discovery.BranchPullRequest>((resolve) => {
			finish = resolve
		})
		vi.mocked(discovery.lookupBranchPullRequest).mockReturnValueOnce(pending)
		const status = createExtensionApi()
		pullRequestStatusExtension(status.api)
		await start(status)
		const signal = vi.mocked(discovery.lookupBranchPullRequest).mock.calls[0][1]
		const work = createExtensionApi()
		createWorkAttributionExtension()({ ...work.api, events: status.api.events })
		await start(work)
		expect(signal.aborted).toBe(true)
		const update = vi.mocked(supervisor.subscribePullRequestReconciliation).mock.calls[0][0].onPullRequest
		update(contribution(getWorkId(ctx)))
		finish({ branch: "other", pullRequest: { ...pr, number: 8 } })
		await pending
		await Promise.resolve()
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "PR: #7 open")
	})

	it.each(["work-first", "PR-first"])("uses tracked work in either factory order: %s", async (order) => {
		const work = createExtensionApi()
		const status = createExtensionApi()
		const statusApi = { ...status.api, events: work.api.events }
		if (order === "PR-first") pullRequestStatusExtension(statusApi)
		createWorkAttributionExtension()(work.api)
		if (order === "work-first") pullRequestStatusExtension(statusApi)
		for (const api of order === "work-first" ? [work, status] : [status, work]) await start(api)
		expect(discovery.lookupBranchPullRequest).not.toHaveBeenCalled()
		expect(supervisor.subscribePullRequestReconciliation).toHaveBeenCalledOnce()
		const update = vi.mocked(supervisor.subscribePullRequestReconciliation).mock.calls[0][0].onPullRequest
		update(contribution(getWorkId(ctx)))
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("work-pr", "PR: #7 open")
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("work-pr-url", pr.url)
		const commandCtx = { ...createCommandContext(), ...ctx }
		await work.getRegisteredCommand("work").handler("", commandCtx)
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining(pr.url), "info")
		await work.getRegisteredCommand("work").handler("new", commandCtx)
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("work-pr-url", undefined)
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", undefined)
		const restored = "11111111-1111-4111-8111-111111111111"
		update(contribution(restored))
		setWorkId(ctx, restored, work.api)
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "PR: #7 open")
	})
})
