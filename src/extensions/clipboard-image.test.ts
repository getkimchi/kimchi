import { beforeEach, describe, expect, it, vi } from "vitest"

// All mock functions must be vi.hoisted — vi.mock is hoisted and its factory
// runs before any imports, so it cannot reference module-level consts below it.
// vi.hoisted runs first so the mocks exist when the factory executes.
const {
	mockSetPasteImageHandler,
	mockSetPendingImageIndicator,
	mockGetNativeClipboard,
	mockReadClipboardImage,
	mockGetAvailableModels,
	mockAddImage,
	mockClearAllImages,
	mockSetImageCacheDir,
} = vi.hoisted(() => ({
	mockSetPasteImageHandler: vi.fn(),
	mockSetPendingImageIndicator: vi.fn(),
	mockGetNativeClipboard: vi.fn(),
	mockReadClipboardImage: vi.fn(),
	mockGetAvailableModels: vi.fn(),
	mockAddImage: vi.fn(),
	mockClearAllImages: vi.fn(),
	mockSetImageCacheDir: vi.fn(),
}))

vi.mock("./ui.js", () => ({
	setPasteImageHandler: mockSetPasteImageHandler,
	setPendingImageIndicator: mockSetPendingImageIndicator,
}))

vi.mock("../utils/clipboard-native-harness.js", () => ({
	getNativeClipboard: mockGetNativeClipboard,
}))

vi.mock("../utils/clipboard-read.js", () => ({
	readClipboardImage: mockReadClipboardImage,
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
	})
})
