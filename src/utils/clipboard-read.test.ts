import { beforeEach, describe, expect, it, vi } from "vitest"

// vi.hoisted so mocks are available at module evaluation time (before vi.mock runs)
const {
	mockReadClipboardImage,
	mockReadClipboardImageViaNativeClipboard,
	mockGetNativeClipboard,
	mockReadImageFileFromDisk,
	mockHasImageFileContent,
	mockExecFileSync,
} = vi.hoisted(() => ({
	mockReadClipboardImage: vi.fn<() => Promise<{ bytes: Uint8Array; mimeType: string } | null>>(),
	mockReadClipboardImageViaNativeClipboard:
		vi.fn<(options?: { ignoreFileUrlGuard?: boolean }) => Promise<{ bytes: Uint8Array; mimeType: string } | null>>(),
	mockGetNativeClipboard: vi.fn<() => { clipboard: unknown; error: string | null }>(),
	mockReadImageFileFromDisk: vi.fn<(path: string) => { bytes: Uint8Array; mimeType: string } | null>(),
	mockHasImageFileContent: vi.fn<(path: string) => boolean | null>(),
	mockExecFileSync: vi.fn<(...args: unknown[]) => string>(),
}))

// Mock the local clipboard-image.ts which replaced the deep import.
vi.mock("./clipboard-image.js", () => ({
	readClipboardImage: mockReadClipboardImage,
	readClipboardImageViaNativeClipboard: mockReadClipboardImageViaNativeClipboard,
}))

vi.mock("./clipboard-native-harness.js", () => ({
	getNativeClipboard: mockGetNativeClipboard,
}))

vi.mock("./image-utils.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./image-utils.js")>()),
	readImageFileFromDisk: mockReadImageFileFromDisk,
	hasImageFileContent: mockHasImageFileContent,
}))

vi.mock("node:child_process", () => ({
	execFileSync: mockExecFileSync,
}))

import { readClipboardImage } from "./clipboard-read.js"

import { PNG_SIGNATURE } from "./image-utils.js"

const PNG_MAGIC = new Uint8Array(PNG_SIGNATURE)
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<</Type/Catalog/Pages")

