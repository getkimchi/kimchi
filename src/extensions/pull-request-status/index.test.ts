import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent"
import { check } from "proper-lockfile"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createCommandContext, createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import * as supervisor from "../work-attribution/reconcile-supervisor.js"
import { flushWorkSummaries } from "../work-attribution/summary.js"
import { createWorkAttributionExtension, getWorkId, setWorkId } from "../work-attribution.js"
import * as branches from "./branch-status.js"
import pullRequestStatusExtension from "./index.js"
import { LookupError } from "./provider-records.js"
import type * as discovery from "./pull-requests.js"

vi.mock("../work-attribution/reconcile-supervisor.js", () => ({
	subscribeFileReconciliation: vi.fn(),
	subscribeCostReconciliation: vi.fn(),
	subscribePullRequestReconciliation: vi.fn(),
	RECONCILIATION_INTERVAL_MS: 30_000,
}))
vi.mock("./branch-status.js", () => ({
	currentBranch: vi.fn(),
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
/** Without work tracking, the footer shows the PR of the checked-out branch. */
async function startStandalone(): Promise<ReturnType<typeof createExtensionApi>> {
	vi.mocked(branches.currentBranch).mockResolvedValue("feature")
	const api = createExtensionApi()
	pullRequestStatusExtension(api.api)
	await start(api)
	return api
}
/** Only setInterval is faked; the branch refresh interval compares Date.now(). */
function afterBranchRefresh(): void {
	vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60_000)
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
/** Outside the terminal's work panel, `/work` prints its details as text. */
function textCommandContext() {
	return { ...createCommandContext(), ...ctx, mode: "rpc" as const }
}
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "kimchi-pr-status-"))
	vi.stubEnv("PI_CODING_AGENT_DIR", directory)
	ctx = createContext({ cwd: directory })
	vi.mocked(supervisor.subscribeFileReconciliation).mockReturnValue(async () => {})
	vi.mocked(supervisor.subscribeCostReconciliation).mockReturnValue(async () => {})
	vi.mocked(supervisor.subscribePullRequestReconciliation).mockReturnValue(async () => {})
	vi.mocked(branches.currentBranch).mockResolvedValue("feature")
	vi.mocked(branches.lookupBranchPullRequest).mockResolvedValue({ branch: "feature", pullRequest: pr })
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
})
afterEach(async () => {
	for (const shutdown of shutdowns.splice(0).reverse()) await shutdown()
	await flushWorkSummaries()
	vi.useRealTimers()
	vi.clearAllMocks()
	vi.restoreAllMocks()
	vi.unstubAllEnvs()
	rmSync(directory, { recursive: true, force: true })
})

