import { beforeEach, describe, expect, it, vi } from "vitest"

// vi.hoisted so mocks are available at module evaluation time (before vi.mock runs)
const { mockReadClipboardImage, mockGetNativeClipboard, mockReadImageFileFromDisk, mockExecFileSync } = vi.hoisted(
	() => ({
		mockReadClipboardImage: vi.fn<() => Promise<{ bytes: Uint8Array; mimeType: string } | null>>(),
		mockGetNativeClipboard: vi.fn<() => { clipboard: unknown; error: string | null }>(),
		mockReadImageFileFromDisk: vi.fn<(path: string) => { bytes: Uint8Array; mimeType: string }>(),
		mockExecFileSync: vi.fn<(...args: unknown[]) => Buffer>(),
	}),
)

// Mock the local clipboard-image.ts which replaced the deep import.
vi.mock("./clipboard-image.js", () => ({
	readClipboardImage: mockReadClipboardImage,
}))

vi.mock("./clipboard-native-harness.js", () => ({
	getNativeClipboard: mockGetNativeClipboard,
}))

vi.mock("./image-utils.js", () => ({
	readImageFileFromDisk: mockReadImageFileFromDisk,
}))

vi.mock("node:child_process", () => ({
	execFileSync: mockExecFileSync,
}))

import { readClipboardImage } from "./clipboard-read.js"

describe("readClipboardImage", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		Object.defineProperty(process, "platform", { value: "darwin", configurable: true })
		vi.stubEnv("TERMUX_VERSION", "")
	})

	it("returns upstream result when upstream has an image and skips native fallback", async () => {
		mockReadClipboardImage.mockResolvedValue({ bytes: new Uint8Array([0x89, 0x50]), mimeType: "image/png" })

		const result = await readClipboardImage()

		expect(result).toEqual({ bytes: new Uint8Array([0x89, 0x50]), mimeType: "image/png" })
		expect(mockGetNativeClipboard).not.toHaveBeenCalled()
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
	})
})
