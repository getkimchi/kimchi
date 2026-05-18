import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	addImage,
	clearAllImages,
	getAllImages,
	getImageCacheDir,
	getImagesByIds,
	parseImageReferences,
	setImageCacheDir,
} from "./image-registry.js"

function makeImage(
	data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
) {
	return { type: "image" as const, data, mimeType: "image/png" }
}

describe("image-registry", () => {
	let dir: string

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "imgreg-test-"))
		setImageCacheDir(dir)
		clearAllImages()
		// clearAllImages recreates the dir, so re-point in case it changed
		setImageCacheDir(dir)
	})

	afterEach(() => {
		clearAllImages()
		try {
			rmSync(dir, { recursive: true, force: true })
		} catch {
			// ignore
		}
	})

	it("writes a file on addImage and registers the entry", () => {
		const entry = addImage(1, makeImage())
		expect(entry.id).toBe(1)
		expect(entry.path.endsWith("1.png")).toBe(true)
		expect(existsSync(entry.path)).toBe(true)
		expect(entry.sha1).toMatch(/^[a-f0-9]{40}$/)
	})

	it("getAllImages returns entries sorted by id", () => {
		addImage(3, makeImage())
		addImage(1, makeImage())
		addImage(2, makeImage())
		const all = getAllImages()
		expect(all.map((e) => e.id)).toEqual([1, 2, 3])
	})

	it("getImagesByIds preserves caller-supplied order and skips unknown ids", () => {
		addImage(1, makeImage())
		addImage(2, makeImage())
		const got = getImagesByIds([2, 99, 1])
		expect(got.map((e) => e.id)).toEqual([2, 1])
	})

	it("clearAllImages deletes the directory contents and registry", () => {
		addImage(1, makeImage())
		addImage(2, makeImage())
		expect(readdirSync(dir).length).toBe(2)
		clearAllImages()
		expect(getAllImages()).toEqual([])
		expect(readdirSync(dir).length).toBe(0)
	})

	it("parseImageReferences extracts unique ids in order of first appearance", () => {
		expect(parseImageReferences("no images")).toEqual([])
		expect(parseImageReferences("[Image #1] foo")).toEqual([1])
		expect(parseImageReferences("[Image #2] and [Image #1]")).toEqual([2, 1])
		expect(parseImageReferences("[Image #3][Image #3][Image #5]")).toEqual([3, 5])
		expect(parseImageReferences("[Image #10] big number")).toEqual([10])
	})

	it("re-adding the same id overwrites the entry but keeps the file", () => {
		const a = addImage(1, makeImage())
		const b = addImage(1, makeImage())
		expect(b.id).toBe(1)
		expect(b.path).toBe(a.path)
		expect(getAllImages()).toHaveLength(1)
	})
})