describe("readClipboardImage", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
		vi.stubEnv("TERMUX_VERSION", "")
		vi.stubEnv("KIMCHI_TUI_E2E_CLIPBOARD_IMAGE", "")
	})

	it("reads the fixture image from the explicit TUI E2E clipboard seam", async () => {
		vi.stubEnv("KIMCHI_TUI_E2E_CLIPBOARD_IMAGE", "/tmp/fixture.png")
		mockReadImageFileFromDisk.mockReturnValue({ bytes: PNG_MAGIC, mimeType: "image/png" })

		const result = await readClipboardImage()

		expect(result).toEqual({ bytes: PNG_MAGIC, mimeType: "image/png" })
		expect(mockReadImageFileFromDisk).toHaveBeenCalledWith("/tmp/fixture.png")
		expect(mockReadClipboardImage).not.toHaveBeenCalled()
	})

	it("returns upstream result when upstream has an image and skips native fallback", async () => {
		mockReadClipboardImage.mockResolvedValue({ bytes: PNG_MAGIC, mimeType: "image/png" })

		const result = await readClipboardImage()

		expect(result).toEqual({ bytes: PNG_MAGIC, mimeType: "image/png" })
		expect(mockGetNativeClipboard).not.toHaveBeenCalled()
	})

	it("throws when upstream returns non-image bytes (e.g. a Finder-copied PDF)", async () => {
		mockReadClipboardImage.mockResolvedValue({ bytes: PDF_BYTES, mimeType: "image/png" })

		await expect(readClipboardImage()).rejects.toThrow(/not a decodable image/)
	})

	it("re-types valid payloads by content instead of trusting the claimed mime", async () => {
		const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x11])
		mockReadClipboardImage.mockResolvedValue({ bytes: jpegBytes, mimeType: "image/png" })

		const result = await readClipboardImage()

		expect(result).toEqual({ bytes: jpegBytes, mimeType: "image/jpeg" })
	})

	it("returns null on Linux when upstream returns null", async () => {
		Object.defineProperty(process, "platform", { value: "linux", configurable: true })
		mockReadClipboardImage.mockResolvedValue(null)

		const result = await readClipboardImage()

		expect(result).toBeNull()
	})

	describe("macOS Darwin fallback path", () => {
		const mockClipboard = {
			hasImage: vi.fn().mockReturnValue(false),
			getImageBinary: vi.fn().mockResolvedValue([]),
			availableFormats: vi.fn().mockReturnValue(["public.png"]),
		}

		// The Darwin AppleScript path is exercised when clipboard-read.ts detects
		// Darwin + no upstream image + native clipboard available + public.file-url format.
		// We verify it skips execFileSync when there's no file-url (reliable path).
		it("returns null and does not call execFileSync when clipboard has no public.file-url format", async () => {
			mockClipboard.availableFormats.mockReturnValue(["public.png"])
			mockReadClipboardImage.mockResolvedValue(null)
			mockGetNativeClipboard.mockReturnValue({ clipboard: mockClipboard, error: null })

			const result = await readClipboardImage()

			expect(result).toBeNull()
			expect(mockExecFileSync).not.toHaveBeenCalled()
		})

		it("returns null when native clipboard is unavailable on Darwin", async () => {
			mockReadClipboardImage.mockResolvedValue(null)
			mockGetNativeClipboard.mockReturnValue({ clipboard: null, error: "no native clipboard" })

			const result = await readClipboardImage()

			expect(result).toBeNull()
			expect(mockExecFileSync).not.toHaveBeenCalled()
		})

		it("throws without pasteboard fallback when the file is readable but not an image", async () => {
			mockReadClipboardImage.mockResolvedValue(null)
			mockClipboard.availableFormats.mockReturnValue(["public.file-url", "public.tiff"])
			mockGetNativeClipboard.mockReturnValue({ clipboard: mockClipboard, error: null })
			mockExecFileSync.mockReturnValue("/Users/test/Desktop/report.png\n")
			// The file is readable but its content is a PDF renamed to .png:
			// the pasteboard "rendering" would be Finder's placeholder icon.
			mockReadImageFileFromDisk.mockReturnValue(null)
			mockHasImageFileContent.mockReturnValue(false)

			await expect(readClipboardImage()).rejects.toThrow(/not a decodable image/)
			expect(mockReadClipboardImageViaNativeClipboard).not.toHaveBeenCalled()
		})

		it("falls back to the pasteboard when the file is undecidable (unreadable)", async () => {
			mockReadClipboardImage.mockResolvedValue(null)
			mockClipboard.availableFormats.mockReturnValue(["public.file-url", "public.tiff"])
			mockGetNativeClipboard.mockReturnValue({ clipboard: mockClipboard, error: null })
			mockExecFileSync.mockReturnValue("/Users/test/Desktop/Screenshot.png\n")
			mockReadImageFileFromDisk.mockReturnValue(null)
			mockHasImageFileContent.mockReturnValue(null)
			const pasteboardBytes = { bytes: PNG_MAGIC, mimeType: "image/png" }
			mockReadClipboardImageViaNativeClipboard.mockResolvedValue(pasteboardBytes)

			const result = await readClipboardImage()

			// Undecidable file (unreadable) — it may still be a real image, so the
			// pasteboard fallback runs and is flagged degraded.
			expect(result).toEqual({ ...pasteboardBytes, degraded: true })
			expect(mockHasImageFileContent).toHaveBeenCalledWith("/Users/test/Desktop/Screenshot.png")
		})

		it("throws when the pasteboard fallback returns non-image bytes (Finder-copied PDF)", async () => {
			mockReadClipboardImage.mockResolvedValue(null)
			mockClipboard.availableFormats.mockReturnValue(["public.file-url", "com.adobe.pdf"])
			mockGetNativeClipboard.mockReturnValue({ clipboard: mockClipboard, error: null })
			mockExecFileSync.mockReturnValue("/Users/test/Desktop/report.pdf\n")
			// .pdf is not in IMAGE_EXT_TO_MIME, so the disk read returns null and
			// the pasteboard fallback hands us the raw PDF bytes.
			mockReadImageFileFromDisk.mockReturnValue(null)
			mockReadClipboardImageViaNativeClipboard.mockResolvedValue({ bytes: PDF_BYTES, mimeType: "image/png" })

			await expect(readClipboardImage()).rejects.toThrow(/not a decodable image/)
			expect(mockReadClipboardImageViaNativeClipboard).toHaveBeenCalledWith({ ignoreFileUrlGuard: true })
		})

		it("prefers the Finder-copied file from disk when it is readable", async () => {
			mockReadClipboardImage.mockResolvedValue(null)
			mockClipboard.availableFormats.mockReturnValue(["public.file-url", "public.tiff"])
			mockGetNativeClipboard.mockReturnValue({ clipboard: mockClipboard, error: null })
			mockExecFileSync.mockReturnValue("/Users/test/Desktop/Screenshot.png\n")
			const diskBytes = { bytes: PNG_MAGIC, mimeType: "image/png" }
			mockReadImageFileFromDisk.mockReturnValue(diskBytes)

			const result = await readClipboardImage()

			// The original file was read — not a degraded pasteboard representation.
			expect(result).toEqual(diskBytes)
			expect(mockReadClipboardImageViaNativeClipboard).not.toHaveBeenCalled()
		})
	})
})
