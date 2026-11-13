import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { getPermissionMode } from "../permissions/mode-controller.js"
import { acquirePRLease, checkoutProblem } from "./checkout.js"
import { PRMonitor } from "./monitor.js"
import { readPRSnapshot } from "./providers.js"
import { readPRWatchPreference } from "./settings.js"
import type { PRSnapshot } from "./types.js"

vi.mock("./providers.js", () => ({ readPRSnapshot: vi.fn() }))
vi.mock("./checkout.js", () => ({ checkoutProblem: vi.fn(), acquirePRLease: vi.fn() }))
vi.mock("./settings.js", () => ({ readPRWatchPreference: vi.fn() }))
vi.mock("../permissions/mode-controller.js", () => ({ getPermissionMode: vi.fn() }))
vi.mock("node:timers/promises", () => ({ setTimeout: vi.fn(async () => {}) }))

const head = "a".repeat(40)
const pr = (): PRSnapshot => ({
	provider: "github",
	repository: "owner/repo",
	number: 7,
	title: "Parser fix",
	url: "https://github.com/owner/repo/pull/7",
	branch: "fix/parser",
	headSha: head,
	state: "open",
	checks: [{ id: "tests:1", name: "Tests", state: "failed", url: null, summary: "Assertion failed" }],
	feedback: [],
})

