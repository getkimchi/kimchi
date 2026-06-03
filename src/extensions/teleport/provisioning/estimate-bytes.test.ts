import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { estimateUploadBytes, sumIncludeListBytes } from "./estimate-bytes.js"

describe("estimateUploadBytes", () => {
	let root: string

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "kimchi-estimate-"))
	})

	afterEach(async () => {
		await rm(root, { recursive: true, force: true })
	})

	it("sums sizes of files in a flat directory", async () => {
		await writeFile(join(root, "a.txt"), "12345")
		await writeFile(join(root, "b.txt"), "67890123")
		const total = await estimateUploadBytes(root, new Set())
		expect(total).toBe(13)
	})

	it("recurses into nested subdirectories", async () => {
		await mkdir(join(root, "a", "b"), { recursive: true })
		await writeFile(join(root, "top.txt"), "x")
		await writeFile(join(root, "a", "mid.txt"), "yy")
		await writeFile(join(root, "a", "b", "deep.txt"), "zzz")
		const total = await estimateUploadBytes(root, new Set())
		expect(total).toBe(6)
	})

	it("prunes node_modules and dist at the directory level", async () => {
		await writeFile(join(root, "keep.txt"), "kept")
		await mkdir(join(root, "node_modules"), { recursive: true })
		await writeFile(join(root, "node_modules", "huge.bin"), "x".repeat(10000))
		await mkdir(join(root, "dist"), { recursive: true })
		await writeFile(join(root, "dist", "bundle.js"), "x".repeat(5000))
		const total = await estimateUploadBytes(root, new Set())
		expect(total).toBe(4) // only keep.txt
	})

	it("skips files whose repo-relative path is in the ignored set", async () => {
		await mkdir(join(root, "src"), { recursive: true })
		await writeFile(join(root, "src", "a.ts"), "12345") // 5
		await writeFile(join(root, "src", "ignored.ts"), "1234567890") // 10
		const total = await estimateUploadBytes(root, new Set(["src/ignored.ts"]))
		expect(total).toBe(5)
	})

	it("skips symlinks regardless of target size", async () => {
		await writeFile(join(root, "real.txt"), "12345")
		await symlink(join(root, "real.txt"), join(root, "link.txt"))
		const total = await estimateUploadBytes(root, new Set())
		expect(total).toBe(5)
	})

	it("throws when the abort signal is already aborted", async () => {
		await writeFile(join(root, "a.txt"), "x")
		const controller = new AbortController()
		controller.abort()
		await expect(estimateUploadBytes(root, new Set(), controller.signal)).rejects.toThrow()
	})

	it("does not crash when the source directory is missing", async () => {
		const total = await estimateUploadBytes(join(root, "nonexistent"), new Set())
		expect(total).toBe(0)
	})
})

describe("sumIncludeListBytes", () => {
	let root: string

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "kimchi-sumlist-"))
	})

	afterEach(async () => {
		await rm(root, { recursive: true, force: true })
	})

	it("returns the sum of stat sizes for every listed file", async () => {
		await mkdir(join(root, "src"), { recursive: true })
		await writeFile(join(root, "src", "a.ts"), "12345") // 5
		await writeFile(join(root, "src", "b.ts"), "67890123") // 8
		await writeFile(join(root, "README.md"), "x".repeat(100)) // 100
		const total = await sumIncludeListBytes(root, ["src/a.ts", "src/b.ts", "README.md"])
		expect(total).toBe(113)
	})

	it("returns 0 for an empty list", async () => {
		expect(await sumIncludeListBytes(root, [])).toBe(0)
	})

	it("silently skips missing entries", async () => {
		await writeFile(join(root, "exists.txt"), "abcdef") // 6
		const total = await sumIncludeListBytes(root, ["exists.txt", "ghost.txt"])
		expect(total).toBe(6)
	})

	it("throws when the abort signal is already aborted", async () => {
		const controller = new AbortController()
		controller.abort()
		await expect(sumIncludeListBytes(root, ["x"], controller.signal)).rejects.toThrow()
	})
})
