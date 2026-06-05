import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// All mock functions must be vi.hoisted — vi.mock is hoisted and its factory
// runs before any imports, so it cannot reference module-level consts below it.
// vi.hoisted runs first so the mocks exist when the factory executes.
const {
	mockSetPasteImageHandler,
	mockSetPendingImageIndicator,
	mockInsertAtCursor,
	mockGetNativeClipboard,
	mockReadClipboardImage,
	mockGetAvailableModels,
	mockAddImage,
	mockClearAllImages,
	mockSetImageCacheDir,
} = vi.hoisted(() => ({
	mockSetPasteImageHandler: vi.fn(),
	mockSetPendingImageIndicator: vi.fn(),
	mockInsertAtCursor: vi.fn(),
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
	insertAtCursor: mockInsertAtCursor,
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
		sessionManager: { getSessionDir: vi.fn().mockReturnValue(null) },
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

function callInputHandler(
	pi: ExtensionAPI & { _handlers: Handlers },
	event: { text: string; images?: ImageContent[] },
) {
	return (pi._handlers.input as (e: { text: string; images: ImageContent[] }) => unknown)({
		images: [],
		...event,
	})
}

function triggerSessionStart(pi: ExtensionAPI & { _handlers: Handlers }, ctx: ExtensionContext) {
	;(pi._handlers.session_start as (e: unknown, ctx: ExtensionContext) => void)({}, ctx)
}

/** Returns the paste handler registered at module load time. */
function getPasteHandler(): () => void {
	if (!savedPasteHandler) throw new Error("paste handler not registered")
	return savedPasteHandler
}

// The paste handler is registered once at module load; save it before
// beforeEach can clear mock history.
let savedPasteHandler: (() => void) | undefined

describe("clipboard-image extension", () => {
	beforeAll(() => {
		savedPasteHandler = mockSetPasteImageHandler.mock.calls[0]?.[0] as (() => void) | undefined
	})
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe("input transform — incoming images (PI-provided path)", () => {
		it("passes incoming images through and returns a transform", () => {
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			triggerSessionStart(pi, makeMockCtx())

			const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc123" }]
			const result = callInputHandler(pi, { text: "hello", images })

			expect(result).toMatchObject({
				action: "transform",
				images: expect.arrayContaining(images),
			})
		})

		it("registers each incoming image with addImage", () => {
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			triggerSessionStart(pi, makeMockCtx())

			const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc123" }]
			callInputHandler(pi, { text: "hello", images })

			expect(mockAddImage).toHaveBeenCalledOnce()
		})

		it("does not call addImage when no images and no markers are present", () => {
			const pi = makeMockPi()
			clipboardImageExtension(pi)

			callInputHandler(pi, { text: "hello" })

			expect(mockAddImage).not.toHaveBeenCalled()
		})

		it("returns undefined when text is empty and no images", () => {
			const pi = makeMockPi()
			clipboardImageExtension(pi)

			const result = callInputHandler(pi, { text: "" })
			expect(result).toBeUndefined()
		})
	})

	describe("input transform — 📎 marker path (paste handler)", () => {
		it("replaces a single 📎 marker with [Image #N] when its slot is filled", async () => {
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			triggerSessionStart(pi, makeMockCtx())

			// Set up clipboard
			mockGetNativeClipboard.mockReturnValue({ clipboard: {}, error: null })
			mockGetAvailableModels.mockReturnValue([{ slug: "glm-4", input_modalities: ["text", "image"] }])
			mockReadClipboardImage.mockResolvedValue({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" })

			// Trigger paste — inserts 📎 synchronously and fills slot async
			getPasteHandler()()
			expect(mockInsertAtCursor).toHaveBeenCalledWith("📎")

			// Wait for async slot fill
			await Promise.resolve()

			const result = callInputHandler(pi, { text: "📎 describe this" })
			expect(result).toMatchObject({
				action: "transform",
				text: expect.stringContaining("[Image #1]"),
			})
			expect((result as { text: string }).text).not.toContain("📎")
		})

		it("replaces multiple 📎 markers in text order", async () => {
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			triggerSessionStart(pi, makeMockCtx())

			mockGetNativeClipboard.mockReturnValue({ clipboard: {}, error: null })
			mockGetAvailableModels.mockReturnValue([{ slug: "glm-4", input_modalities: ["text", "image"] }])
			mockReadClipboardImage.mockResolvedValue({ bytes: new Uint8Array([1]), mimeType: "image/png" })

			getPasteHandler()()
			getPasteHandler()()
			await Promise.resolve()
			await Promise.resolve()

			const result = callInputHandler(pi, { text: "📎 hi 📎 there" })
			const text = (result as { text: string }).text
			expect(text).toBe("[Image #1] hi [Image #2] there")
		})

		it("strips orphaned 📎 markers whose async read failed", async () => {
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			triggerSessionStart(pi, makeMockCtx())

			mockGetNativeClipboard.mockReturnValue({ clipboard: {}, error: null })
			mockGetAvailableModels.mockReturnValue([{ slug: "glm-4", input_modalities: ["text", "image"] }])
			mockReadClipboardImage.mockResolvedValue(null) // no image found

			getPasteHandler()()
			await Promise.resolve()

			// The null slot is still in pendingImages — marker is stripped from text
			const result = callInputHandler(pi, { text: "📎 hello" })
			expect(result).toMatchObject({
				action: "transform",
				text: " hello",
				images: [],
			})
		})

		it("inserts 📎 synchronously before async read completes", () => {
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			triggerSessionStart(pi, makeMockCtx())

			mockGetNativeClipboard.mockReturnValue({ clipboard: {}, error: null })
			mockGetAvailableModels.mockReturnValue([{ slug: "glm-4", input_modalities: ["text", "image"] }])
			// Never resolves in this test — verifying sync part only
			mockReadClipboardImage.mockReturnValue(new Promise(() => {}))

			getPasteHandler()()

			// Must be called synchronously before any awaits
			expect(mockInsertAtCursor).toHaveBeenCalledWith("📎")
		})

		it("does not insert 📎 when model does not support images", () => {
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			triggerSessionStart(
				pi,
				makeMockCtx({
					model: { id: "text-only", slug: "text-only", input_modalities: ["text"] } as never,
				}),
			)

			mockGetAvailableModels.mockReturnValue([{ slug: "text-only", input_modalities: ["text"] }])

			getPasteHandler()()

			expect(mockInsertAtCursor).not.toHaveBeenCalled()
		})

		it("does not insert 📎 when native clipboard is unavailable", () => {
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			triggerSessionStart(pi, makeMockCtx())

			mockGetAvailableModels.mockReturnValue([{ slug: "glm-4", input_modalities: ["text", "image"] }])
			mockGetNativeClipboard.mockReturnValue({ clipboard: null, error: "unsupported" })

			getPasteHandler()()

			expect(mockInsertAtCursor).not.toHaveBeenCalled()
		})
	})

	describe("session_start", () => {
		it("resets imageCounter so the first image in a new session is #1", async () => {
			const pi = makeMockPi()
			clipboardImageExtension(pi)

			mockGetNativeClipboard.mockReturnValue({ clipboard: {}, error: null })
			mockGetAvailableModels.mockReturnValue([{ slug: "glm-4", input_modalities: ["text", "image"] }])
			mockReadClipboardImage.mockResolvedValue({ bytes: new Uint8Array([1]), mimeType: "image/png" })

			// First session: paste and submit to advance counter
			triggerSessionStart(pi, makeMockCtx())
			getPasteHandler()()
			await Promise.resolve()
			callInputHandler(pi, { text: "📎" })

			// New session: counter should reset
			triggerSessionStart(pi, makeMockCtx())
			getPasteHandler()()
			await Promise.resolve()

			const result = callInputHandler(pi, { text: "📎" })
			const text = (result as { text: string }).text
			expect(text).toContain("[Image #1]")
		})

		it("clears pending images on session start", async () => {
			const pi = makeMockPi()
			clipboardImageExtension(pi)

			mockGetNativeClipboard.mockReturnValue({ clipboard: {}, error: null })
			mockGetAvailableModels.mockReturnValue([{ slug: "glm-4", input_modalities: ["text", "image"] }])
			mockReadClipboardImage.mockResolvedValue({ bytes: new Uint8Array([1]), mimeType: "image/png" })

			triggerSessionStart(pi, makeMockCtx())
			getPasteHandler()() // pending slot reserved in old session's bucket
			await Promise.resolve()

			// New session creates a fresh pendingImages array; old bucket is abandoned
			triggerSessionStart(pi, makeMockCtx())

			// Submit with a 📎 — no pending slots in new session, marker stripped
			const result = callInputHandler(pi, { text: "📎" })
			expect(result).toMatchObject({ action: "transform", text: "", images: [] })
		})
	})
})