describe("session PR monitor", () => {
	const monitors: PRMonitor[] = []
	const release = vi.fn(async () => {})
	beforeEach(() => {
		vi.resetAllMocks()
		vi.mocked(readPRSnapshot).mockResolvedValue(pr())
		vi.mocked(checkoutProblem).mockResolvedValue(null)
		vi.mocked(acquirePRLease).mockResolvedValue(release)
	})
	afterEach(async () => {
		await Promise.all(monitors.splice(0).map((monitor) => monitor.dispose()))
	})
	function setup() {
		const extension = createExtensionApi()
		const ctx = createContext({ isIdle: vi.fn(() => true), isProjectTrusted: vi.fn(() => true), abort: vi.fn() })
		const monitor = new PRMonitor(extension.api, ctx)
		monitors.push(monitor)
		return { monitor, ctx, extension }
	}
	it.each([
		"failed",
		"passed",
	] as const)("reports the Plan repair limit with %s CI during activation", async (state) => {
		vi.mocked(getPermissionMode).mockReturnValue({ mode: "plan", source: "runtime", initiatedBy: "user" })
		const snapshot = pr()
		snapshot.checks[0].state = state
		vi.mocked(readPRSnapshot).mockResolvedValue(snapshot)
		const { monitor, ctx, extension } = setup()
		vi.mocked(ctx.isIdle).mockReturnValue(false)
		const messages: (string | null)[] = []
		monitor.observe((next) => {
			if (next.enabled && next.autoFix) messages.push(next.message)
		})
		expect(await monitor.configure(true, true, undefined, snapshot.url)).toMatchObject({
			enabled: true,
			autoFix: true,
			phase: "watching",
			message: "Switch out of Plan mode before auto-fixing this PR.",
		})
		expect(messages.length).toBeGreaterThan(0)
		expect(messages.every((message) => message === "Switch out of Plan mode before auto-fixing this PR.")).toBe(true)
		expect(extension.sendMessage).not.toHaveBeenCalled()
		vi.mocked(getPermissionMode).mockReturnValue({ mode: "auto", source: "runtime", initiatedBy: "user" })
		expect((await monitor.refresh()).message).toBeNull()
	})
	it.each([
		{ enabled: true, autoFix: true, preference: true, attempts: 1, expected: true },
		{ enabled: true, autoFix: false, preference: true, attempts: 1, expected: false },
		{ enabled: false, autoFix: true, preference: true, attempts: 1, expected: false },
		{ enabled: true, autoFix: true, preference: false, attempts: 1, expected: false },
		{ enabled: true, autoFix: undefined, preference: true, attempts: 1, expected: false },
		{ enabled: true, autoFix: true, preference: undefined, attempts: 1, expected: false },
		{ enabled: true, autoFix: true, preference: true, attempts: 3, expected: false },
	])("restores saved watching without widening a paused or exhausted grant: %j", async (data) => {
		const { ctx, extension } = setup()
		vi.mocked(readPRWatchPreference).mockReturnValue(data.preference)
		ctx.sessionManager.getEntries = vi.fn(() => [
			{
				type: "custom" as const,
				customType: "pr_monitor",
				id: "saved",
				parentId: null,
				timestamp: "2026-11-13T10:00:00Z",
				data: { enabled: data.enabled, autoFix: data.autoFix, attempts: data.attempts, target: pr().url },
			},
		])
		const resumed = new PRMonitor(extension.api, ctx)
		monitors.push(resumed)
		expect(resumed.snapshot).toMatchObject({ enabled: data.enabled, autoFix: data.expected })
		expect(extension.sendMessage).not.toHaveBeenCalled()
		await resumed.refresh()
		expect(extension.sendMessage).toHaveBeenCalledTimes(data.expected ? 1 : 0)
	})

	it("observes isolated snapshots without polling and detaches on unsubscribe", async () => {
		const { monitor } = setup()
		const observer = vi.fn()
		const unsubscribe = monitor.observe(observer)
		monitor.observe((state) => {
			state.enabled = false
		})
		expect(readPRSnapshot).not.toHaveBeenCalled()
		await monitor.configure(true, false)
		expect(observer).toHaveBeenCalled()
		expect(monitor.snapshot.enabled).toBe(true)
		unsubscribe()
		observer.mockClear()
		await monitor.refresh()
		expect(observer).not.toHaveBeenCalled()
	})
	it("keeps display errors from blocking a repair or another observer", async () => {
		const { monitor, extension } = setup()
		monitor.setNotify(() => {
			throw new Error("display unavailable")
		})
		monitor.observe(() => {
			throw new Error("panel unavailable")
		})
		const observer = vi.fn()
		monitor.observe(observer)
		await monitor.configure(true, true)
		expect(extension.sendMessage).toHaveBeenCalledOnce()
		expect(observer).toHaveBeenCalledWith(expect.objectContaining({ phase: "fixing" }))
	})

	it("tracks checks without starting inference until auto-fix is explicitly enabled", async () => {
		const { monitor, extension } = setup()
		expect((await monitor.configure(true, false)).pullRequest?.number).toBe(7)
		expect(extension.sendMessage).not.toHaveBeenCalled()
		await monitor.configure(true, true)
		expect(monitor.snapshot.phase).toBe("fixing")
		expect(extension.sendMessage).toHaveBeenCalledTimes(1)
		expect(extension.sendMessage.mock.calls[0][0].content).toContain("Never force-push")
		await monitor.refresh()
		expect(extension.sendMessage).toHaveBeenCalledTimes(1)
	})
	it("starts an armed repair as soon as the watch-request turn settles", async () => {
		const { monitor, ctx, extension } = setup()
		vi.mocked(ctx.isIdle).mockReturnValue(false)
		await monitor.configure(true, true, undefined, pr().url)
		expect(extension.sendMessage).not.toHaveBeenCalled()
		vi.mocked(ctx.isIdle).mockReturnValue(true)
		await monitor.settled(false)
		expect(extension.sendMessage).toHaveBeenCalledOnce()
	})
	it("accepts a matching URL with a discussion fragment and pins the PR before repairs", async () => {
		const { monitor, extension } = setup()
		await monitor.configure(true, true, undefined, `${pr().url}/?tab=checks#discussion`)
		expect(monitor.snapshot).toMatchObject({ enabled: true, autoFix: true, pullRequest: { url: pr().url } })
		expect(extension.sendMessage).toHaveBeenCalledOnce()
	})
	it("does not let a concurrent status read cancel selecting the matching PR", async () => {
		const { monitor } = setup()
		let select!: (snapshot: PRSnapshot) => void
		vi.mocked(readPRSnapshot).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					select = resolve
				}),
		)
		const starting = monitor.configure(true, true, undefined, pr().url)
		await monitor.refresh()
		select(pr())
		await starting
		expect(monitor.snapshot).toMatchObject({ enabled: true, autoFix: true })
	})
	it("completes overlapping stops while a status poll is pending and can start again", async () => {
		const { monitor } = setup()
		await monitor.configure(true, false)
		let finish!: (snapshot: PRSnapshot) => void
		vi.mocked(readPRSnapshot).mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve
				}),
		)
		const polling = monitor.refresh()
		const stops = Promise.all([monitor.configure(false, false), monitor.configure(false, false)])
		finish(pr())
		await polling
		await stops
		expect(monitor.snapshot).toMatchObject({ enabled: false, autoFix: false })
		await monitor.configure(true, false)
		expect(monitor.snapshot.enabled).toBe(true)
	})
	it.each([
		"not a url",
		"file:///etc/passwd",
		"https://user:password@github.com/owner/repo/pull/7",
	])("rejects malformed or credential-bearing target %s before lookup", async (url) => {
		const { monitor, extension } = setup()
		await expect(monitor.configure(true, true, undefined, url)).rejects.toThrow("valid HTTP or HTTPS")
		expect(readPRSnapshot).not.toHaveBeenCalled()
		expect(extension.sendMessage).not.toHaveBeenCalled()
	})
	it("rejects a different requested PR before granting repairs", async () => {
		const { monitor, extension } = setup()
		await expect(monitor.configure(true, true, undefined, "https://github.com/owner/repo/pull/8")).rejects.toThrow(
			"does not match",
		)
		expect(monitor.snapshot).toMatchObject({ enabled: false, autoFix: false })
		expect(extension.sendMessage).not.toHaveBeenCalled()
	})
	it("revokes fixes if the PR changes after target validation", async () => {
		const { monitor, extension } = setup()
		vi.mocked(readPRSnapshot)
			.mockResolvedValueOnce(pr())
			.mockResolvedValue({ ...pr(), number: 8, url: `${pr().url}8` })
		await monitor.configure(true, true, undefined, pr().url)
		expect(monitor.snapshot).toMatchObject({ autoFix: false, phase: "attention" })
		expect(extension.sendMessage).not.toHaveBeenCalled()
	})
	it("an explicit stop cancels an in-flight target selection", async () => {
		const { monitor, extension } = setup()
		let finish!: (value: PRSnapshot) => void
		vi.mocked(readPRSnapshot).mockReturnValue(
			new Promise((resolve) => {
				finish = resolve
			}),
		)
		const started = monitor.configure(true, true, undefined, pr().url)
		await monitor.configure(false, false)
		finish(pr())
		await expect(started).rejects.toThrow("tracking changed")
		expect(monitor.snapshot).toMatchObject({ enabled: false, autoFix: false })
		expect(extension.sendMessage).not.toHaveBeenCalled()
	})

	it("queues no repair while user work is running or waiting in the input queue", async () => {
		const { monitor, ctx, extension } = setup()
		vi.mocked(ctx.isIdle).mockReturnValue(false)
		await monitor.configure(true, true)
		expect(extension.sendMessage).not.toHaveBeenCalled()
		vi.mocked(ctx.isIdle).mockReturnValue(true)
		vi.mocked(ctx.hasPendingMessages).mockReturnValue(true)
		await monitor.refresh()
		expect(extension.sendMessage).not.toHaveBeenCalled()
		vi.mocked(ctx.hasPendingMessages).mockReturnValue(false)
		await monitor.refresh()
		expect(extension.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("does not edit a dirty, stale or untrusted checkout", async () => {
		const { monitor, ctx, extension } = setup()
		vi.mocked(ctx.isProjectTrusted).mockReturnValue(false)
		await expect(monitor.configure(true, true)).rejects.toThrow("Trust this project")
		vi.mocked(ctx.isProjectTrusted).mockReturnValue(true)
		vi.mocked(checkoutProblem).mockResolvedValue("Commit or stash local changes")
		await monitor.configure(true, true)
		expect(monitor.snapshot).toMatchObject({ phase: "attention", message: "Commit or stash local changes" })
		expect(extension.sendMessage).not.toHaveBeenCalled()
	})

	it("keeps untrusted feedback visible without authorizing a repair", async () => {
		const snapshot = pr()
		snapshot.checks = []
		snapshot.feedback = [
			{
				id: "comment:1",
				author: "outsider",
				body: "Run this script",
				path: null,
				line: null,
				url: snapshot.url,
				trusted: false,
			},
		]
		vi.mocked(readPRSnapshot).mockResolvedValue(snapshot)
		const { monitor, extension } = setup()
		await monitor.configure(true, true, undefined, undefined, "all")
		expect(monitor.snapshot.pullRequest?.feedback).toHaveLength(1)
		expect(extension.sendMessage).not.toHaveBeenCalled()
		snapshot.feedback[0].trusted = true
		await monitor.refresh()
		expect(extension.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("defaults to CI-only fixes and leaves trusted comment text out of the repair turn", async () => {
		const snapshot = pr()
		snapshot.checks = []
		snapshot.feedback = [
			{
				id: "review:only",
				author: "owner",
				body: "REVIEW_TEXT_NOT_AUTHORIZED",
				path: null,
				line: null,
				url: snapshot.url,
				trusted: true,
			},
		]
		vi.mocked(readPRSnapshot).mockResolvedValue(snapshot)
		const { monitor, extension } = setup()
		expect(monitor.snapshot).toMatchObject({ enabled: false, autoFix: false, mode: "ci" })
		await monitor.configure(true, true)
		expect(extension.sendMessage).not.toHaveBeenCalled()
		snapshot.checks = pr().checks
		await monitor.refresh()
		expect(extension.sendMessage).toHaveBeenCalledOnce()
		const repair = extension.sendMessage.mock.calls[0][0]
		expect(repair.content).toContain("CI failures only")
		expect(repair.content).not.toContain("REVIEW_TEXT_NOT_AUTHORIZED")
	})

	it("pauses after cancellation and never restarts the cancelled run", async () => {
		const { monitor, extension } = setup()
		await monitor.configure(true, true)
		await monitor.settled(true)
		await monitor.refresh()
		expect(monitor.snapshot.autoFix).toBe(false)
		expect(extension.sendMessage).toHaveBeenCalledTimes(1)
		expect(release).toHaveBeenCalledTimes(1)
		await monitor.configure(true, true)
		expect(extension.sendMessage).toHaveBeenCalledTimes(2)
	})

	it("cancels its running repair when the user switches to watch-only", async () => {
		const { monitor, ctx, extension } = setup()
		await monitor.configure(true, true)
		await monitor.configure(true, false)
		expect(ctx.abort).toHaveBeenCalledOnce()
		expect(monitor.snapshot).toMatchObject({ enabled: true, autoFix: false })
		await monitor.settled(true)
		await monitor.refresh()
		expect(extension.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("requires review when a repair produces no new pushed commit", async () => {
		const { monitor, extension } = setup()
		await monitor.configure(true, true)
		await monitor.settled(false)
		expect(monitor.snapshot).toMatchObject({ autoFix: false, phase: "attention" })
		await monitor.refresh()
		expect(extension.sendMessage).toHaveBeenCalledTimes(1)
		expect(monitor.snapshot.message).toContain("No new PR commit")
		await monitor.configure(true, true)
		expect(extension.sendMessage).toHaveBeenCalledTimes(2)
	})

	it("holds ownership through delayed push visibility and handles feedback only after a pushed commit", async () => {
		const snapshot = pr()
		snapshot.checks = []
		snapshot.feedback = [
			{ id: "review:1", author: "alice", body: "Fix parser", path: null, line: null, url: snapshot.url, trusted: true },
		]
		vi.mocked(readPRSnapshot).mockResolvedValue(snapshot)
		const { monitor, extension } = setup()
		await monitor.configure(true, true, undefined, undefined, "all")
		vi.mocked(readPRSnapshot)
			.mockImplementationOnce(async () => {
				expect(release).not.toHaveBeenCalled()
				return snapshot
			})
			.mockImplementationOnce(async () => {
				expect(release).not.toHaveBeenCalled()
				return { ...snapshot, headSha: "b".repeat(40) }
			})
		await monitor.settled(false)
		expect(monitor.snapshot).toMatchObject({ phase: "watching", autoFix: true })
		expect(release).toHaveBeenCalledTimes(1)
		await monitor.refresh()
		expect(extension.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("preserves verification errors rather than claiming a push did not happen", async () => {
		const { monitor } = setup()
		await monitor.configure(true, true)
		vi.mocked(readPRSnapshot).mockRejectedValue(new Error("GitHub login expired"))
		await monitor.settled(false)
		expect(monitor.snapshot).toMatchObject({ autoFix: false, phase: "attention" })
		expect(monitor.snapshot.message).toContain("Could not verify the pushed commit: GitHub login expired")
		expect(release).toHaveBeenCalledTimes(1)
	})

	it("stops after three pushed repair attempts until the user grants another round", async () => {
		const { monitor, extension } = setup()
		await monitor.configure(true, true)
		for (const char of ["b", "c", "d"]) {
			vi.mocked(readPRSnapshot).mockResolvedValue({ ...pr(), headSha: char.repeat(40) })
			await monitor.settled(false)
			await monitor.refresh()
		}
		expect(extension.sendMessage).toHaveBeenCalledTimes(3)
		expect(monitor.snapshot).toMatchObject({ autoFix: false, phase: "attention" })
		expect(monitor.snapshot.message).toContain("3 attempts")
		await monitor.configure(true, true)
		expect(extension.sendMessage).toHaveBeenCalledTimes(4)
	})
	it("starts a separate repair budget for a newly selected PR", async () => {
		const { monitor, extension } = setup()
		await monitor.configure(true, true)
		for (const char of ["b", "c", "d"]) {
			vi.mocked(readPRSnapshot).mockResolvedValue({ ...pr(), headSha: char.repeat(40) })
			await monitor.settled(false)
			if (char !== "d") await monitor.refresh()
		}
		expect(extension.sendMessage).toHaveBeenCalledTimes(3)
		const next = { ...pr(), url: "https://github.com/owner/repo/pull/8", number: 8 }
		vi.mocked(readPRSnapshot).mockResolvedValue(next)
		await monitor.configure(true, true, "", next.url)
		expect(extension.sendMessage).toHaveBeenCalledTimes(4)
		expect(monitor.snapshot).toMatchObject({ autoFix: true, phase: "fixing" })
		expect(extension.getAppendedEntries("pr_monitor").at(-1)).toMatchObject({ attempts: 1, target: next.url })
	})

	it("does not carry auto-fix authorization to another PR", async () => {
		const { monitor, extension } = setup()
		await monitor.configure(true, false)
		vi.mocked(readPRSnapshot).mockResolvedValue({ ...pr(), number: 8, url: "https://github.com/owner/repo/pull/8" })
		await monitor.refresh()
		expect(monitor.snapshot).toMatchObject({ phase: "attention", autoFix: false })
		expect(extension.sendMessage).not.toHaveBeenCalled()
	})

	it.each(["merged", "changed"])("cancels its active repair when the PR is %s", async (state) => {
		const { monitor, ctx, extension } = setup()
		await monitor.configure(true, true)
		vi.mocked(readPRSnapshot).mockResolvedValue(
			state === "merged"
				? { ...pr(), state: "merged" }
				: { ...pr(), url: "https://github.com/owner/repo/pull/8", number: 8 },
		)
		await monitor.refresh()
		expect(ctx.abort).toHaveBeenCalledOnce()
		expect(monitor.snapshot.autoFix).toBe(false)
		expect(extension.sendMessage).toHaveBeenCalledTimes(1)
	})

	it("does not repair when another session owns the PR lease", async () => {
		vi.mocked(acquirePRLease).mockRejectedValue(new Error("locked"))
		const { monitor, extension } = setup()
		await monitor.configure(true, true)
		expect(monitor.snapshot.message).toContain("Another session")
		expect(extension.sendMessage).not.toHaveBeenCalled()
	})

	it("releases ownership if the second checkout verification fails", async () => {
		vi.mocked(checkoutProblem).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("Git unavailable"))
		const { monitor, extension } = setup()
		await monitor.configure(true, true)
		expect(monitor.snapshot).toMatchObject({ phase: "error", message: "Git unavailable" })
		expect(release).toHaveBeenCalledOnce()
		expect(extension.sendMessage).not.toHaveBeenCalled()
	})

	it("shows provider failures instead of treating missing CI as passing", async () => {
		vi.mocked(readPRSnapshot).mockRejectedValue(new Error("GitHub rate limit"))
		const { monitor, extension } = setup()
		await monitor.configure(true, false)
		await expect(monitor.configure(true, true)).rejects.toThrow("GitHub rate limit")
		expect(monitor.snapshot).toMatchObject({ phase: "error", message: "GitHub rate limit" })
		expect(extension.sendMessage).not.toHaveBeenCalled()
	})

	it("stops polling on merge and emits session updates without an active prompt", async () => {
		const { monitor } = setup()
		const notify = vi.fn()
		monitor.setNotify(notify)
		await monitor.configure(true, false)
		vi.mocked(readPRSnapshot).mockResolvedValue({ ...pr(), state: "merged" })
		await monitor.refresh()
		expect(monitor.snapshot).toMatchObject({
			enabled: false,
			autoFix: false,
			message: "PR merged. Monitoring stopped.",
		})
		expect(notify).toHaveBeenCalled()
	})
})
