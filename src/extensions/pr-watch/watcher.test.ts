import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resolvePreMainProjectTrust } from "../../project-trust.js"
import { createContext, createToolContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { getPermissionMode } from "../permissions/mode-controller.js"
import { lookupBranchPullRequest } from "../pull-request-status/branch-status.js"
import type { WorkPullRequest } from "../pull-request-status/pull-requests.js"
import { acquirePRLease, checkoutProblem, preparePRCheckout } from "./checkout.js"
import { readPRSnapshot } from "./providers.js"
import { readPRWatchPreference } from "./settings.js"
import type { PRFeedback, PRSnapshot } from "./types.js"
import { PLAN_MODE_MESSAGE, PRWatcher } from "./watcher.js"

vi.mock("./providers.js", async (original) => ({ ...(await original()), readPRSnapshot: vi.fn() }))
vi.mock("./checkout.js", () => ({ checkoutProblem: vi.fn(), acquirePRLease: vi.fn(), preparePRCheckout: vi.fn() }))
vi.mock("./settings.js", () => ({ readPRWatchPreference: vi.fn() }))
vi.mock("../permissions/mode-controller.js", () => ({ getPermissionMode: vi.fn() }))
vi.mock("../pull-request-status/branch-status.js", () => ({ lookupBranchPullRequest: vi.fn() }))
vi.mock("../../project-trust.js", () => ({ resolvePreMainProjectTrust: vi.fn() }))
vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => {}) }))

const head = "a".repeat(40)
const URL7 = "https://github.com/owner/repo/pull/7"
const URL8 = "https://github.com/owner/repo/pull/8"
const HERE = "/work/repo"
const pr = (overrides: Partial<PRSnapshot> = {}): PRSnapshot => ({
	provider: "github",
	repository: "owner/repo",
	number: 7,
	title: "Parser fix",
	url: URL7,
	branch: "fix/parser",
	headSha: head,
	state: "open",
	checks: [{ id: "check:1", name: "Tests", state: "failed", url: null, summary: "Assertion failed" }],
	feedback: [],
	...overrides,
})
const review = (trusted: boolean): PRFeedback => ({
	id: "review:1",
	author: "owner",
	body: "REVIEW_TEXT",
	path: null,
	line: null,
	url: URL7,
	trusted,
})

