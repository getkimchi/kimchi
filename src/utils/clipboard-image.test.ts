import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Mock the native clipboard harness so we can control what getNativeClipboard returns.
const { mockGetNativeClipboard } = vi.hoisted(() => ({
	mockGetNativeClipboard: vi.fn<() => { clipboard: unknown; error: string | null }>(),
}))

vi.mock("./clipboard-native-harness.js", () => ({
	getNativeClipboard: mockGetNativeClipboard,
}))

// We need to mock the platform since readClipboardImage checks it.
// We'll mock process.platform indirectly through the options parameter.
import { readClipboardImage } from "./clipboard-image.js"

describe("readClipboardImage", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		// Reset platform to linux for these tests so we hit the native clipboard path
		Object.defineProperty(process, "platform", { value: "linux", configurable: true })
		vi.stubEnv("TERMUX_VERSION", "")
		vi.stubEnv("DISPLAY", ":0")
		vi.stubEnv("WAYLAND_DISPLAY", "")
	})

	describe("readClipboardImageViaNativeClipboard - public.file-url handling", () => {
		/**
		 * When a file is copied in Finder (Cmd+C), macOS puts both
		 * "public.file-url" and a "public.jpeg" (the Finder thumbnail/preview)
		 * on the pasteboard. hasImage() returns true for the thumbnail, but
		 * getImageBinary() returns the icon/thumbnail data -- not the actual
		 * image file.
		 *
		 * The fix: check availableFormats() for "public.file-url" and return
		 * null so the AppleScript fallback in clipboard-read.ts can resolve
		 * the actual file path.
		 */
		it("returns null when availableFormats includes public.file-url (file copy in Finder)", async () => {
			const mockClipboard = {
				hasImage: vi.fn().mockReturnValue(true),
				getImageBinary: vi.fn().mockResolvedValue(new Uint8Array([0x89, 0x50, 0x4e, 0x47])), // PNG header
				availableFormats: vi.fn().mockReturnValue(["public.jpeg", "public.file-url"]),
			}
			mockGetNativeClipboard.mockReturnValue({ clipboard: mockClipboard, error: null })

			const result = await readClipboardImage({ platform: "darwin" })

			// Should return null to trigger AppleScript fallback
			expect(result).toBeNull()
			// getImageBinary should NOT have been called since we detect file-url first
			expect(mockClipboard.getImageBinary).not.toHaveBeenCalled()
		})

		it("returns image data when availableFormats does NOT include public.file-url", async () => {
			const pngData = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
			const mockClipboard = {
				hasImage: vi.fn().mockReturnValue(true),
				getImageBinary: vi.fn().mockResolvedValue(pngData),
				availableFormats: vi.fn().mockReturnValue(["public.png", "public.tiff"]),
			}
			mockGetNativeClipboard.mockReturnValue({ clipboard: mockClipboard, error: null })

			const result = await readClipboardImage({ platform: "darwin" })

			expect(result).toEqual({ bytes: pngData, mimeType: "image/png" })
		})

		it("returns image data when availableFormats returns an empty array", async () => {
			const pngData = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
			const mockClipboard = {
				hasImage: vi.fn().mockReturnValue(true),
				getImageBinary: vi.fn().mockResolvedValue(pngData),
				availableFormats: vi.fn().mockReturnValue([]),
			}
			mockGetNativeClipboard.mockReturnValue({ clipboard: mockClipboard, error: null })

			const result = await readClipboardImage({ platform: "darwin" })

			expect(result).toEqual({ bytes: pngData, mimeType: "image/png" })
		})

		it("returns image data when availableFormats is not present (older addon)", async () => {
			const pngData = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
			const mockClipboard = {
				hasImage: vi.fn().mockReturnValue(true),
				getImageBinary: vi.fn().mockResolvedValue(pngData),
				// No availableFormats method - simulates older addon versions
			}
			mockGetNativeClipboard.mockReturnValue({ clipboard: mockClipboard, error: null })

			const result = await readClipboardImage({ platform: "darwin" })

			expect(result).toEqual({ bytes: pngData, mimeType: "image/png" })
		})

		it("returns null when no native clipboard is available", async () => {
			mockGetNativeClipboard.mockReturnValue({ clipboard: null, error: "no native clipboard" })

			const result = await readClipboardImage({ platform: "darwin" })

			expect(result).toBeNull()
		})

		it("returns null when getImageBinary returns empty data", async () => {
			const mockClipboard = {
				hasImage: vi.fn().mockReturnValue(true),
				getImageBinary: vi.fn().mockResolvedValue(new Uint8Array()),
				availableFormats: vi.fn().mockReturnValue(["public.png"]),
			}
			mockGetNativeClipboard.mockReturnValue({ clipboard: mockClipboard, error: null })

			const result = await readClipboardImage({ platform: "darwin" })

			expect(result).toBeNull()
		})
	})
})
