import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	hasImageFileContent,
	IMAGE_EXT_TO_MIME,
	JPEG_SIGNATURE,
	MAX_IMAGE_FILE_BYTES,
	PNG_SIGNATURE,
	readImageFileFromDisk,
	sniffImageMimeType,
} from "./image-utils.js"

const PNG_MAGIC = PNG_SIGNATURE

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

describe("sniffImageMimeType", () => {
	it("detects PNG", () => {
		expect(sniffImageMimeType(new Uint8Array([...PNG_MAGIC, 0, 0, 0, 0]))).toBe("image/png")
	})

	it("detects JPEG", () => {
		expect(sniffImageMimeType(new Uint8Array([...JPEG_SIGNATURE, 0xe0]))).toBe("image/jpeg")
	})

	it("detects GIF87a and GIF89a", () => {
		expect(sniffImageMimeType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]))).toBe("image/gif")
		expect(sniffImageMimeType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe("image/gif")
	})

	it("detects WEBP", () => {
		expect(sniffImageMimeType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe(
			"image/webp",
		)
	})

	it("rejects non-image payloads", () => {
		expect(sniffImageMimeType(new TextEncoder().encode("%PDF-1.7\n"))).toBeNull()
		expect(sniffImageMimeType(new TextEncoder().encode("hello world"))).toBeNull()
		expect(sniffImageMimeType(new Uint8Array(0))).toBeNull()
	})

	it("rejects truncated signatures", () => {
		expect(sniffImageMimeType(new Uint8Array([0x89, 0x50]))).toBeNull()
		expect(sniffImageMimeType(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBeNull()
		expect(sniffImageMimeType(new Uint8Array([0x52, 0x49, 0x46, 0x46]))).toBeNull()
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
		writeFileSync(path, Buffer.from(PNG_MAGIC))
		const result = readImageFileFromDisk(path)
		expect(result).not.toBeNull()
		expect(result?.mimeType).toBe("image/png")
		expect(result?.bytes.length).toBe(8)
	})

	it("rejects an image extension whose content is not an image (renamed PDF)", () => {
		const path = join(tmpDir, "renamed.png")
		writeFileSync(path, "%PDF-1.7\n%\u00e2\u00e3\u00cf\u00d3\n1 0 obj\n<</Type/Catalog")
		expect(readImageFileFromDisk(path)).toBeNull()
	})

	describe("hasImageFileContent", () => {
		it("is true for image content, false for non-image content, null when undecidable", () => {
			const real = join(tmpDir, "real.png")
			writeFileSync(real, Buffer.from(PNG_MAGIC))
			expect(hasImageFileContent(real)).toBe(true)

			const renamed = join(tmpDir, "renamed.png")
			writeFileSync(renamed, "%PDF-1.7\n1 0 obj\n<</Type/Catalog")
			expect(hasImageFileContent(renamed)).toBe(false)

			expect(hasImageFileContent(join(tmpDir, "missing.png"))).toBeNull()
		})
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