describe("PR status extension", () => {
	it.each([
		"master",
		"main",
		"develop",
	])("does not show tracked PRs from another branch on default %s", async (branch) => {
		vi.mocked(branches.currentBranch).mockResolvedValue(branch)
		vi.mocked(branches.lookupBranchPullRequest).mockResolvedValue({ branch })
		const work = createExtensionApi()
		const status = createExtensionApi()
		createWorkAttributionExtension()(work.api)
		pullRequestStatusExtension({ ...status.api, events: work.api.events })
		await start(work)
		await start(status)
		await vi.waitFor(() => expect(branches.lookupBranchPullRequest).toHaveBeenCalledOnce())
		const update = vi.mocked(supervisor.subscribePullRequestReconciliation).mock.calls[0][0].onPullRequest
		update({ ...contribution(getWorkId(ctx)), pullRequests: [{ ...mr, author: "jose", state: "closed" }] })
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", branch)
		expect(ctx.ui.setStatus).not.toHaveBeenCalledWith("work-pr-url", mr.url)
		await work.getRegisteredCommand("work").handler("", textCommandContext())
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining(`MR !7 closed: ${mr.url}`), "info")
	})
	it("shows the current feature branch PR instead of another branch's tracked MR", async () => {
		vi.mocked(branches.currentBranch).mockResolvedValue("feature")
		const work = createExtensionApi()
		const status = createExtensionApi()
		createWorkAttributionExtension()(work.api)
		pullRequestStatusExtension({ ...status.api, events: work.api.events })
		await start(work)
		await start(status)
		await vi.waitFor(() => expect(branches.lookupBranchPullRequest).toHaveBeenCalledOnce())
		const update = vi.mocked(supervisor.subscribePullRequestReconciliation).mock.calls[0][0].onPullRequest
		update({ ...contribution(getWorkId(ctx)), pullRequests: [mr] })
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "feature · PR #7 open")
		expect(ctx.ui.setStatus).not.toHaveBeenCalledWith("work-pr-url", mr.url)
	})
	it.each([
		"master",
		"main",
		"develop",
	])("clears tracked links after shell checkout to %s and restores the feature PR", async (base) => {
		const work = createExtensionApi()
		const status = createExtensionApi()
		createWorkAttributionExtension()(work.api)
		pullRequestStatusExtension({ ...status.api, events: work.api.events })
		await start(work)
		await start(status)
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "feature · PR #7 open"))
		const update = vi.mocked(supervisor.subscribePullRequestReconciliation).mock.calls[0][0].onPullRequest
		update({ ...contribution(getWorkId(ctx)), pullRequests: [mr] })
		for (const branch of [base, "feature", base]) {
			vi.mocked(branches.currentBranch).mockResolvedValue(branch)
			vi.mocked(branches.lookupBranchPullRequest).mockResolvedValue({
				branch,
				...(branch === "feature" ? { pullRequest: pr } : {}),
			})
			await status.getHandler("tool_execution_end")(
				{ type: "tool_execution_end", toolCallId: branch, toolName: "bash", result: {}, isError: false },
				ctx,
			)
			await vi.waitFor(() =>
				expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
					"work-pr",
					branch === "feature" ? "feature · PR #7 open" : branch,
				),
			)
			update({ ...contribution(getWorkId(ctx)), pullRequests: [mr] })
			expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
				"work-pr",
				branch === "feature" ? "feature · PR #7 open" : branch,
			)
		}
		expect(ctx.ui.setStatus).not.toHaveBeenCalledWith("work-pr-url", mr.url)
	})
	it("rechecks a checkout that changes during the provider lookup and never shows its old PR", async () => {
		let finish!: (result: branches.BranchPullRequest | undefined) => void
		vi.mocked(branches.lookupBranchPullRequest).mockReturnValueOnce(
			new Promise((resolve) => {
				finish = resolve
			}),
		)
		await startStandalone()
		await vi.waitFor(() => expect(branches.lookupBranchPullRequest).toHaveBeenCalledOnce())
		vi.mocked(branches.currentBranch).mockResolvedValue("main")
		vi.mocked(branches.lookupBranchPullRequest).mockResolvedValue({ branch: "main" })
		finish(undefined)
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "main"))
		expect(branches.lookupBranchPullRequest).toHaveBeenCalledTimes(2)
		expect(ctx.ui.setStatus).not.toHaveBeenCalledWith("work-pr-url", pr.url)
	})
	it("clears branch and PR status on a detached HEAD even when tracked work has a link", async () => {
		vi.mocked(branches.currentBranch).mockResolvedValue(undefined)
		const work = createExtensionApi()
		const status = createExtensionApi()
		createWorkAttributionExtension()(work.api)
		pullRequestStatusExtension({ ...status.api, events: work.api.events })
		await start(work)
		await start(status)
		vi.mocked(supervisor.subscribePullRequestReconciliation).mock.calls[0][0].onPullRequest(
			contribution(getWorkId(ctx)),
		)
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", undefined)
		expect(branches.lookupBranchPullRequest).not.toHaveBeenCalled()
	})
	it("shows no branch PR on the default branch without tracking or work records", async () => {
		vi.mocked(branches.currentBranch).mockResolvedValue("master")
		vi.mocked(branches.lookupBranchPullRequest).mockResolvedValue({ branch: "master", pullRequest: undefined })
		// startStandalone() pins the checkout to feature; this case has to start on the default branch.
		const api = createExtensionApi()
		pullRequestStatusExtension(api.api)
		await start(api)
		await vi.waitFor(() => expect(branches.lookupBranchPullRequest).toHaveBeenCalledOnce())
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "master")
		expect(supervisor.subscribePullRequestReconciliation).not.toHaveBeenCalled()
		expect(existsSync(join(directory, "work-attribution"))).toBe(false)
	})
	it("clears the previous branch PR when switching to the default branch", async () => {
		await startStandalone()
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "feature · PR #7 open"))
		vi.mocked(branches.currentBranch).mockResolvedValue("master")
		vi.mocked(branches.lookupBranchPullRequest).mockResolvedValue({ branch: "master", pullRequest: undefined })
		afterBranchRefresh()
		await vi.advanceTimersByTimeAsync(30_000)
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "master"))
	})
	it("keeps the default branch quiet while tracked work has no commits yet", async () => {
		vi.mocked(branches.currentBranch).mockResolvedValue("master")
		vi.mocked(branches.lookupBranchPullRequest).mockResolvedValue({ branch: "master", pullRequest: undefined })
		const work = createExtensionApi()
		const status = createExtensionApi()
		createWorkAttributionExtension()(work.api)
		pullRequestStatusExtension({ ...status.api, events: work.api.events })
		await start(work)
		await start(status)
		await vi.waitFor(() => expect(branches.lookupBranchPullRequest).toHaveBeenCalledOnce())
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "master")
		expect(supervisor.subscribePullRequestReconciliation).toHaveBeenCalled()
	})
	it("shows one renamed PR when contributors saved different repository names", async () => {
		vi.mocked(branches.lookupBranchPullRequest).mockResolvedValue({
			branch: "feature",
			pullRequest: { ...pr, url: "https://github.com/example/renamed/pull/7" },
		})
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		const status = createExtensionApi()
		pullRequestStatusExtension({ ...status.api, events: api.api.events })
		await start(api)
		await start(status)
		const update = vi.mocked(supervisor.subscribePullRequestReconciliation).mock.calls[0][0]?.onPullRequest
		const commit = contribution(getWorkId(ctx))
		update?.({ ...commit, pullRequests: [{ ...pr, id: "42" }] })
		const renamed = {
			...pr,
			id: "42",
			url: "https://github.com/example/renamed/pull/7",
			repository: "example/renamed",
			checkedAt: "2026-10-02T11:00:00Z",
		}
		update?.({ ...commit, sessionId: "other-contributor", pullRequests: [renamed] })
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "feature · PR #7 open")
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("work-pr-url", renamed.url)
	})
	it("keeps PR titles and author logins out of the footer and /work", async () => {
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		const status = createExtensionApi()
		pullRequestStatusExtension({ ...status.api, events: api.api.events })
		await start(api)
		await start(status)
		const update = vi.mocked(supervisor.subscribePullRequestReconciliation).mock.calls[0][0].onPullRequest
		update({ ...contribution(getWorkId(ctx)), pullRequests: [{ ...pr, title: "Private roadmap", author: "octocat" }] })
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "feature · PR #7 open")
		await api.getRegisteredCommand("work").handler("", textCommandContext())
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining(`PR #7 open: ${pr.url}`), "info")
		const shown = JSON.stringify([vi.mocked(ctx.ui.setStatus).mock.calls, vi.mocked(ctx.ui.notify).mock.calls])
		expect(shown).not.toContain("Private roadmap")
		expect(shown).not.toContain("octocat")
	})
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
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "feature · PR #7 open")
		const failed = {
			...commit,
			prLookup: { status: "error" as const, checkedAt: new Date().toISOString(), error: "Run gh auth login" },
		}
		update?.(failed)
		update?.(failed)
		await Promise.resolve()
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "feature · PR #7 open")
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
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "feature · PR #7 open")
		const checkedAt = new Date(Date.now() + 1000).toISOString()
		update?.({
			...linked,
			sessionId: "newer-contributor",
			prLookup: { status: "linked", checkedAt },
			pullRequests: [{ ...linked.pullRequests[0], state: "merged", mergedAt: checkedAt, checkedAt }],
		})
		// Snapshot replay can still contain another contributor's older observation.
		update?.(linked)
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "feature · PR #7 open")
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
		const commandCtx = textCommandContext()
		await api.getRegisteredCommand("work").handler("", commandCtx)
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining(linked.pullRequests[0].url), "info")
		await api.getRegisteredCommand("work").handler("new", commandCtx)
		update?.(linked)
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "feature · PR #7 open")
	})
	it("keeps a failure saved before this session quiet and drops it after a later success", async () => {
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		const status = createExtensionApi()
		pullRequestStatusExtension({ ...status.api, events: api.api.events })
		await start(api)
		await start(status)
		const update = vi.mocked(supervisor.subscribePullRequestReconciliation).mock.calls[0][0]?.onPullRequest
		const commit = contribution(getWorkId(ctx))
		update?.({
			...commit,
			sha: "c".repeat(40),
			pullRequests: [],
			prLookup: {
				status: "error",
				checkedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
				error: "GitHub authentication failed. Check the token for github.com.",
			},
		})
		await Promise.resolve()
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "feature · PR #7 open")
		update?.({ ...commit, prLookup: { status: "linked", checkedAt: new Date().toISOString() } })
		await Promise.resolve()
		expect(ctx.ui.notify).not.toHaveBeenCalled()
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "feature · PR #7 open")
	})
	it("checks the current branch without work tracking and writes no work records", async () => {
		await startStandalone()
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenCalledWith("work-pr", "feature · PR #7 open"))
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("work-pr-url", pr.url)
		expect(supervisor.subscribeFileReconciliation).not.toHaveBeenCalled()
		expect(supervisor.subscribePullRequestReconciliation).not.toHaveBeenCalled()
		expect(existsSync(join(directory, "work-attribution"))).toBe(false)
		await vi.advanceTimersByTimeAsync(30_000)
		expect(branches.currentBranch).toHaveBeenCalledTimes(2)
	})

	it("asks the provider about a standalone branch again only after a branch change or five minutes", async () => {
		await startStandalone()
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "feature · PR #7 open"))
		await vi.advanceTimersByTimeAsync(4 * 60_000)
		// The branch is still checked locally every 30 seconds.
		expect(branches.currentBranch).toHaveBeenCalledTimes(9)
		expect(branches.lookupBranchPullRequest).toHaveBeenCalledTimes(1)
		afterBranchRefresh()
		await vi.advanceTimersByTimeAsync(30_000)
		await vi.waitFor(() => expect(branches.lookupBranchPullRequest).toHaveBeenCalledTimes(2))
		vi.mocked(branches.currentBranch).mockResolvedValue("other")
		vi.mocked(branches.lookupBranchPullRequest).mockResolvedValue({ branch: "other", pullRequest: undefined })
		await vi.advanceTimersByTimeAsync(30_000)
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "other"))
		expect(branches.lookupBranchPullRequest).toHaveBeenCalledTimes(3)
	})

	it("checks the checkout after shell commands without requerying an unchanged branch", async () => {
		const api = await startStandalone()
		await vi.waitFor(() => expect(branches.lookupBranchPullRequest).toHaveBeenCalledOnce())
		const finish = (toolName: string, call: number) =>
			api.getHandler("tool_execution_end")(
				{ type: "tool_execution_end", toolCallId: `t${call}`, toolName, result: {}, isError: false },
				ctx,
			)
		for (let call = 0; call < 20; call++) await finish("read", call)
		expect(branches.currentBranch).toHaveBeenCalledOnce()
		// A shell command can switch branches; the provider is asked again because this one did.
		vi.mocked(branches.currentBranch).mockResolvedValue("other")
		vi.mocked(branches.lookupBranchPullRequest).mockResolvedValue({ branch: "other" })
		await finish("bash", 20)
		await vi.waitFor(() => expect(branches.lookupBranchPullRequest).toHaveBeenCalledTimes(2))
		for (let call = 21; call < 30; call++) await finish("bash", call)
		await new Promise((resolve) => setImmediate(resolve))
		expect(vi.mocked(branches.currentBranch).mock.calls.length).toBeGreaterThan(2)
		expect(branches.lookupBranchPullRequest).toHaveBeenCalledTimes(2)
	})

	it.each([
		"git push -u origin feature",
		"gh pr create --fill",
		"glab mr create --fill",
	])("asks the provider about the branch at once after `%s`", async (command) => {
		const api = await startStandalone()
		await vi.waitFor(() => expect(branches.lookupBranchPullRequest).toHaveBeenCalledOnce())
		// An ordinary shell command on the same branch waits for the five-minute check.
		await api.getHandler("tool_execution_start")(
			{ type: "tool_execution_start", toolCallId: "ls", toolName: "bash", args: { command: "ls" } },
			ctx,
		)
		await api.getHandler("tool_execution_end")(
			{ type: "tool_execution_end", toolCallId: "ls", toolName: "bash", result: {}, isError: false },
			ctx,
		)
		await new Promise((resolve) => setImmediate(resolve))
		expect(branches.lookupBranchPullRequest).toHaveBeenCalledOnce()
		await api.getHandler("tool_execution_start")(
			{ type: "tool_execution_start", toolCallId: "publish", toolName: "bash", args: { command } },
			ctx,
		)
		await api.getHandler("tool_execution_end")(
			{ type: "tool_execution_end", toolCallId: "publish", toolName: "bash", result: {}, isError: false },
			ctx,
		)
		await vi.waitFor(() => expect(branches.lookupBranchPullRequest).toHaveBeenCalledTimes(2))
	})

	it("shows GitLab merge requests without work tracking and keeps their URL separate from text", async () => {
		vi.mocked(branches.lookupBranchPullRequest).mockResolvedValue({ branch: "feature", pullRequest: mr })
		await startStandalone()
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenCalledWith("work-pr", "feature · MR !7 open"))
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("work-pr-url", mr.url)
		expect(existsSync(join(directory, "work-attribution"))).toBe(false)
		expect(supervisor.subscribePullRequestReconciliation).not.toHaveBeenCalled()
	})

	it("names tracked GitLab links in the footer and work details", async () => {
		vi.mocked(branches.lookupBranchPullRequest).mockResolvedValue({ branch: "feature", pullRequest: mr })
		const work = createExtensionApi()
		const status = createExtensionApi()
		createWorkAttributionExtension()(work.api)
		pullRequestStatusExtension({ ...status.api, events: work.api.events })
		await start(work)
		await start(status)
		const update = vi.mocked(supervisor.subscribePullRequestReconciliation).mock.calls[0][0].onPullRequest
		update({ ...contribution(getWorkId(ctx)), pullRequests: [mr] })
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "feature · MR !7 open")
		await work.getRegisteredCommand("work").handler("", textCommandContext())
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining(`MR !7 open: ${mr.url}`), "info")
	})

	it("keeps a branch without a PR quiet and reports auth errors without suggesting an absent command", async () => {
		vi.mocked(branches.lookupBranchPullRequest).mockResolvedValue({ branch: "feature" })
		await startStandalone()
		await vi.waitFor(() => expect(branches.lookupBranchPullRequest).toHaveBeenCalledOnce())
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "feature")
		expect(ctx.ui.notify).not.toHaveBeenCalled()
		vi.mocked(branches.lookupBranchPullRequest).mockRejectedValue(new Error("Run gh auth login"))
		afterBranchRefresh()
		await vi.advanceTimersByTimeAsync(30_000)
		await vi.waitFor(() => expect(ctx.ui.notify).toHaveBeenCalled())
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "feature")
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("gh auth login"), "warning")
		expect(JSON.stringify(vi.mocked(ctx.ui.setStatus).mock.calls)).not.toContain("/work")
		expect(existsSync(join(directory, "work-attribution"))).toBe(false)
	})

	it("clears the previous branch link before waiting for its replacement and never overlaps polls", async () => {
		await startStandalone()
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "feature · PR #7 open"))
		let finish!: (result: branches.BranchPullRequest) => void
		const pending = new Promise<branches.BranchPullRequest>((resolve) => {
			finish = resolve
		})
		vi.mocked(branches.currentBranch).mockResolvedValue("other")
		vi.mocked(branches.lookupBranchPullRequest).mockReturnValue(pending)
		try {
			await vi.advanceTimersByTimeAsync(30_000)
			expect(vi.mocked(ctx.ui.setStatus).mock.calls.slice(-2)).toEqual([
				["work-pr-url", undefined],
				["work-pr", "other"],
			])
			await vi.advanceTimersByTimeAsync(60_000)
			expect(branches.currentBranch).toHaveBeenCalledTimes(2)
			expect(branches.lookupBranchPullRequest).toHaveBeenCalledTimes(2)
		} finally {
			finish({ branch: "other", pullRequest: { ...pr, number: 8, url: "https://github.com/example/repo/pull/8" } })
		}
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "other · PR #8 open"))
	})

	it("cancels a stale repository lookup after the session changes", async () => {
		let finish!: (result: branches.BranchPullRequest) => void
		const pending = new Promise<branches.BranchPullRequest>((resolve) => {
			finish = resolve
		})
		vi.mocked(branches.lookupBranchPullRequest).mockReturnValueOnce(pending)
		const api = await startStandalone()
		await vi.waitFor(() => expect(branches.lookupBranchPullRequest).toHaveBeenCalledOnce())
		const signal = vi.mocked(branches.lookupBranchPullRequest).mock.calls[0][1]
		const second = createContext({ cwd: join(directory, "second"), sessionManager: { getSessionId: () => "second" } })
		vi.mocked(branches.currentBranch).mockResolvedValue("second")
		vi.mocked(branches.lookupBranchPullRequest).mockResolvedValue({
			branch: "second",
			pullRequest: { ...pr, number: 8, url: "https://github.com/example/repo/pull/8" },
		})
		await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "new" }, second)
		expect(signal.aborted).toBe(true)
		finish({ branch: "old", pullRequest: pr })
		await vi.waitFor(() => expect(second.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "second · PR #8 open"))
		expect(second.ui.setStatus).not.toHaveBeenCalledWith("work-pr-url", pr.url)
	})

	it("writes the footer again for each new session even when its value is unchanged", async () => {
		const api = await startStandalone()
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "feature · PR #7 open"))
		vi.mocked(branches.lookupBranchPullRequest).mockResolvedValue({ branch: "feature" })
		const second = createContext({ cwd: join(directory, "second"), sessionManager: { getSessionId: () => "second" } })
		const sessionStart = api.getHandler<SessionStartEvent>("session_start")
		await sessionStart({ type: "session_start", reason: "new" }, second)
		await vi.waitFor(() => expect(branches.lookupBranchPullRequest).toHaveBeenCalledTimes(2))
		await sessionStart({ type: "session_start", reason: "resume" }, ctx)
		// The same branch-only footer must replace the PR left in the resumed session.
		expect(vi.mocked(ctx.ui.setStatus).mock.calls.slice(-2)).toEqual([
			["work-pr-url", undefined],
			["work-pr", "feature"],
		])
	})

	it("aborts and drains a standalone lookup on shutdown", async () => {
		vi.mocked(branches.lookupBranchPullRequest).mockImplementation(async (_cwd, signal) => {
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
			return undefined
		})
		const api = await startStandalone()
		await vi.waitFor(() => expect(branches.lookupBranchPullRequest).toHaveBeenCalledOnce())
		const signal = vi.mocked(branches.lookupBranchPullRequest).mock.calls[0][1]
		await api.getHandler("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx)
		expect(signal.aborted).toBe(true)
		await vi.advanceTimersByTimeAsync(60_000)
		expect(branches.lookupBranchPullRequest).toHaveBeenCalledOnce()
		expect(ctx.ui.notify).not.toHaveBeenCalled()
	})

	it("stops standalone work when attribution activates without applying the old branch result", async () => {
		let finish!: (result: branches.BranchPullRequest) => void
		const pending = new Promise<branches.BranchPullRequest>((resolve) => {
			finish = resolve
		})
		vi.mocked(branches.lookupBranchPullRequest).mockReturnValueOnce(pending)
		const status = await startStandalone()
		await vi.waitFor(() => expect(branches.lookupBranchPullRequest).toHaveBeenCalledOnce())
		const signal = vi.mocked(branches.lookupBranchPullRequest).mock.calls[0][1]
		const work = createExtensionApi()
		createWorkAttributionExtension()({ ...work.api, events: status.api.events })
		await start(work)
		expect(signal.aborted).toBe(true)
		const update = vi.mocked(supervisor.subscribePullRequestReconciliation).mock.calls[0][0].onPullRequest
		update(contribution(getWorkId(ctx)))
		finish({ branch: "other", pullRequest: { ...pr, number: 8 } })
		await pending
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "feature · PR #7 open"))
	})

	it.each(["work-first", "PR-first"])("uses tracked work in either factory order: %s", async (order) => {
		const work = createExtensionApi()
		const status = createExtensionApi()
		const statusApi = { ...status.api, events: work.api.events }
		if (order === "PR-first") pullRequestStatusExtension(statusApi)
		createWorkAttributionExtension()(work.api)
		if (order === "work-first") pullRequestStatusExtension(statusApi)
		for (const api of order === "work-first" ? [work, status] : [status, work]) await start(api)
		await vi.waitFor(() => expect(branches.lookupBranchPullRequest).toHaveBeenCalled())
		expect(supervisor.subscribePullRequestReconciliation).toHaveBeenCalledOnce()
		const update = vi.mocked(supervisor.subscribePullRequestReconciliation).mock.calls[0][0].onPullRequest
		update(contribution(getWorkId(ctx)))
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("work-pr", "feature · PR #7 open")
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("work-pr-url", pr.url)
		const commandCtx = textCommandContext()
		await work.getRegisteredCommand("work").handler("", commandCtx)
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining(pr.url), "info")
		await work.getRegisteredCommand("work").handler("new", commandCtx)
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "feature · PR #7 open")
		const restored = "11111111-1111-4111-8111-111111111111"
		update(contribution(restored))
		setWorkId(ctx, restored, work.api)
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "feature · PR #7 open")
	})
})

