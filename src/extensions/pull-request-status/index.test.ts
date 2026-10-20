import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ExtensionContext, SessionStartEvent } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import * as branches from "./branch-status.js"
import pullRequestStatusExtension from "./index.js"
import { LookupError, type PullRequestLink } from "./provider-records.js"

vi.mock("./branch-status.js", () => ({
	currentBranch: vi.fn(),
	lookupBranchPullRequest: vi.fn(),
}))

let directory: string
let ctx: ExtensionContext
const pr: PullRequestLink = {
	provider: "github",
	url: "https://github.com/example/repo/pull/7",
	number: 7,
	state: "open",
	repository: "example/repo",
}
const mr: PullRequestLink = {
	provider: "gitlab",
	url: "https://gitlab.com/example/team/repo/-/merge_requests/7",
	number: 7,
	state: "open",
	repository: "example/team/repo",
}
const shutdowns: (() => Promise<unknown>)[] = []
/** The footer shows the PR of the checked-out branch. */
async function startFooter(): Promise<ReturnType<typeof createExtensionApi>> {
	vi.mocked(branches.currentBranch).mockResolvedValue("feature")
	const api = createExtensionApi()
	pullRequestStatusExtension(api.api)
	for (const handler of api.getHandlers<SessionStartEvent>("session_start"))
		await handler({ type: "session_start", reason: "new" }, ctx)
	shutdowns.push(async () => {
		for (const handler of api.getHandlers("session_shutdown"))
			await handler({ type: "session_shutdown", reason: "quit" }, ctx)
	})
	return api
}
/** Only setInterval is faked; the branch refresh interval compares Date.now(). */
function afterBranchRefresh(): void {
	vi.spyOn(Date, "now").mockReturnValue(Date.now() + 5 * 60_000)
}
beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "kimchi-pr-status-"))
	ctx = createContext({ cwd: directory })
	vi.mocked(branches.currentBranch).mockResolvedValue(undefined)
	vi.mocked(branches.lookupBranchPullRequest).mockResolvedValue({ branch: "feature", pullRequest: pr })
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] })
})
afterEach(async () => {
	for (const shutdown of shutdowns.splice(0).reverse()) await shutdown()
	vi.useRealTimers()
	vi.clearAllMocks()
	vi.restoreAllMocks()
	rmSync(directory, { recursive: true, force: true })
})

