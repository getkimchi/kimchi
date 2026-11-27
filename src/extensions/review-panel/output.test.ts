import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import * as fsPromises from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import * as locks from "proper-lockfile"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { updateReviewJson } from "./output.js"

vi.mock("proper-lockfile", async (original) => ({ ...(await original<typeof locks>()) }))
vi.mock("node:fs/promises", async (original) => ({ ...(await original<typeof fsPromises>()) }))

describe("review output locking", () => {
	let root: string
	let path: string

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "review-output-lock-"))
		path = join(root, "state", "panel.json")
		mkdirSync(dirname(path), { recursive: true })
	})

	afterEach(() => {
		vi.restoreAllMocks()
		rmSync(root, { recursive: true, force: true })
	})

	it("reclaims a freshly orphaned lock within a bounded time", async () => {
		mkdirSync(`${dirname(path)}.lock`)
		const startedAt = Date.now()

		await updateReviewJson(path, () => ({ recovered: true }))

		expect(Date.now() - startedAt).toBeLessThan(15_000)
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ recovered: true })
	}, 20_000)

	it("turns lock compromise into typed failure rather than an uncaught exception", async () => {
		let compromise!: (error: Error) => void
		let unblockRead!: () => void
		const readBlocked = new Promise<void>((resolve) => {
			unblockRead = resolve
		})
		const actualReadFile = fsPromises.readFile
		const read = vi.spyOn(fsPromises, "readFile").mockImplementationOnce(async (...args) => {
			await readBlocked
			return actualReadFile(...args)
		})
		const release = vi.fn(async () => {})
		vi.spyOn(locks, "lock").mockImplementation(async (_path, options) => {
			compromise =
				options?.onCompromised ??
				((error: Error) => {
					throw error
				})
			return release
		})
		const pending = updateReviewJson(path, () => ({ attempted: true }))
		await vi.waitFor(() => {
			expect(compromise).toBeDefined()
			expect(read).toHaveBeenCalledOnce()
		})

		try {
			expect(() => compromise(Object.assign(new Error("mtime refresh failed"), { code: "ECOMPROMISED" }))).not.toThrow()
		} finally {
			unblockRead()
		}
		await expect(pending).rejects.toMatchObject({ name: "ReviewFileLockError", code: "ECOMPROMISED" })
		expect(release).not.toHaveBeenCalled()
	})

	it("serializes concurrent live read-merge-write updates", async () => {
		const updates = Array.from({ length: 20 }, () =>
			updateReviewJson(path, (current) => ({ count: ((current as { count?: number } | undefined)?.count ?? 0) + 1 })),
		)

		await Promise.all(updates)

		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ count: updates.length })
	})
})