describe("branch PR for tracked work without commits", () => {
	async function startTracked() {
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		const status = createExtensionApi()
		pullRequestStatusExtension({ ...status.api, events: api.api.events })
		await start(api)
		await start(status)
		return vi.mocked(supervisor.subscribePullRequestReconciliation).mock.calls[0][0]?.onPullRequest
	}

	it("shows the branch PR and asks the provider again only after a branch change or five minutes", async () => {
		vi.mocked(branches.currentBranch).mockResolvedValue("feature")
		await startTracked()
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "feature · PR #7 open"))
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("work-pr-url", pr.url)
		await vi.advanceTimersByTimeAsync(4 * 60_000)
		expect(branches.lookupBranchPullRequest).toHaveBeenCalledTimes(1)
		const now = Date.now()
		vi.spyOn(Date, "now").mockReturnValue(now + 5 * 60_000)
		await vi.advanceTimersByTimeAsync(30_000)
		await vi.waitFor(() => expect(branches.lookupBranchPullRequest).toHaveBeenCalledTimes(2))
		vi.mocked(branches.currentBranch).mockResolvedValue("other")
		vi.mocked(branches.lookupBranchPullRequest).mockResolvedValue({ branch: "other", pullRequest: undefined })
		await vi.advanceTimersByTimeAsync(30_000)
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "other"))
		expect(branches.lookupBranchPullRequest).toHaveBeenCalledTimes(3)
	})

	it("keeps checking the current branch after work records a commit", async () => {
		vi.mocked(branches.currentBranch).mockResolvedValue("feature")
		const update = await startTracked()
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "feature · PR #7 open"))
		update?.({
			workId: getWorkId(ctx),
			sessionId: ctx.sessionManager.getSessionId(),
			cwd: directory,
			repository: join(directory, ".git"),
			worktree: directory,
			sha: "b".repeat(40),
			pullRequests: [],
		})
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "feature · PR #7 open")
		vi.spyOn(Date, "now").mockReturnValue(Date.now() + 10 * 60_000)
		await vi.advanceTimersByTimeAsync(60_000)
		expect(branches.lookupBranchPullRequest).toHaveBeenCalledTimes(2)
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "feature · PR #7 open")
	})

	it("stays quiet when the branch lookup fails", async () => {
		vi.mocked(branches.currentBranch).mockResolvedValue("feature")
		vi.mocked(branches.lookupBranchPullRequest).mockRejectedValue(new LookupError("GitHub authentication failed."))
		await startTracked()
		await vi.waitFor(() => expect(branches.lookupBranchPullRequest).toHaveBeenCalledTimes(1))
		await Promise.resolve()
		expect(ctx.ui.notify).not.toHaveBeenCalled()
		expect(ctx.ui.setStatus).not.toHaveBeenCalledWith("work-pr", expect.stringContaining("Branch"))
	})
})