describe("PR watcher", () => {
	const watchers: PRWatcher[] = []
	const release = vi.fn(async () => {})
	beforeEach(() => {
		vi.resetAllMocks()
		vi.mocked(readPRSnapshot).mockImplementation(async (url) => pr(url === URL8 ? { url, number: 8 } : {}))
		vi.mocked(checkoutProblem).mockResolvedValue(null)
		vi.mocked(acquirePRLease).mockResolvedValue(release)
		vi.mocked(resolvePreMainProjectTrust).mockReturnValue(true)
		vi.mocked(preparePRCheckout).mockImplementation(async (_ctx, url) => `/checkouts/${url.at(-1)}`)
	})
	afterEach(async () => {
		await Promise.all(watchers.splice(0).map((watcher) => watcher.dispose()))
	})
	function setup(entries: unknown[] = []) {
		const extension = createExtensionApi()
		const ctx = createContext({
			cwd: HERE,
			isIdle: vi.fn(() => true),
			isProjectTrusted: vi.fn(() => true),
			abort: vi.fn(),
			sessionManager: { getEntries: vi.fn(() => entries as never) },
		})
		const watcher = new PRWatcher(extension.api, ctx)
		watchers.push(watcher)
		const watchHere = (autoFix = true, mode?: "ci" | "reviews" | "all") =>
			watcher.add([{ url: URL7, cwd: HERE }], { autoFix, mode })
		return { watcher, ctx, extension, watchHere, repairs: () => extension.sendMessage.mock.calls.map(([m]) => m) }
	}

	it("watches without inference until fixes are granted, then repairs once", async () => {
		const { watcher, watchHere, repairs } = setup()
		expect((await watchHere(false)).targets[0]).toMatchObject({
			enabled: true,
			autoFix: false,
			pullRequest: { number: 7 },
		})
		expect(repairs()).toEqual([])
		await watchHere()
		expect(watcher.snapshot.targets[0].phase).toBe("fixing")
		expect(repairs()).toEqual([expect.objectContaining({ customType: "pr_autofix" })])
		expect(repairs()[0].content).toContain(`Work only in the checkout at "${HERE}"`)
		await watcher.refresh()
		expect(repairs()).toHaveLength(1)
	})

	it("waits for an idle agent with no queued input", async () => {
		const { watcher, ctx, watchHere, repairs } = setup()
		vi.mocked(ctx.isIdle).mockReturnValue(false)
		await watchHere()
		vi.mocked(ctx.isIdle).mockReturnValue(true)
		vi.mocked(ctx.hasPendingMessages).mockReturnValue(true)
		await watcher.refresh()
		expect(repairs()).toEqual([])
		vi.mocked(ctx.hasPendingMessages).mockReturnValue(false)
		await watcher.settled(false)
		expect(repairs()).toHaveLength(1)
	})

	it("fixes CI only by default and keeps review text out of the repair", async () => {
		vi.mocked(readPRSnapshot).mockResolvedValue(pr({ checks: [], feedback: [review(true)] }))
		const { watcher, watchHere, repairs } = setup()
		await watchHere()
		expect(repairs()).toEqual([])
		vi.mocked(readPRSnapshot).mockResolvedValue(pr({ feedback: [review(true)] }))
		await watcher.refresh()
		expect(repairs()[0].content).toContain("CI failures only")
		expect(repairs()[0].content).not.toContain("REVIEW_TEXT")
	})

	it("fixes only trusted review feedback in reviews mode", async () => {
		vi.mocked(readPRSnapshot).mockResolvedValue(pr({ feedback: [review(false)] }))
		const { watcher, watchHere, repairs } = setup()
		await watchHere(true, "reviews")
		expect(watcher.snapshot.targets[0].pullRequest?.feedback).toHaveLength(1)
		expect(repairs()).toEqual([])
		vi.mocked(readPRSnapshot).mockResolvedValue(pr({ feedback: [review(true)] }))
		await watcher.refresh()
		expect(repairs()[0].content).toContain("<review-feedback>\nREVIEW_TEXT\n</review-feedback>")
		expect(repairs()[0].content).not.toContain("Assertion failed")
	})

	it("refuses fixes in an untrusted checkout and waits on a dirty one", async () => {
		const { watcher, ctx, watchHere, repairs } = setup()
		vi.mocked(ctx.isProjectTrusted).mockReturnValue(false)
		expect((await watchHere()).message).toContain("Trust this project before enabling auto-fix.")
		expect(watcher.snapshot.targets).toEqual([])
		vi.mocked(ctx.isProjectTrusted).mockReturnValue(true)
		vi.mocked(checkoutProblem).mockResolvedValue("Commit or stash local changes before auto-fixing this PR.")
		expect((await watchHere()).targets[0]).toMatchObject({
			phase: "attention",
			message: expect.stringContaining("stash"),
		})
		expect(repairs()).toEqual([])
	})

	it("leaves the PR to another session's lease and releases its own on a failed recheck", async () => {
		vi.mocked(acquirePRLease).mockRejectedValueOnce(new Error("locked"))
		const { watcher, watchHere, repairs } = setup()
		expect((await watchHere()).targets[0].message).toContain("Another session is fixing this PR")
		vi.mocked(checkoutProblem).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("Git unavailable"))
		await watcher.refresh()
		expect(watcher.snapshot.targets[0]).toMatchObject({ phase: "error", message: "Git unavailable" })
		expect(release).toHaveBeenCalledOnce()
		expect(repairs()).toEqual([])
	})

	it("tracks in Plan mode but repairs only after leaving it", async () => {
		vi.mocked(getPermissionMode).mockReturnValue({ mode: "plan", source: "runtime", initiatedBy: "user" })
		const { watcher, watchHere, repairs } = setup()
		expect((await watchHere()).targets[0].message).toBe(PLAN_MODE_MESSAGE)
		expect(repairs()).toEqual([])
		vi.mocked(getPermissionMode).mockReturnValue({ mode: "auto", source: "runtime", initiatedBy: "user" })
		await watcher.refresh()
		expect(repairs()).toHaveLength(1)
	})

	it("holds the lease until a delayed push shows, then marks the failures handled", async () => {
		const { watcher, watchHere, repairs } = setup()
		await watchHere()
		vi.mocked(readPRSnapshot)
			.mockImplementationOnce(async () => {
				expect(release).not.toHaveBeenCalled()
				return pr()
			})
			.mockResolvedValue(pr({ headSha: "b".repeat(40), checks: [] }))
		await watcher.settled(false)
		expect(watcher.snapshot.targets[0]).toMatchObject({ phase: "watching", autoFix: true })
		expect(release).toHaveBeenCalledOnce()
		expect(repairs()).toHaveLength(1)
	})

	it.each([
		["no new commit", undefined, "No new PR commit was detected"],
		["a failed check", new Error("GitHub login expired"), "Could not verify the pushed commit: GitHub login expired"],
	])("pauses fixes after %s and resumes when granted again", async (_case, failure, message) => {
		const { watcher, watchHere, repairs } = setup()
		await watchHere()
		if (failure) vi.mocked(readPRSnapshot).mockRejectedValue(failure)
		await watcher.settled(false)
		expect(watcher.snapshot.targets[0]).toMatchObject({ autoFix: false, phase: "attention" })
		expect(watcher.snapshot.targets[0].message).toContain(message)
		vi.mocked(readPRSnapshot).mockResolvedValue(pr())
		await watcher.refresh()
		expect(repairs()).toHaveLength(1)
		await watchHere()
		expect(repairs()).toHaveLength(2)
	})

	it("pauses after a cancelled repair", async () => {
		const { watcher, watchHere, repairs } = setup()
		await watchHere()
		await watcher.settled(true)
		await watcher.refresh()
		expect(watcher.snapshot.targets[0]).toMatchObject({ autoFix: false, message: expect.stringContaining("cancelled") })
		expect(repairs()).toHaveLength(1)
		expect(release).toHaveBeenCalledOnce()
	})

	it("stops after three attempts until granted again", async () => {
		const { watcher, watchHere, repairs } = setup()
		await watchHere()
		for (const char of ["b", "c", "d"]) {
			vi.mocked(readPRSnapshot).mockResolvedValue(pr({ headSha: char.repeat(40) }))
			await watcher.settled(false)
		}
		expect(repairs()).toHaveLength(3)
		expect(watcher.snapshot.targets[0]).toMatchObject({
			autoFix: false,
			message: expect.stringContaining("3 attempts"),
		})
		await watchHere()
		expect(repairs()).toHaveLength(4)
	})

	it("pausing cancels the running repair and keeps watching", async () => {
		const { watcher, ctx, watchHere, repairs } = setup()
		await watchHere()
		await watcher.pause()
		expect(ctx.abort).toHaveBeenCalledOnce()
		expect(watcher.snapshot.targets[0]).toMatchObject({ enabled: true, autoFix: false })
		await watcher.settled(true)
		expect(repairs()).toHaveLength(1)
	})

	it("stopping cancels the repair and polls nothing more", async () => {
		const { watcher, ctx, watchHere } = setup()
		await watchHere()
		watcher.stop()
		expect(ctx.abort).toHaveBeenCalledOnce()
		expect(watcher.snapshot.targets[0]).toMatchObject({ enabled: false, autoFix: false })
		const reads = vi.mocked(readPRSnapshot).mock.calls.length
		await watcher.refresh()
		expect(readPRSnapshot).toHaveBeenCalledTimes(reads)
	})

	it.each(["merged", "closed"] as const)("stops watching a %s PR and cancels its repair", async (state) => {
		const { watcher, ctx, watchHere } = setup()
		await watchHere()
		vi.mocked(readPRSnapshot).mockResolvedValue(pr({ state }))
		await watcher.refresh()
		expect(ctx.abort).toHaveBeenCalledOnce()
		expect(watcher.snapshot.targets[0]).toMatchObject({ enabled: false, message: expect.stringContaining(state) })
	})

	it("keeps provider failures visible instead of reporting healthy CI", async () => {
		vi.mocked(readPRSnapshot).mockRejectedValue(new Error("GitHub rate limit"))
		const { watchHere, repairs } = setup()
		expect((await watchHere()).targets[0]).toMatchObject({ phase: "error", message: "GitHub rate limit" })
		expect(repairs()).toEqual([])
	})

	it("repairs one PR at a time and moves on after the first push", async () => {
		const { watcher, repairs } = setup()
		const toolCtx = createToolContext({ cwd: HERE })
		await watcher.add([{ url: URL7 }, { url: URL8 }], { autoFix: true }, toolCtx)
		expect(repairs().map((repair) => repair.details)).toEqual([expect.objectContaining({ pullRequest: URL7 })])
		vi.mocked(readPRSnapshot).mockImplementation(async (url) =>
			url === URL8 ? pr({ url, number: 8 }) : pr({ headSha: "b".repeat(40) }),
		)
		await watcher.settled(false)
		expect(repairs().map((repair) => repair.details)).toEqual([
			expect.objectContaining({ pullRequest: URL7 }),
			expect.objectContaining({ pullRequest: URL8, cwd: "/checkouts/8" }),
		])
	})

	it("uses this checkout for its own PR and prepares checkouts for the others", async () => {
		vi.mocked(lookupBranchPullRequest).mockResolvedValue({
			branch: "fix/parser",
			pullRequest: { url: URL7, state: "open" } as WorkPullRequest,
		})
		vi.mocked(preparePRCheckout).mockRejectedValueOnce(new Error("clone denied"))
		const { watcher } = setup()
		const toolCtx = createToolContext({ cwd: HERE })
		const state = await watcher.add(
			[{ url: `${URL7}/?tab=checks#top` }, { url: URL8 }, { url: "https://github.com/owner/repo/pull/9" }],
			{ autoFix: false },
			toolCtx,
		)
		expect(state.targets.map(({ url, cwd }) => [url, cwd])).toEqual([
			[URL7, HERE],
			["https://github.com/owner/repo/pull/9", "/checkouts/9"],
		])
		expect(state.message).toBe(`${URL8}: clone denied`)
		expect(watcher.has(URL7)).toBe(true)
	})

	it("prepares one checkout for concurrent requests and drops it when stopped mid-preparation", async () => {
		const { watcher } = setup()
		const toolCtx = createToolContext({ cwd: HERE })
		await Promise.all([
			watcher.add([{ url: URL8 }], { autoFix: false }, toolCtx),
			watcher.add([{ url: URL8 }], { autoFix: false }, toolCtx),
		])
		expect(preparePRCheckout).toHaveBeenCalledOnce()
		let finish!: (cwd: string) => void
		vi.mocked(preparePRCheckout).mockReturnValueOnce(new Promise((resolve) => (finish = resolve)))
		const adding = watcher.add([{ url: URL7 }], { autoFix: true }, toolCtx)
		await vi.waitFor(() => expect(preparePRCheckout).toHaveBeenCalledTimes(2))
		watcher.stop()
		finish("/checkouts/7")
		await expect(adding).rejects.toThrow("cancelled")
		expect(watcher.snapshot.targets.map(({ url }) => url)).toEqual([URL8])
	})

	it("pauses or stops one URL and leaves the others running", async () => {
		const { watcher } = setup()
		await watcher.add([{ url: URL7 }, { url: URL8 }], { autoFix: false }, createToolContext({ cwd: HERE }))
		watcher.stop([URL8])
		await expect(watcher.pause(["https://github.com/owner/repo/pull/9"])).rejects.toThrow("not being watched")
		expect(watcher.snapshot.targets.map(({ enabled }) => enabled)).toEqual([true, false])
	})

	it("starts with this branch's PR when nothing is watched, then grants every watched PR", async () => {
		const { watcher, repairs } = setup()
		await expect(watcher.start({ autoFix: true })).rejects.toThrow("Open a pull request")
		vi.mocked(lookupBranchPullRequest).mockResolvedValue({
			branch: "fix/parser",
			pullRequest: { url: URL7, state: "open" } as WorkPullRequest,
		})
		expect((await watcher.start({ autoFix: false })).targets[0]).toMatchObject({ cwd: HERE, autoFix: false })
		await watcher.start({ autoFix: true, mode: "all", instructions: "only fix lint" })
		expect(repairs()[0].content).toContain("Additional instructions from the user: only fix lint")
	})

	it.each([
		{ autoFix: true, preference: true, attempts: 1, expected: true },
		{ autoFix: false, preference: true, attempts: 1, expected: false },
		{ autoFix: true, preference: undefined, attempts: 1, expected: false },
		{ autoFix: true, preference: true, attempts: 3, expected: false },
	])("restores a saved grant only while the general choice allows it: %j", async (saved) => {
		vi.mocked(readPRWatchPreference).mockReturnValue(saved.preference)
		const target = { url: URL7, cwd: HERE, enabled: true, autoFix: saved.autoFix, attempts: saved.attempts }
		const stopped = { url: URL8, cwd: HERE, enabled: false, autoFix: true }
		const invalid = [
			{ url: "https://example.com/x", cwd: HERE },
			{ url: URL7, cwd: "relative" },
		]
		const entry = { type: "custom", customType: "pr_watch", data: { targets: [target, stopped, ...invalid] } }
		const { watcher, repairs } = setup([entry])
		expect(watcher.snapshot.targets.map(({ url, enabled }) => [url, enabled])).toEqual([
			[URL7, true],
			[URL8, false],
		])
		await watcher.refresh()
		expect(repairs()).toHaveLength(saved.expected ? 1 : 0)
	})

	it("keeps a display failure from blocking a repair", async () => {
		const { watcher, watchHere, repairs } = setup()
		const observer = vi.fn()
		watcher.observe(() => {
			throw new Error("display unavailable")
		})
		watcher.observe(observer)
		await watchHere()
		expect(repairs()).toHaveLength(1)
		expect(observer).toHaveBeenCalled()
	})
})
