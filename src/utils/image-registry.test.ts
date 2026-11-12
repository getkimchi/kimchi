import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	__resetImageRegistryForTest,
	addImage,
	clearSessionImages,
	getAllImages,
	getImagesByIds,
	parseImageReferences,
	resolveImageContentById,
	setImageCacheDir,
} from "./image-registry.js"

const SESSION = "session-a"
const OTHER_SESSION = "session-b"

function makeImage(
	data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
) {
	return { type: "image" as const, data, mimeType: "image/png" }
}

describe("image-registry", () => {
	let dir: string
	let otherDir: string

	beforeEach(() => {
		__resetImageRegistryForTest()
		dir = mkdtempSync(join(tmpdir(), "imgreg-test-"))
		otherDir = mkdtempSync(join(tmpdir(), "imgreg-test-b-"))
		setImageCacheDir(SESSION, dir)
		clearSessionImages(SESSION)
		// clearSessionImages recreates the dir, so re-point in case it changed
		setImageCacheDir(SESSION, dir)
	})

	afterEach(() => {
		clearSessionImages(SESSION)
		clearSessionImages(OTHER_SESSION)
		__resetImageRegistryForTest()
		try {
			rmSync(dir, { recursive: true, force: true })
			rmSync(otherDir, { recursive: true, force: true })
		} catch {
			// ignore
		}
	})

	it("resolveImageContentById reconstructs the registered image from its cached file", () => {
		addImage(SESSION, 7, makeImage())
		expect(resolveImageContentById(SESSION, 7)).toEqual({ kind: "ok", image: makeImage() })
	})

	it("resolveImageContentById distinguishes unknown ids from missing files", () => {
		expect(resolveImageContentById(SESSION, 3)).toEqual({ kind: "unknown" })
		const entry = addImage(SESSION, 4, makeImage())
		rmSync(entry.path)
		expect(resolveImageContentById(SESSION, 4)).toEqual({ kind: "missing-file", path: entry.path })
	})

	it("resolveImageContentById reports a read error for an unreadable registered path", () => {
		const entry = addImage(SESSION, 5, makeImage())
		// A directory at the file's path makes readFileSync throw EISDIR.
		rmSync(entry.path)
		mkdirSync(entry.path, { recursive: true })
		const result = resolveImageContentById(SESSION, 5)
		expect(result.kind).toBe("read-error")
	})

	it("writes a file on addImage and registers the entry with its owning session", () => {
		const entry = addImage(SESSION, 1, makeImage())
		expect(entry.id).toBe(1)
		expect(entry.sessionId).toBe(SESSION)
		expect(entry.path.endsWith("1.png")).toBe(true)
		expect(existsSync(entry.path)).toBe(true)
		expect(entry.sha1).toMatch(/^[a-f0-9]{40}$/)
	})

	it("scopes entries per session: same id in two sessions does not collide", () => {
		setImageCacheDir(OTHER_SESSION, otherDir)
		const imageA = makeImage("c2Vzc2lvbi1hLWJ5dGVz") // "session-a-bytes"
		const imageB = makeImage("c2Vzc2lvbi1iLWJ5dGVz") // "session-b-bytes"
		addImage(SESSION, 1, imageA)
		addImage(OTHER_SESSION, 1, imageB)

		expect(resolveImageContentById(SESSION, 1)).toEqual({ kind: "ok", image: imageA })
		expect(resolveImageContentById(OTHER_SESSION, 1)).toEqual({ kind: "ok", image: imageB })
	})

	it("a second session starting does not wipe the first session's registry", () => {
		setImageCacheDir(OTHER_SESSION, otherDir)
		addImage(SESSION, 1, makeImage())
		// Session B starts: extension clears only B's scope and points B at its dir.
		clearSessionImages(OTHER_SESSION)
		addImage(OTHER_SESSION, 1, makeImage("b3RoZXItYnl0ZXM="))
		// Session A's marker resolves to A's bytes, not B's.
		expect(resolveImageContentById(SESSION, 1)).toEqual({ kind: "ok", image: makeImage() })
		expect(getAllImages(SESSION)).toHaveLength(1)
	})

	it("getAllImages returns entries sorted by id", () => {
		addImage(SESSION, 3, makeImage())
		addImage(SESSION, 1, makeImage())
		addImage(SESSION, 2, makeImage())
		const all = getAllImages(SESSION)
		expect(all.map((e) => e.id)).toEqual([1, 2, 3])
	})

	it("getImagesByIds preserves caller-supplied order and skips unknown ids", () => {
		addImage(SESSION, 1, makeImage())
		addImage(SESSION, 2, makeImage())
		const got = getImagesByIds(SESSION, [2, 99, 1])
		expect(got.map((e) => e.id)).toEqual([2, 1])
	})

	it("clearSessionImages deletes the owning session's directory contents and registry only", () => {
		setImageCacheDir(OTHER_SESSION, otherDir)
		addImage(SESSION, 1, makeImage())
		addImage(SESSION, 2, makeImage())
		addImage(OTHER_SESSION, 3, makeImage())
		expect(readdirSync(dir).length).toBe(2)
		clearSessionImages(SESSION)
		expect(getAllImages(SESSION)).toEqual([])
		expect(readdirSync(dir).length).toBe(0)
		expect(getAllImages(OTHER_SESSION)).toHaveLength(1)
		expect(readdirSync(otherDir).length).toBe(1)
	})

	it("parseImageReferences extracts unique ids in order of first appearance", () => {
		expect(parseImageReferences("no images")).toEqual([])
		expect(parseImageReferences("[Image #1] foo")).toEqual([1])
		expect(parseImageReferences("[Image #2] and [Image #1]")).toEqual([2, 1])
		expect(parseImageReferences("[Image #3][Image #3][Image #5]")).toEqual([3, 5])
		expect(parseImageReferences("[Image #10] big number")).toEqual([10])
	})

	it("re-adding the same id overwrites the entry but keeps the file", () => {
		const a = addImage(SESSION, 1, makeImage())
		const b = addImage(SESSION, 1, makeImage())
		expect(b.id).toBe(1)
		expect(b.path).toBe(a.path)
		expect(getAllImages(SESSION)).toHaveLength(1)
	})
})