describe("PR status with the real reconciliation supervisor", () => {
	it("does not rewrite the footer for other works' updates or an unchanged status", async () => {
		const actual = await vi.importActual<typeof supervisor>("../work-attribution/reconcile-supervisor.js")
		const delivered: discovery.WorkPullRequestUpdate[] = []
		vi.mocked(supervisor.subscribePullRequestReconciliation).mockImplementationOnce((subscriber) =>
			actual.subscribePullRequestReconciliation({
				...subscriber,
				onPullRequest: (update) => {
					delivered.push(update)
					subscriber.onPullRequest(update)
				},
			}),
		)
		const work = createExtensionApi()
		createWorkAttributionExtension()(work.api)
		const status = createExtensionApi()
		pullRequestStatusExtension({ ...status.api, events: work.api.events })
		await start(work)
		// Merged links are settled, so no pass asks the provider; every tick still delivers every commit.
		const otherWorks = [randomUUID(), randomUUID(), randomUUID()]
		const rows = Array.from({ length: 101 }, (_, index) => {
			const sha = (index + 1).toString(16).padStart(40, "0")
			const url = `https://github.com/example/repo/pull/${index + 1}`
			return {
				...contribution(index ? otherWorks[index % otherWorks.length] : getWorkId(ctx)),
				version: 1,
				type: "commit",
				sessionId: "history",
				sha,
				recordedAt: pr.checkedAt,
				pullRequests: [
					{
						...pr,
						url,
						id: String(index + 1),
						repositoryId: "17",
						number: index + 1,
						state: "merged",
						headSha: sha,
						mergeCommitSha: sha,
						mergedAt: pr.checkedAt,
					},
				],
			}
		})
		mkdirSync(join(directory, "work-attribution"), { recursive: true })
		writeFileSync(
			join(directory, "work-attribution", "history.jsonl"),
			`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
		)
		// Each tick delivers all 101 commits, and so does the lease owner's pass it starts. A reconciliation that
		// work tracking requests at startup can add one more pass, so wait for at least these and an idle scan.
		// A loaded CI runner can take several seconds per pass over the 101-row journal.
		const pass = async (deliveries: number) => {
			await vi.waitFor(() => expect(delivered.length).toBeGreaterThanOrEqual(deliveries), { timeout: 25_000 })
			await vi.waitFor(async () => expect(await check(join(directory, "work-attribution"))).toBe(false), {
				timeout: 25_000,
			})
		}
		await start(status)
		await pass(2 * rows.length)
		// Journal replay must not replace the current branch's PR with a historical commit association.
		const calls = vi.mocked(ctx.ui.setStatus).mock.calls
		await vi.waitFor(
			() =>
				expect(calls.slice(-2)).toEqual([
					["work-pr-url", pr.url],
					["work-pr", "feature · PR #7 open"],
				]),
			{ timeout: 25_000 },
		)
		expect(calls.slice(-2)).toEqual([
			["work-pr-url", pr.url],
			["work-pr", "feature · PR #7 open"],
		])
		expect(calls.every(([, value]) => [undefined, "feature", pr.url, "feature · PR #7 open"].includes(value))).toBe(
			true,
		)
		const written = calls.length
		const seen = delivered.length
		await vi.advanceTimersByTimeAsync(30_000)
		await pass(seen + rows.length)
		expect(ctx.ui.setStatus).toHaveBeenCalledTimes(written)
	}, 110_000)
})

describe("expected lookup failures", () => {
	it("keeps the branch footer steady and silent through outages and hides it without a supported remote", async () => {
		await startStandalone()
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "feature · PR #7 open"))
		for (const message of [
			"GitHub lookup failed. Check network and repository access.",
			"GitHub lookup failed (HTTP 503).",
		]) {
			vi.mocked(branches.lookupBranchPullRequest).mockRejectedValueOnce(new LookupError(message, "retry"))
			afterBranchRefresh()
			await vi.advanceTimersByTimeAsync(30_000)
		}
		await vi.waitFor(() => expect(branches.lookupBranchPullRequest).toHaveBeenCalledTimes(3))
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "feature · PR #7 open")
		vi.mocked(branches.lookupBranchPullRequest).mockRejectedValue(
			new LookupError("This repository has no supported GitHub or GitLab remote.", "unsupported"),
		)
		afterBranchRefresh()
		await vi.advanceTimersByTimeAsync(30_000)
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "feature"))
		expect(ctx.ui.notify).not.toHaveBeenCalled()
	})
	it("waits through retryable work lookups, ignores unsupported repositories and still lists both in /work", async () => {
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		const status = createExtensionApi()
		pullRequestStatusExtension({ ...status.api, events: api.api.events })
		await start(api)
		await start(status)
		const update = vi.mocked(supervisor.subscribePullRequestReconciliation).mock.calls[0][0]?.onPullRequest
		const commit = { ...contribution(getWorkId(ctx)), pullRequests: [] }
		const checkedAt = new Date().toISOString()
		update?.({
			...commit,
			sha: "b".repeat(40),
			repository: join(directory, "bitbucket.git"),
			prLookup: { status: "error", checkedAt, error: "No supported remote.", reason: "unsupported" },
		})
		await Promise.resolve()
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "feature · PR #7 open")
		update?.({ ...commit, prLookup: { status: "error", checkedAt, error: "GitHub is offline.", reason: "retry" } })
		await Promise.resolve()
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "feature · PR #7 open")
		expect(ctx.ui.notify).not.toHaveBeenCalled()
		await api.getRegisteredCommand("work").handler("", textCommandContext())
		const shown = vi.mocked(ctx.ui.notify).mock.calls.at(-1)?.[0]
		expect(shown).toContain("PR/MR lookup: 1 commit waiting")
		expect(shown).toContain("PR/MR lookup: GitHub is offline.")
		expect(shown).toContain("PR/MR lookup: No supported remote.")
	})
	it("stops counting a commit as waiting or failing once discovery stops checking it", async () => {
		const api = createExtensionApi()
		createWorkAttributionExtension()(api.api)
		const status = createExtensionApi()
		pullRequestStatusExtension({ ...status.api, events: api.api.events })
		await start(api)
		await start(status)
		const update = vi.mocked(supervisor.subscribePullRequestReconciliation).mock.calls[0][0].onPullRequest
		const commit = { ...contribution(getWorkId(ctx)), pullRequests: [] }
		const checkedAt = new Date().toISOString()
		const recordedAt = new Date(Date.now() - 33 * 24 * 60 * 60 * 1000).toISOString()
		// Discovery stopped checking both after 32 days, so the footer neither asks for action nor waits.
		update({
			...commit,
			sha: "c".repeat(40),
			recordedAt,
			prLookup: { status: "error", checkedAt, error: "GitHub could not find this repository." },
		})
		await Promise.resolve()
		expect(ctx.ui.setStatus).not.toHaveBeenCalledWith("work-pr", "PR/MR check /work")
		update({ ...commit, recordedAt, prLookup: { status: "pending", checkedAt } })
		expect(ctx.ui.setStatus).not.toHaveBeenCalledWith("work-pr", "PR/MR waiting")
		expect(ctx.ui.notify).not.toHaveBeenCalled()
		await api.getRegisteredCommand("work").handler("", textCommandContext())
		const shown = vi.mocked(ctx.ui.notify).mock.calls.at(-1)?.[0]
		expect(shown).toContain("PR/MR lookup: 2 commits without a PR after 32 days, no longer checked")
		// Later PRs add other /work lines, such as costs still waiting for billing; only lookup lines matter here.
		expect(shown).not.toMatch(/PR\/MR lookup: \d+ commits? waiting/)
		expect(shown).not.toContain("could not find")
		// A newer commit of the same work still waits.
		update({ ...commit, sha: "d".repeat(40), prLookup: { status: "pending", checkedAt } })
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "feature · PR #7 open")
	})
})
