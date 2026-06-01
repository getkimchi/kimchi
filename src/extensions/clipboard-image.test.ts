import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// All mock functions must be vi.hoisted — vi.mock is hoisted and its factory
// runs before any imports, so it cannot reference module-level consts below it.
// vi.hoisted runs first so the mocks exist when the factory executes.
const {
	mockSetPendingImageIndicator,
	mockGetNativeClipboard,
	mockGetAvailableModels,
	mockAddImage,
	mockClearAllImages,
	mockSetImageCacheDir,
	mockExecFile,
} = vi.hoisted(() => ({
	mockSetPendingImageIndicator: vi.fn(),
	mockGetNativeClipboard: vi.fn(),
	mockGetAvailableModels: vi.fn(),
	mockAddImage: vi.fn(),
	mockClearAllImages: vi.fn(),
	mockSetImageCacheDir: vi.fn(),
	mockExecFile: vi.fn(),
}))

vi.mock("node:child_process", () => ({
	execFile: mockExecFile,
}))

vi.mock("./ui.js", () => ({
	setPasteImageHandler: vi.fn(),
	setPendingImageIndicator: mockSetPendingImageIndicator,
}))

vi.mock("../utils/clipboard-native-harness.js", () => ({
	getNativeClipboard: mockGetNativeClipboard,
}))

vi.mock("../startup-context.js", () => ({
	getAvailableModels: mockGetAvailableModels,
}))

vi.mock("../utils/image-registry.js", () => ({
	addImage: mockAddImage,
	clearAllImages: mockClearAllImages,
	setImageCacheDir: mockSetImageCacheDir,
}))

import type { ImageContent } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import clipboardImageExtension from "./clipboard-image.js"

type Handlers = Record<string, (...args: unknown[]) => unknown>

function makeMockCtx(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	return {
		model: { id: "glm-4", slug: "glm-4", input_modalities: ["text", "image"] as string[] },
		ui: { notify: vi.fn(), setStatus: vi.fn() },
		...overrides,
	} as unknown as ExtensionContext
}

function makeMockPi(): ExtensionAPI & { _handlers: Handlers } {
	const handlers: Handlers = {}
	return {
		_handlers: handlers,
		on: (event: string, handler: (...args: unknown[]) => unknown) => {
			handlers[event] = handler
			return { off: () => {} } as unknown as ExtensionAPI
		},
		registerTool: vi.fn(),
		sendMessage: vi.fn(),
		appendEntry: vi.fn(),
	} as unknown as ExtensionAPI & { _handlers: Handlers }
}

function callInputHandler(pi: ExtensionAPI & { _handlers: Handlers }, event: { text: string; images: ImageContent[] }) {
	return (pi._handlers.input as (e: { text: string; images: ImageContent[] }) => unknown)(event)
}

