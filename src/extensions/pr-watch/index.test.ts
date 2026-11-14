import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getParsedCliArgs } from "../../cli-args.js"
import { isAcpSessionHost } from "../../modes/acp/state.js"
import { createCommandContext, createToolContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { lookupBranchPullRequest } from "../pull-request-status/branch-status.js"
import type { WorkPullRequest } from "../pull-request-status/pull-requests.js"
import prWatchExtension, { getPRWatcher } from "./index.js"
import { discoverMyOpenPRs, readPRSnapshot } from "./providers.js"
import { setPRMonitoringPermitted } from "./session-policy.js"
import { readPRWatchPreference, writePRWatchPreference } from "./settings.js"
import type { PRSnapshot, PRWatchState } from "./types.js"

vi.mock("./providers.js", async (original) => ({
	...(await original()),
	readPRSnapshot: vi.fn(),
	discoverMyOpenPRs: vi.fn(),
}))
vi.mock("./checkout.js", () => ({ checkoutProblem: vi.fn(async () => null), acquirePRLease: vi.fn() }))
vi.mock("./settings.js", () => ({ readPRWatchPreference: vi.fn(), writePRWatchPreference: vi.fn() }))
vi.mock("../pull-request-status/branch-status.js", () => ({ lookupBranchPullRequest: vi.fn() }))
vi.mock("../../cli-args.js", async (original) => ({ ...(await original()), getParsedCliArgs: vi.fn() }))
vi.mock("../../modes/acp/state.js", async (original) => ({ ...(await original()), isAcpSessionHost: vi.fn() }))

const url = "https://github.com/example/repo/pull/7"
const snapshot: PRSnapshot = {
	provider: "github",
	repository: "example/repo",
	number: 7,
	title: "Parser fix",
	url,
	branch: "feature",
	headSha: "a".repeat(40),
	state: "open",
	checks: [],
	feedback: [],
}

describe("PR watch extension", () => {
	let extension: ReturnType<typeof createExtensionApi>
	let ctx: ReturnType<typeof createCommandContext>
	const run = (args: string) => extension.getRegisteredCommand("pr-watch").handler(args, ctx)
	const tool = (args: Record<string, unknown>, session = ctx) =>
		extension
			.getRegisteredTool("pr_watch")
			.execute("call", args, undefined, undefined, { ...createToolContext(), ...session }) as Promise<{
			details: { state: PRWatchState }
		}>
	const watcher = () => getPRWatcher(ctx.sessionManager)
	const sendUserMessage = vi.fn()
	beforeEach(async () => {
		vi.resetAllMocks()
		vi.mocked(writePRWatchPreference).mockImplementation((enabled) =>
			vi.mocked(readPRWatchPreference).mockReturnValue(enabled),
		)
		vi.mocked(getParsedCliArgs).mockReturnValue({ options: {}, positionals: [] })
		vi.mocked(readPRSnapshot).mockResolvedValue(snapshot)
		vi.mocked(lookupBranchPullRequest).mockResolvedValue({
			branch: "feature",
			pullRequest: { url, state: "open" } as WorkPullRequest,
		})
		extension = createExtensionApi()
		extension.api.sendUserMessage = sendUserMessage
		ctx = createCommandContext()
		ctx.isProjectTrusted = vi.fn(() => true)
		ctx.isIdle = vi.fn(() => true)
		prWatchExtension(extension.api)
		await extension.emit("session_start", {}, ctx)
	})
	afterEach(async () => {
		await extension.emit("session_shutdown", {}, ctx)
	})

	it("registers nothing for an ACP client that did not opt in", () => {
		vi.mocked(isAcpSessionHost).mockReturnValue(true)
		setPRMonitoringPermitted(false)
		const blocked = createExtensionApi()
		prWatchExtension(blocked.api)
		expect(blocked.registerTool).not.toHaveBeenCalled()
		expect(blocked.registerCommand).not.toHaveBeenCalled()
		expect(blocked.getHandlers("session_start")).toEqual([])
	})

	it("reports status and stops without starting a model turn", async () => {
		await run("status")
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("PR watch · Not watching"), "info")
		await run("watch")
		expect(watcher()?.snapshot.targets[0]).toMatchObject({ url, autoFix: false })
		expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("pr-watch", expect.any(Function), { placement: "aboveEditor" })
		await run("stop")
		expect(watcher()?.snapshot.targets[0].enabled).toBe(false)
		expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("pr-watch", undefined, { placement: "aboveEditor" })
		expect(extension.sendMessage).not.toHaveBeenCalled()
		expect(sendUserMessage).not.toHaveBeenCalled()
	})

	it("saves the general choice, keeps provider failures visible, and stops even if saving fails", async () => {
		vi.mocked(lookupBranchPullRequest).mockRejectedValueOnce(new Error("GitHub login expired"))
		await run("enable")
		expect(writePRWatchPreference).toHaveBeenLastCalledWith(true)
		expect(ctx.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("GitHub login expired"), "info")
		await run("watch")
		vi.mocked(writePRWatchPreference).mockImplementation(() => {
			throw new Error("Cannot write preference")
		})
		await run("disable")
		expect(watcher()?.snapshot.targets[0].enabled).toBe(false)
		expect(ctx.ui.notify).toHaveBeenLastCalledWith("Cannot write preference", "error")
	})

	it("hands requests that need checkouts to the model", async () => {
		await run("mine gitlab git.company.test")
		await run(`${url} https://github.com/example/repo/pull/8`)
		expect(sendUserMessage.mock.calls.map(([text]) => text)).toEqual([
			'Watch my open GitLab MRs and fix CI failures locally using pr_watch with allMine=true, provider=gitlab, mode=ci and host="git.company.test".',
			`Watch these PRs and fix CI failures locally using pr_watch with mode=ci: ${JSON.stringify([url, "https://github.com/example/repo/pull/8"])}`,
		])
	})

	it("explains a branch without a PR", async () => {
		vi.mocked(lookupBranchPullRequest).mockResolvedValue({ branch: "feature" })
		await run("only fix lint")
		expect(ctx.ui.notify).toHaveBeenLastCalledWith("Open a pull request for this branch before watching it.", "error")
		expect(watcher()?.snapshot.targets).toEqual([])
	})

	it("the tool starts CI fixes by default, watches only on request and finds no PRs gracefully", async () => {
		expect((await tool({ url, autoFix: false })).details.state.targets[0]).toMatchObject({ autoFix: false, mode: "ci" })
		expect((await tool({ url, mode: "all" })).details.state.targets[0]).toMatchObject({ autoFix: true, mode: "all" })
		await tool({ action: "pause" })
		expect((await tool({ url })).details.state.targets[0]).toMatchObject({ autoFix: true, mode: "ci" })
		expect((await tool({ action: "stop", url })).details.state.targets[0].enabled).toBe(false)
		vi.mocked(discoverMyOpenPRs).mockResolvedValue([])
		expect((await tool({ allMine: true })).details.state.message).toBe("No open PRs or MRs found for your account.")
	})

	it("refuses a tool call from a session without a watcher", async () => {
		const other = createCommandContext()
		await expect(tool({ url }, other)).rejects.toThrow("unavailable")
	})
})
