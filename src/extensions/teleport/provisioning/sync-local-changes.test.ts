import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Mock the dependencies of syncLocalChangesAfterClone.
vi.mock("../provisioning/include-list.js", () => ({
	buildChangedFilesList: vi.fn(),
}))

vi.mock("../provisioning/estimate-bytes.js", () => ({
	sumIncludeListBytes: vi.fn(),
}))

vi.mock("../provisioning/rsync-runner.js", () => ({
	runRsync: vi.fn(),
	formatRsyncFailure: vi.fn((err: unknown) => (err instanceof Error ? err.message : String(err))),
}))

import { sumIncludeListBytes } from "./estimate-bytes.js"
import { buildChangedFilesList } from "./include-list.js"
import { formatRsyncFailure, runRsync } from "./rsync-runner.js"
import { syncLocalChangesAfterClone } from "./sync-local-changes.js"

const LOCAL_PATH = "/work/project"
const REMOTE_PATH = "/home/sandbox/project/"
const REMOTE_HOST = "worker.example.com"
const AUTH_TOKEN = "tok-123"

function makeOpts(overrides: Record<string, unknown> = {}) {
	return {
		localPath: LOCAL_PATH,
		remotePath: REMOTE_PATH,
		remoteHost: REMOTE_HOST,
		authToken: AUTH_TOKEN,
		freshClone: true,
		signal: undefined,
		onWarn: vi.fn(),
		onStatus: vi.fn(),
		...overrides,
	}
}

beforeEach(() => {
	vi.clearAllMocks()
	vi.mocked(buildChangedFilesList).mockResolvedValue(["src/a.ts", "README.md"])
	vi.mocked(sumIncludeListBytes).mockResolvedValue(4096)
	vi.mocked(runRsync).mockResolvedValue({ fileCount: 2, totalBytes: 4096, durationMs: 100 })
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe("syncLocalChangesAfterClone", () => {
	it("skips rsync when there are no changed files and calls onStatus", async () => {
		vi.mocked(buildChangedFilesList).mockResolvedValue([])
		const opts = makeOpts()

		await syncLocalChangesAfterClone(opts)

		expect(runRsync).not.toHaveBeenCalled()
		expect(opts.onStatus).toHaveBeenCalledWith("No local changes to sync")
	})

	it("runs rsync with the changed files, excludes, and freshClone-driven delete", async () => {
		const opts = makeOpts({ freshClone: true })

		await syncLocalChangesAfterClone(opts)

		expect(runRsync).toHaveBeenCalledWith(
			expect.objectContaining({
				localPath: LOCAL_PATH,
				remotePath: REMOTE_PATH,
				remoteHost: REMOTE_HOST,
				authToken: AUTH_TOKEN,
				deleteExtraneous: true,
				filesFrom: ["src/a.ts", "README.md"],
				excludeFilters: [".git/", ".env", ".env.*", ".envrc", ".kimchi/"],
				precomputeTotal: true,
				precomputedTotalBytes: 4096,
			}),
		)
	})

	it("disables --delete when freshClone is false and warns", async () => {
		const opts = makeOpts({ freshClone: false })

		await syncLocalChangesAfterClone(opts)

		expect(runRsync).toHaveBeenCalledWith(expect.objectContaining({ deleteExtraneous: false }))
		expect(opts.onWarn).toHaveBeenCalledWith("Remote dir already existed — skipping pruning of extra remote files")
	})

	it("surfaces rsync failure via onWarn instead of throwing", async () => {
		vi.mocked(runRsync).mockRejectedValue(new Error("rsync boom"))
		vi.mocked(formatRsyncFailure).mockReturnValue("rsync boom (code 23)")
		const opts = makeOpts()

		await syncLocalChangesAfterClone(opts)

		expect(opts.onWarn).toHaveBeenCalledWith("rsync boom (code 23)")
	})

	it("re-throws on abort", async () => {
		const ctrl = new AbortController()
		ctrl.abort()
		const opts = makeOpts({ signal: ctrl.signal })
		vi.mocked(runRsync).mockRejectedValue(new Error("aborted"))

		await expect(syncLocalChangesAfterClone(opts)).rejects.toThrow()
	})

	it("forwards onPhase and onCumulativeProgress callbacks", async () => {
		const onPhase = vi.fn()
		const onCumulativeProgress = vi.fn()
		const opts = makeOpts({ onPhase, onCumulativeProgress })

		await syncLocalChangesAfterClone(opts)

		expect(runRsync).toHaveBeenCalledWith(expect.objectContaining({ onPhase, onCumulativeProgress }))
	})

	it("sets status to 'Syncing local changes' before rsync", async () => {
		const opts = makeOpts()

		await syncLocalChangesAfterClone(opts)

		expect(opts.onStatus).toHaveBeenCalledWith("Syncing local changes")
	})
})
