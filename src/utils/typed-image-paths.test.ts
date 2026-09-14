import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { extractTypedImagePaths } from "./typed-image-paths.js"

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47])

describe("extractTypedImagePaths", () => {
	let tmpDir: string
	let imgPath: string

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "typed-img-"))
		imgPath = join(tmpDir, "a.png")
		writeFileSync(imgPath, PNG_BYTES)
	})

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
		vi.unstubAllEnvs()
	})

	it("attaches an absolute path", () => {
		const matches = extractTypedImagePaths(`what is ${imgPath}`, tmpDir)
		expect(matches).toHaveLength(1)
		expect(matches[0].resolvedPath).toBe(imgPath)
		expect(matches[0].image.mimeType).toBe("image/png")
		expect(Buffer.from(matches[0].image.bytes)).toEqual(PNG_BYTES)
	})

	it("expands ~/ paths using HOME", () => {
		vi.stubEnv("HOME", tmpDir)
		const matches = extractTypedImagePaths("look at ~/a.png", tmpDir)
		expect(matches).toHaveLength(1)
		expect(matches[0].resolvedPath).toBe(imgPath)
	})

	it("resolves relative paths against cwd", () => {
		const matches = extractTypedImagePaths("open a.png please", tmpDir)
		expect(matches).toHaveLength(1)
		expect(matches[0].resolvedPath).toBe(imgPath)
	})

	it("attaches quoted paths containing spaces", () => {
		const spacedPath = join(tmpDir, "my cat.jpg")
		writeFileSync(spacedPath, PNG_BYTES)
		const matches = extractTypedImagePaths(`"${spacedPath}" what is this?`, tmpDir)
		expect(matches).toHaveLength(1)
		expect(matches[0].resolvedPath).toBe(spacedPath)
		expect(matches[0].image.mimeType).toBe("image/jpeg")
	})

	it("attaches single-quoted paths", () => {
		const spacedPath = join(tmpDir, "my cat.png")
		writeFileSync(spacedPath, PNG_BYTES)
		const matches = extractTypedImagePaths(`check '${spacedPath}' now`, tmpDir)
		expect(matches).toHaveLength(1)
	})

	it("attaches multiple paths in first-appearance order", () => {
		const webpPath = join(tmpDir, "b.webp")
		writeFileSync(webpPath, PNG_BYTES)
		const matches = extractTypedImagePaths(`${imgPath} and then ${webpPath}`, tmpDir)
		expect(matches.map((m) => m.resolvedPath)).toEqual([imgPath, webpPath])
	})

	it("attaches a duplicated path only once", () => {
		const matches = extractTypedImagePaths(`${imgPath} is the same as ${imgPath}`, tmpDir)
		expect(matches).toHaveLength(1)
	})

	it("strips trailing sentence punctuation from bare prose tokens", () => {
		const matches = extractTypedImagePaths(`is ${imgPath}? really, ${imgPath}.`, tmpDir)
		expect(matches).toHaveLength(1)
		expect(matches[0].resolvedPath).toBe(imgPath)
	})

	it("strips parentheses wrapping a path in prose", () => {
		const matches = extractTypedImagePaths(`look (${imgPath}) here`, tmpDir)
		expect(matches).toHaveLength(1)
	})

	it("matches uppercase extensions", () => {
		const upperPath = join(tmpDir, "B.JPG")
		writeFileSync(upperPath, PNG_BYTES)
		const matches = extractTypedImagePaths(`open ${upperPath}`, tmpDir)
		expect(matches).toHaveLength(1)
		expect(matches[0].image.mimeType).toBe("image/jpeg")
	})

	it("ignores non-image extensions", () => {
		const txtPath = join(tmpDir, "notes.txt")
		writeFileSync(txtPath, "hello")
		expect(extractTypedImagePaths(`read ${txtPath}`, tmpDir)).toEqual([])
	})

	it("ignores URLs even when a same-named local file exists", () => {
		expect(extractTypedImagePaths("see https://example.com/a.png", tmpDir)).toEqual([])
	})

	it("ignores file:// URIs", () => {
		expect(extractTypedImagePaths(`see file://${imgPath}`, tmpDir)).toEqual([])
	})

	it("ignores paths that do not exist", () => {
		expect(extractTypedImagePaths(`open ${join(tmpDir, "nope.png")}`, tmpDir)).toEqual([])
	})

	it("ignores directories with image-like names", () => {
		const dirPath = join(tmpDir, "dir.png")
		mkdirSync(dirPath)
		expect(extractTypedImagePaths(`open ${dirPath}`, tmpDir)).toEqual([])
	})

	it("attaches paths inside inline code spans", () => {
		const matches = extractTypedImagePaths(`open \`${imgPath}\` please`, tmpDir)
		expect(matches).toHaveLength(1)
	})

	it("handles CRLF line endings", () => {
		const matches = extractTypedImagePaths(`see ${imgPath}\r\nnext line`, tmpDir)
		expect(matches).toHaveLength(1)
	})

	it("returns an empty list for text without paths", () => {
		expect(extractTypedImagePaths("hello world", tmpDir)).toEqual([])
	})
})
