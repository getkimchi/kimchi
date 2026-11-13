import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resolvePreMainProjectTrust } from "../../project-trust.js"
import { createContext, createToolContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { acquirePRLease, checkoutProblem } from "./checkout.js"
import { PRWatchCollection } from "./collection.js"
import { readPRSnapshot } from "./providers.js"
import { readPRWatchPreference } from "./settings.js"
import { preparePRCheckout } from "./targets.js"
import type { PRSnapshot } from "./types.js"

vi.mock("../../project-trust.js", () => ({ resolvePreMainProjectTrust: vi.fn() }))
vi.mock("./providers.js", () => ({ readPRSnapshot: vi.fn() }))
vi.mock("./checkout.js", () => ({ checkoutProblem: vi.fn(), acquirePRLease: vi.fn() }))
vi.mock("./settings.js", () => ({ readPRWatchPreference: vi.fn() }))
vi.mock("./targets.js", async (original) => ({ ...(await original()), preparePRCheckout: vi.fn() }))

const url = (n: number) => `https://github.com/owner/repo/pull/${n}`
const pr = (n: number): PRSnapshot => ({
	provider: "github",
	repository: "owner/repo",
	number: n,
	title: `Fix ${n}`,
	url: url(n),
	branch: `fix-${n}`,
	headSha: "a".repeat(40),
	state: "open",
	checks: [{ id: "tests", name: "Tests", state: "failed", url: null, summary: "failed" }],
	feedback: [],
})

describe("requested PR collection", () => {
	const collections: PRWatchCollection[] = []
	const snapshots = new Map<string, PRSnapshot>()
	beforeEach(() => {
		vi.resetAllMocks()
		snapshots.clear()
		vi.mocked(resolvePreMainProjectTrust).mockReturnValue(true)
		vi.mocked(checkoutProblem).mockResolvedValue(null)
		vi.mocked(acquirePRLease).mockImplementation(async () => vi.fn(async () => {}))
		vi.mocked(preparePRCheckout).mockImplementation(async (_ctx, value) => `/isolated/pr-${value.split("/").at(-1)}`)
		vi.mocked(readPRSnapshot).mockImplementation(async (_cwd, _signal, target) =>
			target ? (snapshots.get(target) ?? null) : null,
		)
	})
	afterEach(async () => {
		for (const collection of collections.splice(0)) await collection.dispose()
	})
	function setup() {
		const extension = createExtensionApi()
		const ctx = createContext({ cwd: "/home/user", isIdle: vi.fn(() => false), isProjectTrusted: vi.fn(() => true) })
		const toolCtx = createToolContext({ cwd: ctx.cwd, sessionManager: ctx.sessionManager })
		const collection = new PRWatchCollection(extension.api, ctx)
		collections.push(collection)
		return { collection, ctx, toolCtx, extension }
	}
	function seed(...numbers: number[]) {
		for (const n of numbers) snapshots.set(url(n), pr(n))
	}
	it("leaves ordinary settled turns alone while watching is off", async () => {
		const { collection, extension } = setup()
		await collection.settled(false)
		expect(readPRSnapshot).not.toHaveBeenCalled()
		expect(extension.sendMessage).not.toHaveBeenCalled()
	})

	it("adds repeated requests from home without replacing targets or imposing a PR-count cap", async () => {
		const { collection, toolCtx, ctx } = setup()
		const requests = Array.from({ length: 105 }, (_, i) => ({ url: url(i + 1) }))
		seed(...requests.map((_, i) => i + 1))
		await collection.startTargets(requests.slice(0, 2), true, undefined, "ci", toolCtx)
		await collection.startTargets(requests, true, undefined, "ci", toolCtx)
		expect(collection.snapshot.watches).toHaveLength(105)
		expect(collection.snapshot.watches?.every(({ state }) => state.enabled && state.mode === "ci")).toBe(true)
		expect(preparePRCheckout).toHaveBeenCalledTimes(105)
		expect(ctx.cwd).toBe("/home/user")
	})

	it("queues distinct checkout repairs and releases the first lease before waking the next", async () => {
		seed(7, 8)
		const { collection, toolCtx, ctx, extension } = setup()
		await collection.startTargets([{ url: url(7) }, { url: url(8) }], true, undefined, "ci", toolCtx)
		vi.mocked(ctx.isIdle).mockReturnValue(true)
		await collection.refresh()
		expect(extension.sendMessage).toHaveBeenCalledTimes(1)
		expect(extension.sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				details: expect.objectContaining({ pullRequest: url(7), cwd: "/isolated/pr-7" }),
				content: expect.stringContaining('checkout at "/isolated/pr-7"'),
			}),
			expect.anything(),
		)
		const release = await vi.mocked(acquirePRLease).mock.results[0].value
		await collection.refresh()
		expect(extension.sendMessage).toHaveBeenCalledTimes(1)
		snapshots.set(url(7), { ...pr(7), headSha: "b".repeat(40), checks: [] })
		await collection.settled(false)
		expect(release).toHaveBeenCalledOnce()
		expect(extension.sendMessage).toHaveBeenCalledTimes(2)
		expect(extension.sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ details: expect.objectContaining({ pullRequest: url(8), cwd: "/isolated/pr-8" }) }),
			expect.anything(),
		)
	})

	it("reuses the session PR alongside other targets without counting it twice", async () => {
		seed(7, 8)
		vi.mocked(readPRSnapshot).mockImplementation(
			async (_cwd, _signal, target) => snapshots.get(target ?? url(7)) ?? null,
		)
		const { collection, ctx, toolCtx } = setup()
		await collection.startTargets([{ url: url(7), cwd: ctx.cwd }, { url: url(8) }], true, undefined, "ci", toolCtx)
		expect(collection.snapshot.watches?.map(({ state }) => state.pullRequest?.url)).toEqual([url(7), url(8)])
		expect(preparePRCheckout).toHaveBeenCalledOnce()
		expect(collection.local.snapshot.enabled).toBe(true)
	})

	it("serializes concurrent requests so the same PR gets one checkout", async () => {
		seed(7)
		const { collection, toolCtx } = setup()
		await Promise.all([
			collection.startTargets([{ url: url(7) }], true, undefined, "ci", toolCtx),
			collection.startTargets([{ url: url(7) }], true, undefined, "ci", toolCtx),
		])
		expect(collection.snapshot.watches).toHaveLength(1)
		expect(preparePRCheckout).toHaveBeenCalledOnce()
	})

	it("tracks trusted review feedback but never repairs it in CI-only mode", async () => {
		seed(7, 8)
		for (const [key, value] of snapshots)
			snapshots.set(key, {
				...value,
				checks: [],
				feedback: [
					{ id: "review:1", author: "owner", body: "Fix this", url: key, path: null, line: null, trusted: true },
				],
			})
		const { collection, toolCtx, ctx, extension } = setup()
		await collection.startTargets([{ url: url(7) }, { url: url(8) }], true, undefined, "ci", toolCtx)
		vi.mocked(ctx.isIdle).mockReturnValue(true)
		await collection.refresh()
		expect(extension.sendMessage).not.toHaveBeenCalled()
		expect(collection.snapshot.watches?.every(({ state }) => state.pullRequest?.feedback.length === 1)).toBe(true)
		await collection.configure(true, true, undefined, url(8), "reviews")
		expect(extension.sendMessage).toHaveBeenCalledOnce()
		expect(extension.sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({
				details: expect.objectContaining({ pullRequest: url(8) }),
				content: expect.stringContaining("trusted review feedback only"),
			}),
			expect.anything(),
		)
	})

	it("pauses or stops all targets and allows selecting a single URL", async () => {
		seed(7, 8)
		const { collection, toolCtx } = setup()
		await collection.startTargets([{ url: url(7) }, { url: url(8) }], true, undefined, "ci", toolCtx)
		await collection.configure(true, false)
		expect(collection.snapshot.watches?.every(({ state }) => state.enabled && !state.autoFix)).toBe(true)
		await collection.configure(true, true, undefined, url(7))
		expect(collection.snapshot.watches?.map(({ state }) => state.autoFix)).toEqual([true, false])
		await collection.configure(false, false, undefined, url(7))
		expect(collection.snapshot.watches?.map(({ state }) => state.enabled)).toEqual([false, true])
		vi.mocked(readPRSnapshot).mockClear()
		await collection.refresh()
		expect(readPRSnapshot).toHaveBeenCalledTimes(1)
		expect(readPRSnapshot).toHaveBeenCalledWith("/isolated/pr-8", expect.anything(), url(8))
		await collection.configure(true, false)
		expect(collection.snapshot.watches?.map(({ state }) => state.enabled)).toEqual([false, true])
		await collection.configure(false, false)
		expect(collection.snapshot.enabled).toBe(false)
	})

	it("keeps successful targets when one checkout cannot be prepared", async () => {
		seed(7, 8)
		vi.mocked(preparePRCheckout).mockRejectedValueOnce(new Error("Permission denied"))
		const { collection, toolCtx } = setup()
		await collection.startTargets([{ url: url(7) }, { url: url(8) }], true, undefined, "ci", toolCtx)
		expect(collection.snapshot.watches).toHaveLength(1)
		expect(collection.snapshot.watches?.[0].state.pullRequest?.url).toBe(url(8))
		expect(collection.snapshot.message).toContain("Permission denied")
	})

	it("checks trust in the target checkout instead of inheriting a trusted home directory", async () => {
		seed(7)
		vi.mocked(resolvePreMainProjectTrust).mockReturnValue(false)
		const { collection, toolCtx, ctx, extension } = setup()
		await collection.startTargets([{ url: url(7) }], true, undefined, "ci", toolCtx)
		vi.mocked(ctx.isIdle).mockReturnValue(true)
		await collection.refresh()
		expect(collection.snapshot.autoFix).toBe(false)
		expect(extension.sendMessage).not.toHaveBeenCalled()
	})

	it("restores every target, its selected mode and its local pause", async () => {
		seed(7, 8)
		const { collection, toolCtx, ctx, extension } = setup()
		await collection.startTargets([{ url: url(7) }, { url: url(8) }], true, undefined, "all", toolCtx)
		await collection.configure(true, false, undefined, url(8))
		ctx.sessionManager.getEntries = vi.fn(() =>
			extension.appendEntry.mock.calls.map(([customType, data], i) => ({
				type: "custom" as const,
				customType,
				data,
				id: String(i),
				parentId: null,
				timestamp: "2026-11-13T10:00:00Z",
			})),
		)
		vi.mocked(readPRWatchPreference).mockReturnValue(true)
		const resumed = new PRWatchCollection(extension.api, ctx)
		collections.push(resumed)
		await resumed.refresh()
		expect(resumed.snapshot.watches?.map(({ state }) => [state.autoFix, state.mode])).toEqual([
			[true, "all"],
			[false, "all"],
		])
	})

	it("stopping during preparation prevents a late checkout from starting a watcher", async () => {
		seed(7)
		let finish!: (cwd: string) => void
		vi.mocked(preparePRCheckout).mockReturnValue(
			new Promise((done) => {
				finish = done
			}),
		)
		const { collection, toolCtx } = setup()
		const started = collection.startTargets([{ url: url(7) }], true, undefined, "ci", toolCtx)
		await vi.waitFor(() => expect(preparePRCheckout).toHaveBeenCalledOnce())
		await collection.configure(false, false)
		finish("/isolated/pr-7")
		await expect(started).rejects.toThrow()
		expect(collection.snapshot.enabled).toBe(false)
		expect(collection.snapshot.watches).toBeUndefined()
	})
})
