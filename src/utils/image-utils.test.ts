import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { IMAGE_EXT_TO_MIME, MAX_IMAGE_FILE_BYTES, readImageFileFromDisk } from "./image-utils.js"

describe("IMAGE_EXT_TO_MIME", () => {
	it("maps known extensions", () => {
		expect(IMAGE_EXT_TO_MIME[".png"]).toBe("image/png")
		expect(IMAGE_EXT_TO_MIME[".jpg"]).toBe("image/jpeg")
		expect(IMAGE_EXT_TO_MIME[".jpeg"]).toBe("image/jpeg")
		expect(IMAGE_EXT_TO_MIME[".gif"]).toBe("image/gif")
		expect(IMAGE_EXT_TO_MIME[".webp"]).toBe("image/webp")
	})

	it("returns undefined for unknown extensions", () => {
		expect(IMAGE_EXT_TO_MIME[".txt"]).toBeUndefined()
		expect(IMAGE_EXT_TO_MIME[".pdf"]).toBeUndefined()
	})
})

describe("readImageFileFromDisk", () => {
	let tmpDir: string
	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "img-"))
	})
	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true })
	})

	it("reads a valid image file", () => {
		const path = join(tmpDir, "test.png")
		writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
		const result = readImageFileFromDisk(path)
		expect(result).not.toBeNull()
		expect(result?.mimeType).toBe("image/png")
		expect(result?.bytes.length).toBe(4)
	})

	it("rejects non-image extensions", () => {
		const path = join(tmpDir, "test.txt")
		writeFileSync(path, "hello")
		const result = readImageFileFromDisk(path)
		expect(result).toBeNull()
	})

	it("rejects oversized files", () => {
		const path = join(tmpDir, "huge.png")
		writeFileSync(path, Buffer.alloc(MAX_IMAGE_FILE_BYTES + 1, 0xff))
		const result = readImageFileFromDisk(path)
		expect(result).toBeNull()
	})

	it("rejects missing files", () => {
		const result = readImageFileFromDisk(join(tmpDir, "nonexistent.png"))
		expect(result).toBeNull()
	})
})
