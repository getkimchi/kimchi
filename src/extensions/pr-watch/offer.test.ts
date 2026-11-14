import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { BRANCH_PR_OBSERVED_EVENT } from "../pull-request-status/events.js"
import { followCheckoutPR } from "./offer.js"
import { readPRWatchPreference, writePRWatchPreference } from "./settings.js"
import type { PRWatchState } from "./types.js"
import type { PRWatcher } from "./watcher.js"

vi.mock("./settings.js", () => ({ readPRWatchPreference: vi.fn(), writePRWatchPreference: vi.fn() }))

const url = "https://github.com/example/repo/pull/7"
const pr = { url, number: 7, state: "open", provider: "github" }

function fakeWatcher() {
	const watched = new Set<string>()
	const watcher = {
		revision: 0,
		has: (target: string) => watched.has(target),
		add: vi.fn(async (requests: { url: string }[], grant: { autoFix: boolean }): Promise<PRWatchState> => {
			for (const request of requests) watched.add(request.url)
			return {
				targets: requests.map((request) => ({ ...request, enabled: true, autoFix: grant.autoFix })),
				message: null,
			} as PRWatchState
		}),
	}
	return watcher
}

describe("following the checkout's PR", () => {
	const offers: ReturnType<typeof followCheckoutPR>[] = []
	beforeEach(() => {
		vi.mocked(readPRWatchPreference).mockReset()
		vi.mocked(writePRWatchPreference)
			.mockReset()
			.mockImplementation((enabled) => vi.mocked(readPRWatchPreference).mockReturnValue(enabled))
	})
	afterEach(() => {
		for (const offer of offers.splice(0)) offer.dispose()
	})
	function setup({ readOnly = false, sessionId = "test-session" } = {}) {
		const extension = createExtensionApi()
		const ctx = createContext({
			cwd: "/work/repo",
			isIdle: vi.fn(() => true),
			sessionManager: { getSessionId: () => sessionId },
		})
		const watcher = fakeWatcher()
		const offer = followCheckoutPR(extension.api, ctx, watcher as unknown as PRWatcher, readOnly)
		offers.push(offer)
		const detect = (pullRequest: unknown = pr, overrides = {}) =>
			extension.api.events.emit(BRANCH_PR_OBSERVED_EVENT, { sessionId, cwd: ctx.cwd, pullRequest, ...overrides })
		return { ctx, watcher, offer, detect }
	}

	it("asks once when an open PR appears and remembers a decline", async () => {
		const { ctx, watcher, detect } = setup()
		vi.mocked(ctx.ui.confirm).mockResolvedValue(false)
		detect(null)
		detect({ ...pr, state: "closed" })
		expect(ctx.ui.confirm).not.toHaveBeenCalled()
		detect()
		await vi.waitFor(() => expect(writePRWatchPreference).toHaveBeenCalledWith(false))
		detect()
		expect(ctx.ui.confirm).toHaveBeenCalledOnce()
		expect(watcher.add).not.toHaveBeenCalled()
	})

	it("starts CI fixes in this checkout when accepted", async () => {
		const { ctx, watcher, detect } = setup()
		vi.mocked(ctx.ui.confirm).mockResolvedValue(true)
		detect()
		await vi.waitFor(() =>
			expect(watcher.add).toHaveBeenCalledWith([{ url, cwd: "/work/repo" }], {
				autoFix: true,
				mode: "ci",
				instructions: "",
			}),
		)
		expect(writePRWatchPreference).toHaveBeenCalledWith(true)
		await vi.waitFor(() =>
			expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Watching PR #7 with auto-fix"), "info"),
		)
	})

	it.each([
		{ readOnly: false, preference: true, autoFix: true },
		{ readOnly: true, preference: true, autoFix: false },
		{ readOnly: true, preference: undefined, autoFix: false },
		{ readOnly: false, preference: false, autoFix: undefined },
	])("follows the saved choice without asking: %j", async ({ readOnly, preference, autoFix }) => {
		vi.mocked(readPRWatchPreference).mockReturnValue(preference)
		const { ctx, watcher, detect } = setup({ readOnly })
		detect()
		await Promise.resolve()
		expect(ctx.ui.confirm).not.toHaveBeenCalled()
		if (autoFix === undefined) expect(watcher.add).not.toHaveBeenCalled()
		else expect(watcher.add).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ autoFix }))
	})

	it("never restarts a PR this session already watched or stopped", () => {
		vi.mocked(readPRWatchPreference).mockReturnValue(true)
		const { watcher, detect } = setup()
		watcher.has = () => true
		detect()
		expect(watcher.add).not.toHaveBeenCalled()
	})

	it("ignores other sessions and other checkouts", () => {
		const { ctx, detect } = setup()
		detect(pr, { sessionId: "other" })
		detect(pr, { cwd: "/work/other" })
		expect(ctx.ui.confirm).not.toHaveBeenCalled()
	})

	it("asks only when idle with an empty editor and no queued input", async () => {
		const { ctx, offer, detect } = setup()
		vi.mocked(ctx.ui.confirm).mockResolvedValue(false)
		vi.mocked(ctx.isIdle).mockReturnValue(false)
		detect()
		vi.mocked(ctx.isIdle).mockReturnValue(true)
		vi.mocked(ctx.ui.getEditorText).mockReturnValue("draft")
		offer.show()
		vi.mocked(ctx.ui.getEditorText).mockReturnValue("")
		vi.mocked(ctx.hasPendingMessages).mockReturnValue(true)
		offer.show()
		expect(ctx.ui.confirm).not.toHaveBeenCalled()
		vi.mocked(ctx.hasPendingMessages).mockReturnValue(false)
		offer.show()
		expect(ctx.ui.confirm).toHaveBeenCalledOnce()
	})

	it.each([
		["a checkout change", (_watcher: ReturnType<typeof fakeWatcher>, detect: (pr?: unknown) => void) => detect(null)],
		["an explicit user change", (watcher: ReturnType<typeof fakeWatcher>) => watcher.revision++],
	])("ignores a late answer after %s", async (_case, change) => {
		const { ctx, watcher, detect } = setup()
		let answer!: (accepted: boolean) => void
		vi.mocked(ctx.ui.confirm).mockReturnValue(new Promise((resolve) => (answer = resolve)))
		detect()
		change(watcher, detect)
		answer(true)
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(writePRWatchPreference).not.toHaveBeenCalled()
		expect(watcher.add).not.toHaveBeenCalled()
	})

	it("shares one question between sessions and keeps a choice saved elsewhere", async () => {
		const first = setup({ sessionId: "one" })
		const second = setup({ sessionId: "two" })
		let answer!: (accepted: boolean) => void
		vi.mocked(first.ctx.ui.confirm).mockReturnValue(new Promise((resolve) => (answer = resolve)))
		first.detect()
		second.detect()
		vi.mocked(readPRWatchPreference).mockReturnValue(false)
		answer(true)
		await new Promise((resolve) => setTimeout(resolve, 0))
		expect(second.ctx.ui.confirm).not.toHaveBeenCalled()
		expect(writePRWatchPreference).not.toHaveBeenCalled()
		expect(first.watcher.add).not.toHaveBeenCalled()
		expect(second.watcher.add).not.toHaveBeenCalled()
	})

	it("reports why automatic watching could not start", async () => {
		vi.mocked(readPRWatchPreference).mockReturnValue(true)
		const { ctx, watcher, detect } = setup()
		watcher.add.mockResolvedValue({ targets: [], message: `${url}: Trust this project before enabling auto-fix.` })
		detect()
		await vi.waitFor(() =>
			expect(ctx.ui.notify).toHaveBeenCalledWith(`${url}: Trust this project before enabling auto-fix.`, "error"),
		)
	})

	it("reports a failed save and starts nothing", async () => {
		const { ctx, watcher, detect } = setup()
		vi.mocked(ctx.ui.confirm).mockResolvedValue(true)
		vi.mocked(writePRWatchPreference).mockImplementation(() => {
			throw new Error("pr-watch.json is corrupt")
		})
		detect()
		await vi.waitFor(() => expect(ctx.ui.notify).toHaveBeenCalledWith("pr-watch.json is corrupt", "error"))
		expect(watcher.add).not.toHaveBeenCalled()
	})
})