describe("branch PR footer", () => {
	it("shows the current branch's PR with its link and checks the branch every 30 seconds", async () => {
		await startFooter()
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenCalledWith("work-pr", "PR #7 open"))
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("work-pr-url", pr.url)
		await vi.advanceTimersByTimeAsync(30_000)
		expect(branches.currentBranch).toHaveBeenCalledTimes(2)
	})

	it("asks the provider about the branch again only after a branch change or five minutes", async () => {
		await startFooter()
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "PR #7 open"))
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
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", undefined))
		expect(branches.lookupBranchPullRequest).toHaveBeenCalledTimes(3)
	})

	it("checks the branch after shell commands at most once per interval", async () => {
		const api = await startFooter()
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
		await finish("bash", 20)
		await vi.waitFor(() => expect(branches.lookupBranchPullRequest).toHaveBeenCalledTimes(2))
		for (let call = 21; call < 30; call++) await finish("bash", call)
		await new Promise((resolve) => setImmediate(resolve))
		expect(branches.currentBranch).toHaveBeenCalledTimes(2)
		expect(branches.lookupBranchPullRequest).toHaveBeenCalledTimes(2)
	})

	it.each([
		"git push -u origin feature",
		"gh pr create --fill",
		"glab mr create --fill",
	])("asks the provider about the branch at once after `%s`", async (command) => {
		const api = await startFooter()
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

	it("shows GitLab merge requests and keeps their URL separate from the text", async () => {
		vi.mocked(branches.lookupBranchPullRequest).mockResolvedValue({ branch: "feature", pullRequest: mr })
		await startFooter()
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenCalledWith("work-pr", "MR !7 open"))
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("work-pr-url", mr.url)
	})

	it("keeps a branch without a PR quiet and reports auth errors once", async () => {
		vi.mocked(branches.lookupBranchPullRequest).mockResolvedValue({ branch: "feature" })
		await startFooter()
		await vi.waitFor(() => expect(branches.lookupBranchPullRequest).toHaveBeenCalledOnce())
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", undefined)
		expect(ctx.ui.notify).not.toHaveBeenCalled()
		vi.mocked(branches.lookupBranchPullRequest).mockRejectedValue(new Error("Run gh auth login"))
		for (let check = 0; check < 2; check++) {
			afterBranchRefresh()
			await vi.advanceTimersByTimeAsync(30_000)
		}
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "PR/MR unavailable"))
		expect(vi.mocked(ctx.ui.notify).mock.calls).toEqual([
			[expect.stringContaining("PR/MR lookup unavailable: Run gh auth login"), "warning"],
		])
	})

	it("keeps the footer steady and silent through outages and hides it without a supported remote", async () => {
		await startFooter()
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "PR #7 open"))
		for (const message of [
			"GitHub lookup failed. Check network and repository access.",
			"GitHub lookup failed (HTTP 503).",
		]) {
			vi.mocked(branches.lookupBranchPullRequest).mockRejectedValueOnce(new LookupError(message, "retry"))
			afterBranchRefresh()
			await vi.advanceTimersByTimeAsync(30_000)
		}
		await vi.waitFor(() => expect(branches.lookupBranchPullRequest).toHaveBeenCalledTimes(3))
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "PR #7 open")
		vi.mocked(branches.lookupBranchPullRequest).mockRejectedValue(
			new LookupError("This repository has no supported GitHub or GitLab remote.", "unsupported"),
		)
		afterBranchRefresh()
		await vi.advanceTimersByTimeAsync(30_000)
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", undefined))
		expect(ctx.ui.notify).not.toHaveBeenCalled()
	})

	it("clears the previous branch link before waiting for its replacement and never overlaps polls", async () => {
		await startFooter()
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "PR #7 open"))
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
				["work-pr", undefined],
			])
			await vi.advanceTimersByTimeAsync(60_000)
			expect(branches.currentBranch).toHaveBeenCalledTimes(2)
			expect(branches.lookupBranchPullRequest).toHaveBeenCalledTimes(2)
		} finally {
			finish({ branch: "other", pullRequest: { ...pr, number: 8, url: "https://github.com/example/repo/pull/8" } })
		}
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "PR #8 open"))
	})

	it("cancels a stale repository lookup after the session changes", async () => {
		let finish!: (result: branches.BranchPullRequest) => void
		const pending = new Promise<branches.BranchPullRequest>((resolve) => {
			finish = resolve
		})
		vi.mocked(branches.lookupBranchPullRequest).mockReturnValueOnce(pending)
		const api = await startFooter()
		await vi.waitFor(() => expect(branches.lookupBranchPullRequest).toHaveBeenCalledOnce())
		const signal = vi.mocked(branches.lookupBranchPullRequest).mock.calls[0][1]
		const second = createContext({ cwd: join(directory, "second"), sessionManager: { getSessionId: () => "second" } })
		vi.mocked(branches.lookupBranchPullRequest).mockResolvedValue({
			branch: "second",
			pullRequest: { ...pr, number: 8, url: "https://github.com/example/repo/pull/8" },
		})
		await api.getHandler<SessionStartEvent>("session_start")({ type: "session_start", reason: "new" }, second)
		expect(signal.aborted).toBe(true)
		finish({ branch: "old", pullRequest: pr })
		await vi.waitFor(() => expect(second.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "PR #8 open"))
		expect(second.ui.setStatus).not.toHaveBeenCalledWith("work-pr-url", pr.url)
	})

	it("writes the footer again for each new session even when its value is unchanged", async () => {
		const api = await startFooter()
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "PR #7 open"))
		vi.mocked(branches.lookupBranchPullRequest).mockResolvedValue({ branch: "feature" })
		const second = createContext({ cwd: join(directory, "second"), sessionManager: { getSessionId: () => "second" } })
		const sessionStart = api.getHandler<SessionStartEvent>("session_start")
		await sessionStart({ type: "session_start", reason: "new" }, second)
		await vi.waitFor(() => expect(branches.lookupBranchPullRequest).toHaveBeenCalledTimes(2))
		await sessionStart({ type: "session_start", reason: "resume" }, ctx)
		// The empty footer matches the last value written to the second session, but this one still shows PR #7.
		expect(vi.mocked(ctx.ui.setStatus).mock.calls.slice(-2)).toEqual([
			["work-pr-url", undefined],
			["work-pr", undefined],
		])
	})

	it("aborts and drains a lookup on shutdown", async () => {
		vi.mocked(branches.lookupBranchPullRequest).mockImplementation(async (_cwd, signal) => {
			await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
			return undefined
		})
		const api = await startFooter()
		await vi.waitFor(() => expect(branches.lookupBranchPullRequest).toHaveBeenCalledOnce())
		const signal = vi.mocked(branches.lookupBranchPullRequest).mock.calls[0][1]
		await api.getHandler("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx)
		expect(signal.aborted).toBe(true)
		await vi.advanceTimersByTimeAsync(60_000)
		expect(branches.lookupBranchPullRequest).toHaveBeenCalledOnce()
		expect(ctx.ui.notify).not.toHaveBeenCalled()
	})

	it("clears the footer when the session ends", async () => {
		const api = await startFooter()
		await vi.waitFor(() => expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("work-pr", "PR #7 open"))
		await api.getHandler("session_shutdown")({ type: "session_shutdown", reason: "quit" }, ctx)
		expect(vi.mocked(ctx.ui.setStatus).mock.calls.slice(-2)).toEqual([
			["work-pr-url", undefined],
			["work-pr", undefined],
		])
	})
})