describe("clipboard-image extension", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.useFakeTimers()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	describe("input transform", () => {
		it("returns transform with [Image #N] prefix when images are attached", () => {
			const pi = makeMockPi()
			clipboardImageExtension(pi)

			const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc123" }]
			const result = callInputHandler(pi, { text: "hello", images })

			expect(result).toMatchObject({
				action: "transform",
				text: expect.stringContaining("[Image #1]"),
				images: expect.arrayContaining(images),
			})
		})

		it("does not call addImage when no images are present", () => {
			const pi = makeMockPi()
			clipboardImageExtension(pi)

			callInputHandler(pi, { text: "hello", images: [] })

			// Early return when no images — addImage must not be called.
			expect(mockAddImage).not.toHaveBeenCalled()
		})

		it("returns undefined (no transform) when no text and no images", () => {
			const pi = makeMockPi()
			clipboardImageExtension(pi)

			const result = callInputHandler(pi, { text: "", images: [] })
			expect(result).toBeUndefined()
		})

		it("second input increments the counter and labels the next image correctly", () => {
			// imageCounter persists across calls in the same module session.
			// Previous test already incremented it to 1. The next image should be #2.
			const pi = makeMockPi()
			clipboardImageExtension(pi)

			const result = callInputHandler(pi, {
				text: "second",
				images: [{ type: "image", mimeType: "image/png", data: "bbb" }],
			})
			const text = (result as { text: string }).text
			// Counter was at 1 from previous test, so startIndex = 2 → #2
			expect(text).toContain("[Image #2]")
			expect(text).not.toContain("[Image #1]") // not the first image anymore
		})

		it("multiple images in the same turn get sequential markers from the current counter position", () => {
			// Counter is already at 2 from previous tests. With 2 new images:
			// startIndex = 3, so markers should be #3 and #4
			const pi = makeMockPi()
			clipboardImageExtension(pi)

			const images: ImageContent[] = [
				{ type: "image", mimeType: "image/png", data: "aaa" },
				{ type: "image", mimeType: "image/jpeg", data: "bbb" },
			]
			const result = callInputHandler(pi, { text: "check both", images })

			const text = (result as { text: string }).text
			expect(text).toContain("[Image #3]")
			expect(text).toContain("[Image #4]")
		})

		it("indicator shows clipboard hint (not 📎) immediately after images are submitted", () => {
			mockGetAvailableModels.mockReturnValue([{ slug: "glm-4", input_modalities: ["text", "image"] }])
			mockGetNativeClipboard.mockReturnValue({
				clipboard: { hasImage: () => true, availableFormats: () => [] },
				error: null,
			})

			const pi = makeMockPi()
			clipboardImageExtension(pi)
			;(pi._handlers.session_start as (e: unknown, ctx: ExtensionContext) => void)(void 0, makeMockCtx())

			const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc123" }]
			callInputHandler(pi, { text: "look at this", images })

			// After submit, pendingImages is empty. clipboardHasImage is true, so the
			// clipboard hint takes over immediately — no 📎 lingering on screen.
			const calls = mockSetPendingImageIndicator.mock.calls
			const lastCall = calls[calls.length - 1][0]
			expect(lastCall).toBe("Image in clipboard · ctrl+v to paste")
		})

		it("indicator clears to null after images are submitted when clipboard is empty", () => {
			mockGetAvailableModels.mockReturnValue([{ slug: "glm-4", input_modalities: ["text", "image"] }])
			mockGetNativeClipboard.mockReturnValue({
				clipboard: { hasImage: () => false, availableFormats: () => [] },
				error: null,
			})
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			;(pi._handlers.session_start as (e: unknown, ctx: ExtensionContext) => void)(void 0, makeMockCtx())

			const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc123" }]
			callInputHandler(pi, { text: "message", images })

			const calls = mockSetPendingImageIndicator.mock.calls
			expect(calls[calls.length - 1][0]).toBeNull()
		})
	})

	describe("proactive clipboard polling", () => {
		const realPlatform = process.platform

		beforeEach(() => {
			vi.clearAllMocks()
			mockGetAvailableModels.mockReturnValue([{ slug: "glm-4", input_modalities: ["text", "image"] }])
			Object.defineProperty(process, "platform", { value: "darwin" })
		})

		afterEach(() => {
			Object.defineProperty(process, "platform", { value: realPlatform })
		})

		it("shows hint when clipboard contains an image", () => {
			mockGetNativeClipboard.mockReturnValue({
				clipboard: { hasImage: () => true, availableFormats: () => [] },
				error: null,
			})

			const pi = makeMockPi()
			clipboardImageExtension(pi)
			;(pi._handlers.session_start as (e: unknown, ctx: ExtensionContext) => void)(void 0, makeMockCtx())

			expect(mockSetPendingImageIndicator).toHaveBeenCalledWith("Image in clipboard · ctrl+v to paste")
		})

		it("does not duplicate indicator on repeated polls", () => {
			mockGetNativeClipboard.mockReturnValue({
				clipboard: { hasImage: () => true, availableFormats: () => [] },
				error: null,
			})

			const pi = makeMockPi()
			clipboardImageExtension(pi)
			;(pi._handlers.session_start as (e: unknown, ctx: ExtensionContext) => void)(void 0, makeMockCtx())

			// session_start fires updateIndicator() (null reset) then checkClipboard() (hint) — 2 calls total.
			expect(mockSetPendingImageIndicator).toHaveBeenCalledTimes(2)

			// Two timer ticks pass with image still present — no additional calls.
			vi.advanceTimersByTime(1000)
			expect(mockSetPendingImageIndicator).toHaveBeenCalledTimes(2)
		})

		it("detects images via availableFormats fallback when hasImage returns false", () => {
			mockGetNativeClipboard.mockReturnValue({
				clipboard: {
					hasImage: () => false,
					availableFormats: () => ["public.jpeg"],
				},
				error: null,
			})

			const pi = makeMockPi()
			clipboardImageExtension(pi)
			;(pi._handlers.session_start as (e: unknown, ctx: ExtensionContext) => void)(void 0, makeMockCtx())

			// session_start fires checkClipboard → hasImage is false, but fallback detects JPEG.
			expect(mockSetPendingImageIndicator).toHaveBeenCalledWith("Image in clipboard · ctrl+v to paste")
		})

		it("survives when availableFormats throws", () => {
			mockGetNativeClipboard.mockReturnValue({
				clipboard: {
					hasImage: () => false,
					availableFormats: () => {
						throw new Error("pasteboard unavailable")
					},
				},
				error: null,
			})

			const pi = makeMockPi()
			clipboardImageExtension(pi)
			;(pi._handlers.session_start as (e: unknown, ctx: ExtensionContext) => void)(void 0, makeMockCtx())

			// Should not throw — timer keeps running.
			expect(() => vi.advanceTimersByTime(2000)).not.toThrow()
			// No hint shown since both hasImage and fallback failed.
			expect(mockSetPendingImageIndicator).not.toHaveBeenCalledWith("Image in clipboard · ctrl+v to paste")
		})

		it("stops polling on session_shutdown", () => {
			mockGetNativeClipboard.mockReturnValue({
				clipboard: { hasImage: () => true, availableFormats: () => [] },
				error: null,
			})

			const pi = makeMockPi()
			clipboardImageExtension(pi)
			;(pi._handlers.session_start as (e: unknown, ctx: ExtensionContext) => void)(void 0, makeMockCtx())

			vi.advanceTimersByTime(1000)
			const countBeforeShutdown = mockSetPendingImageIndicator.mock.calls.length

			// Trigger session_shutdown.
			;(pi._handlers.session_shutdown as () => void)()
			vi.advanceTimersByTime(2000)

			// Only one additional call from the shutdown handler.
			expect(mockSetPendingImageIndicator.mock.calls.length).toBe(countBeforeShutdown + 1)
			expect(mockSetPendingImageIndicator).toHaveBeenLastCalledWith(null)
		})

		it("shows hint when an image file is copied in Finder", async () => {
			mockGetAvailableModels.mockReturnValue([{ slug: "glm-4", input_modalities: ["text", "image"] }])
			mockGetNativeClipboard.mockReturnValue({
				clipboard: {
					hasImage: () => true,
					availableFormats: () => ["public.file-url", "public.jpeg"],
				},
				error: null,
			})
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string) => void) => {
					cb(null, "/Users/user/photo.jpg\n")
				},
			)

			const pi = makeMockPi()
			clipboardImageExtension(pi)
			;(pi._handlers.session_start as (e: unknown, ctx: ExtensionContext) => void)(void 0, makeMockCtx())

			// isFinderImageFileCopy is async — flush microtasks so the .then() runs.
			await Promise.resolve()

			expect(mockSetPendingImageIndicator).toHaveBeenCalledWith("Image in clipboard · ctrl+v to paste")
		})

		it("does not show hint when a non-image file is copied in Finder", async () => {
			mockGetAvailableModels.mockReturnValue([{ slug: "glm-4", input_modalities: ["text", "image"] }])
			mockGetNativeClipboard.mockReturnValue({
				clipboard: {
					// macOS puts a thumbnail alongside the file URL; hasImage() returns true for it.
					hasImage: () => true,
					availableFormats: () => ["public.file-url", "public.png"],
				},
				error: null,
			})
			mockExecFile.mockImplementation(
				(_cmd: string, _args: string[], _opts: unknown, cb: (err: null, stdout: string) => void) => {
					cb(null, "/Users/user/document.pdf\n")
				},
			)

			const pi = makeMockPi()
			clipboardImageExtension(pi)
			;(pi._handlers.session_start as (e: unknown, ctx: ExtensionContext) => void)(void 0, makeMockCtx())

			await Promise.resolve()

			expect(mockSetPendingImageIndicator).not.toHaveBeenCalledWith("Image in clipboard · ctrl+v to paste")
		})

		it("does not show hint when model does not support images", () => {
			mockGetAvailableModels.mockReturnValue([{ slug: "text-only", input_modalities: ["text"] }])
			mockGetNativeClipboard.mockReturnValue({
				clipboard: { hasImage: () => true, availableFormats: () => [] },
				error: null,
			})

			const pi = makeMockPi()
			clipboardImageExtension(pi)
			;(pi._handlers.session_start as (e: unknown, ctx: ExtensionContext) => void)(void 0, makeMockCtx())

			vi.advanceTimersByTime(2000)

			expect(mockSetPendingImageIndicator).not.toHaveBeenCalledWith("Image in clipboard · ctrl+v to paste")
		})
	})
})
