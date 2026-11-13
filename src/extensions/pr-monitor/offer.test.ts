import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { BRANCH_PR_OBSERVED_EVENT } from "../pull-request-status/events.js"
import { PRMonitor } from "./monitor.js"
import { createPRTrackingOffer } from "./offer.js"
import { readPRSnapshot } from "./providers.js"
import { readPRWatchPreference, writePRWatchPreference } from "./settings.js"
import type { PRSnapshot } from "./types.js"

vi.mock("./providers.js", () => ({ readPRSnapshot: vi.fn() }))
vi.mock("./settings.js", () => ({ readPRWatchPreference: vi.fn(), writePRWatchPreference: vi.fn() }))

const pr: PRSnapshot = {
	provider: "github",
	repository: "example/repo",
	number: 7,
	title: "Parser fix",
	url: "https://github.com/example/repo/pull/7",
	branch: "feature",
	headSha: "a".repeat(40),
	state: "open",
	checks: [],
	feedback: [],
}

describe("PR tracking opt-in", () => {
	let extension: ReturnType<typeof createExtensionApi>
	let ctx: ReturnType<typeof createContext>
	let monitor: PRMonitor
	let offer: ReturnType<typeof createPRTrackingOffer>
	const observation = (pullRequest: unknown = pr) => ({
		sessionId: ctx.sessionManager.getSessionId(),
		cwd: ctx.cwd,
		branch: pr.branch,
		pullRequest,
	})
	const detect = (pullRequest: unknown = pr) =>
		extension.api.events.emit(BRANCH_PR_OBSERVED_EVENT, observation(pullRequest))
	beforeEach(() => {
		vi.mocked(readPRWatchPreference).mockReset()
		vi.mocked(writePRWatchPreference)
			.mockReset()
			.mockImplementation((enabled) => {
				vi.mocked(readPRWatchPreference).mockReturnValue(enabled)
			})
		extension = createExtensionApi()
		ctx = createContext({ isIdle: vi.fn(() => true), isProjectTrusted: vi.fn(() => true) })
		vi.mocked(ctx.ui.confirm).mockResolvedValue(false)
		vi.mocked(readPRSnapshot).mockReset().mockResolvedValue(pr)
		monitor = new PRMonitor(extension.api, ctx)
		offer = createPRTrackingOffer(extension.api, ctx, monitor)
	})
	afterEach(async () => {
		offer.dispose()
		await monitor.dispose()
	})

	it("stays hidden until activation and remembers a declined PR across resume", async () => {
		expect(ctx.ui.confirm).not.toHaveBeenCalled()
		detect(null)
		vi.mocked(ctx.ui.confirm).mockResolvedValue(false)
		detect()
		await vi.waitFor(() => expect(ctx.ui.confirm).toHaveBeenCalledOnce())
		detect({ ...pr, headSha: "b".repeat(40) })
		expect(monitor.snapshot.enabled).toBe(false)
		expect(ctx.ui.setWidget).not.toHaveBeenCalled()
		expect(readPRSnapshot).not.toHaveBeenCalled()
		expect(extension.sendMessage).not.toHaveBeenCalled()
		offer.dispose()
		ctx.sessionManager.getEntries = vi.fn(() => [
			{
				type: "custom" as const,
				customType: "pr_monitor_offer",
				id: "offer",
				parentId: null,
				timestamp: "2026-11-13T10:00:00Z",
				data: { url: pr.url },
			},
		])
		offer = createPRTrackingOffer(extension.api, ctx, monitor)
		detect()
		await Promise.resolve()
		expect(ctx.ui.confirm).toHaveBeenCalledOnce()
		expect(extension.getAppendedEntries("pr_monitor_offer")).toEqual([{ url: pr.url }])
	})

	it("accepting enables automatic fixes without opening the panel or asking again", async () => {
		vi.mocked(ctx.ui.confirm).mockResolvedValue(true)
		detect()
		await vi.waitFor(() => expect(monitor.snapshot.enabled).toBe(true))
		expect(monitor.snapshot).toMatchObject({ autoFix: true, pullRequest: { url: pr.url } })
		expect(ctx.ui.custom).not.toHaveBeenCalled()
		expect(extension.sendMessage).not.toHaveBeenCalled()
		await monitor.configure(false, false)
		detect()
		expect(ctx.ui.confirm).toHaveBeenCalledOnce()
	})

	it("does not offer a PR already started and stopped manually", async () => {
		await monitor.configure(true, false)
		await monitor.configure(false, false)
		detect()
		expect(ctx.ui.confirm).not.toHaveBeenCalled()
	})
	it("honors tracking choices saved before the offer was installed", () => {
		offer.dispose()
		ctx.sessionManager.getEntries = vi.fn(() => [
			{
				type: "custom" as const,
				customType: "pr_monitor",
				id: "stop",
				parentId: null,
				timestamp: "2026-11-13T10:00:00Z",
				data: { enabled: false, target: pr.url },
			},
		])
		offer = createPRTrackingOffer(extension.api, ctx, monitor)
		detect()
		expect(ctx.ui.confirm).not.toHaveBeenCalled()
		expect(monitor.snapshot.enabled).toBe(false)
	})

	it("waits for idle with an empty editor and no queued work", () => {
		vi.mocked(ctx.isIdle).mockReturnValue(false)
		detect()
		expect(ctx.ui.confirm).not.toHaveBeenCalled()
		vi.mocked(ctx.isIdle).mockReturnValue(true)
		vi.mocked(ctx.hasPendingMessages).mockReturnValue(true)
		offer.show()
		expect(ctx.ui.confirm).not.toHaveBeenCalled()
		vi.mocked(ctx.hasPendingMessages).mockReturnValue(false)
		vi.mocked(ctx.ui.getEditorText).mockReturnValue("unfinished input")
		offer.show()
		expect(ctx.ui.confirm).not.toHaveBeenCalled()
		vi.mocked(ctx.ui.getEditorText).mockReturnValue("")
		offer.show()
		expect(ctx.ui.confirm).toHaveBeenCalledOnce()
	})

	it("ignores headless, closed and foreign-session or linked-worktree observations", () => {
		for (const event of [
			{ ...observation(), sessionId: "another-session" },
			{ ...observation(), cwd: `${ctx.cwd}/other-worktree` },
			observation({ ...pr, state: "closed" }),
			observation(null),
			null,
		])
			extension.api.events.emit(BRANCH_PR_OBSERVED_EVENT, event)
		expect(ctx.ui.confirm).not.toHaveBeenCalled()
		ctx.hasUI = false
		detect()
		expect(ctx.ui.confirm).not.toHaveBeenCalled()
	})

	it("cancels a pending offer on checkout change and ignores its late acceptance", async () => {
		let answer!: (accepted: boolean) => void
		vi.mocked(ctx.ui.confirm).mockImplementation(
			() =>
				new Promise((resolve) => {
					answer = resolve
				}),
		)
		detect()
		const signal = vi.mocked(ctx.ui.confirm).mock.calls[0][2]?.signal
		detect(null)
		expect(signal?.aborted).toBe(true)
		answer(true)
		await Promise.resolve()
		expect(monitor.snapshot.enabled).toBe(false)
		expect(readPRSnapshot).not.toHaveBeenCalled()
	})

	it("session shutdown removes the listener and ignores a late acceptance", async () => {
		let answer!: (accepted: boolean) => void
		vi.mocked(ctx.ui.confirm).mockImplementation(
			() =>
				new Promise((resolve) => {
					answer = resolve
				}),
		)
		detect()
		offer.dispose()
		answer(true)
		await Promise.resolve()
		detect({ ...pr, url: `${pr.url}8` })
		expect(ctx.ui.confirm).toHaveBeenCalledOnce()
		expect(monitor.snapshot.enabled).toBe(false)
	})

	it("an explicit stop while answering wins over the earlier offer", async () => {
		let answer!: (accepted: boolean) => void
		vi.mocked(ctx.ui.confirm).mockImplementation(
			() =>
				new Promise((resolve) => {
					answer = resolve
				}),
		)
		detect()
		await monitor.configure(false, false)
		answer(true)
		await Promise.resolve()
		expect(monitor.snapshot.enabled).toBe(false)
		expect(readPRSnapshot).not.toHaveBeenCalled()
	})

	it("revalidates the offered PR and reuses the general choice for a different PR", async () => {
		vi.mocked(ctx.ui.confirm).mockResolvedValue(true)
		const next = { ...pr, url: "https://github.com/example/repo/pull/8", number: 8 }
		vi.mocked(readPRSnapshot).mockResolvedValue(next)
		detect()
		await vi.waitFor(() => expect(readPRSnapshot).toHaveBeenCalledOnce())
		expect(monitor.snapshot.enabled).toBe(false)
		detect(next)
		await vi.waitFor(() => expect(monitor.snapshot.enabled).toBe(true))
		expect(ctx.ui.confirm).toHaveBeenCalledOnce()
		expect(monitor.snapshot.pullRequest?.url).toBe(next.url)
		expect(extension.sendMessage).not.toHaveBeenCalled()
	})
	it.each([true, false])("uses saved general preference %s in a fresh session without asking", async (enabled) => {
		vi.mocked(readPRWatchPreference).mockReturnValue(enabled)
		detect()
		await vi.waitFor(() => expect(monitor.snapshot.enabled).toBe(enabled))
		expect(ctx.ui.confirm).not.toHaveBeenCalled()
		expect(monitor.snapshot.autoFix).toBe(enabled)
	})
	it.each([true, false])("remembers answer %s for another PR and a fresh session", async (accepted) => {
		vi.mocked(ctx.ui.confirm).mockResolvedValue(accepted)
		detect()
		await vi.waitFor(() => expect(writePRWatchPreference).toHaveBeenCalledWith(accepted))
		offer.dispose()
		await monitor.dispose()
		extension = createExtensionApi()
		ctx = createContext({ isIdle: vi.fn(() => true), isProjectTrusted: vi.fn(() => true) })
		const next = { ...pr, url: "https://github.com/example/repo/pull/9", number: 9 }
		vi.mocked(readPRSnapshot).mockResolvedValue(next)
		monitor = new PRMonitor(extension.api, ctx)
		offer = createPRTrackingOffer(extension.api, ctx, monitor)
		detect(next)
		await vi.waitFor(() => expect(monitor.snapshot.enabled).toBe(accepted))
		expect(ctx.ui.confirm).not.toHaveBeenCalled()
	})
	it("automatically follows a new matching PR in the same session with fresh repair instructions", async () => {
		vi.mocked(readPRWatchPreference).mockReturnValue(true)
		detect()
		await vi.waitFor(() => expect(monitor.snapshot.enabled).toBe(true))
		await monitor.configure(true, true, "Only lint", pr.url)
		const next = { ...pr, url: "https://github.com/example/repo/pull/10", number: 10 }
		vi.mocked(readPRSnapshot).mockResolvedValue(next)
		detect(next)
		await vi.waitFor(() => expect(monitor.snapshot.pullRequest?.url).toBe(next.url))
		expect(ctx.ui.confirm).not.toHaveBeenCalled()
		expect(extension.getAppendedEntries("pr_monitor").at(-1)).toMatchObject({ instructions: "", target: next.url })
	})
	it("does not start a repair if saving the general decision fails", async () => {
		vi.mocked(ctx.ui.confirm).mockResolvedValue(true)
		vi.mocked(writePRWatchPreference).mockImplementation(() => {
			throw new Error("Cannot save PR preference")
		})
		detect()
		await vi.waitFor(() => expect(ctx.ui.notify).toHaveBeenCalledWith("Cannot save PR preference", "error"))
		expect(monitor.snapshot.enabled).toBe(false)
		expect(readPRSnapshot).not.toHaveBeenCalled()
	})
	it("uses a decision saved elsewhere instead of overwriting it with a late answer", async () => {
		let answer!: (value: boolean) => void
		vi.mocked(ctx.ui.confirm).mockImplementation(
			() =>
				new Promise((resolve) => {
					answer = resolve
				}),
		)
		detect()
		vi.mocked(readPRWatchPreference).mockReturnValue(false)
		answer(true)
		await Promise.resolve()
		expect(writePRWatchPreference).not.toHaveBeenCalled()
		expect(monitor.snapshot.enabled).toBe(false)
	})
	it("keeps the general question valid when a client reads status while answering", async () => {
		let answer!: (value: boolean) => void
		vi.mocked(ctx.ui.confirm).mockImplementation(
			() =>
				new Promise((resolve) => {
					answer = resolve
				}),
		)
		detect()
		await monitor.refresh()
		answer(true)
		await vi.waitFor(() => expect(monitor.snapshot.enabled).toBe(true))
		expect(writePRWatchPreference).toHaveBeenCalledWith(true)
	})
	it("shares the first general question between concurrent sessions in one process", async () => {
		let answer!: (value: boolean) => void
		vi.mocked(ctx.ui.confirm).mockImplementation(
			() =>
				new Promise((resolve) => {
					answer = resolve
				}),
		)
		detect()
		const other = createExtensionApi()
		const otherCtx = createContext({ isIdle: vi.fn(() => true), isProjectTrusted: vi.fn(() => true) })
		const otherMonitor = new PRMonitor(other.api, otherCtx)
		const otherOffer = createPRTrackingOffer(other.api, otherCtx, otherMonitor)
		try {
			other.api.events.emit(BRANCH_PR_OBSERVED_EVENT, {
				sessionId: otherCtx.sessionManager.getSessionId(),
				cwd: otherCtx.cwd,
				branch: pr.branch,
				pullRequest: pr,
			})
			answer(true)
			await vi.waitFor(() => expect(otherMonitor.snapshot.enabled).toBe(true))
			expect(otherCtx.ui.confirm).not.toHaveBeenCalled()
			expect(ctx.ui.confirm).toHaveBeenCalledOnce()
			expect(writePRWatchPreference).toHaveBeenCalledOnce()
		} finally {
			otherOffer.dispose()
			await otherMonitor.dispose()
		}
	})
	it("does not announce tracking when the PR closes during activation", async () => {
		vi.mocked(ctx.ui.confirm).mockResolvedValue(true)
		vi.mocked(readPRSnapshot)
			.mockResolvedValueOnce(pr)
			.mockResolvedValue({ ...pr, state: "closed" })
		detect()
		await vi.waitFor(() => expect(readPRSnapshot).toHaveBeenCalledTimes(2))
		expect(monitor.snapshot.enabled).toBe(false)
		expect(ctx.ui.notify).not.toHaveBeenCalledWith(expect.stringContaining("Tracking PR"), "info")
	})
})
