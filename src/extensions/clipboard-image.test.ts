import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

// All mock functions must be vi.hoisted — vi.mock is hoisted and its factory
// runs before any imports, so it cannot reference module-level consts below it.
// vi.hoisted runs first so the mocks exist when the factory executes.
const {
	mockSetPendingImageIndicator,
	mockSetPasteImageHandler,
	mockGetNativeClipboard,
	mockAddImage,
	mockClearAllImages,
	mockSetImageCacheDir,
	mockExecFile,
	mockReadClipboardImage,
} = vi.hoisted(() => ({
	mockSetPendingImageIndicator: vi.fn(),
	mockSetPasteImageHandler: vi.fn(),
	mockGetNativeClipboard: vi.fn(),
	mockAddImage: vi.fn(),
	mockClearAllImages: vi.fn(),
	mockSetImageCacheDir: vi.fn(),
	mockExecFile: vi.fn(),
	mockReadClipboardImage: vi.fn(),
}))

vi.mock("node:child_process", () => ({
	execFile: mockExecFile,
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

vi.mock("../utils/image-registry.js", () => ({
	addImage: mockAddImage,
	clearAllImages: mockClearAllImages,
	setImageCacheDir: mockSetImageCacheDir,
}))

import type { Api, ImageContent, Model } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext, InputEvent } from "@earendil-works/pi-coding-agent"
import { createContext } from "./__mocks__/context.js"
import { createExtensionApi } from "./__mocks__/extension-api.js"
import clipboardImageExtension from "./clipboard-image.js"
import { __resetVisionGateForTest } from "./vision-gate.js"

type InputEventShape = Omit<InputEvent, "type">

const VISION_MODEL: Model<Api> = {
	provider: "kimchi-dev",
	id: "glm-4",
	name: "GLM 4",
	api: "openai-completions",
	baseUrl: "https://example.test",
	reasoning: false,
	contextWindow: 200_000,
	maxTokens: 16_384,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}

const TEXT_MODEL: Model<Api> = {
	...VISION_MODEL,
	id: "text-only",
	name: "Text Only",
	input: ["text"],
}

const SWITCH_TARGET: Model<Api> = {
	...VISION_MODEL,
	id: "vision-target",
	name: "Vision Target",
}

function makeMockCtx(overrides: Parameters<typeof createContext>[0] = {}): ExtensionContext {
	return createContext({
		mode: "tui",
		model: VISION_MODEL,
		modelRegistry: { getAvailable: () => [VISION_MODEL, SWITCH_TARGET] },
		getContextUsage: vi.fn(() => undefined),
		isIdle: vi.fn(() => true),
		...overrides,
	})
}

const apiHarnesses = new WeakMap<ExtensionAPI, ReturnType<typeof createExtensionApi>>()

function makeMockPi(): ExtensionAPI {
	const harness = createExtensionApi()
	apiHarnesses.set(harness.api, harness)
	return harness.api
}

function getHandler<E, R = undefined>(pi: ExtensionAPI, event: string) {
	const harness = apiHarnesses.get(pi)
	if (!harness) throw new Error("Missing extension API harness")
	return harness.getHandler<E, R>(event)
}

function startSession(pi: ExtensionAPI, ctx: ExtensionContext): void {
	getHandler<unknown, void>(pi, "session_start")(void 0, ctx)
}

function callInput(pi: ExtensionAPI, ctx: ExtensionContext, event: InputEventShape): Promise<unknown> {
	return Promise.resolve(getHandler<InputEventShape, unknown>(pi, "input")(event, ctx))
}

interface GateHarness {
	pi: ExtensionAPI
	ctx: ExtensionContext
	/** The ctx.ui.custom mock the gate's dialogs flow through. */
	custom: ReturnType<typeof vi.fn>
	/** Resolves the n-th opened dialog (0-based). */
	resolveDialog: (index: number, result: unknown) => void
}

/** Starts a session whose ctx.ui.custom captures gate dialogs for manual resolution. */
function startGateSession(options: { model?: Model<Api>; mode?: string } = {}): GateHarness {
	const pi = makeMockPi()
	const dialogResolvers: Array<(result: unknown) => void> = []
	const custom = vi.fn(
		() =>
			new Promise((resolve) => {
				dialogResolvers.push(resolve)
			}),
	)
	clipboardImageExtension(pi)
	const ctx = makeMockCtx({
		model: options.model ?? TEXT_MODEL,
		mode: (options.mode ?? "tui") as ExtensionContext["mode"],
		ui: { custom: custom as ExtensionContext["ui"]["custom"] },
	})
	startSession(pi, ctx)
	return {
		pi,
		ctx,
		custom,
		resolveDialog: (index, result) => dialogResolvers[index]?.(result),
	}
}

function fireAgentEnd(harness: GateHarness): void {
	getHandler<unknown, void>(harness.pi, "agent_end")(void 0, harness.ctx)
}

async function settle(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve()
}

function img(data: string): ImageContent {
	return { type: "image", data, mimeType: "image/png" }
}

describe("clipboard-image extension", () => {
	const realPlatform = process.platform

	// The extension registers its paste handler at module scope — before any
	// beforeEach can clear the mock — so capture the reference once in
	// beforeAll and assert it in a dedicated test so failures are attributed.
	let pasteHandler: (() => void) | undefined
	beforeAll(() => {
		pasteHandler = mockSetPasteImageHandler.mock.calls[0]?.[0] as (() => void) | undefined
	})

	it("registers its paste handler at module scope", () => {
		expect(pasteHandler).toBeTypeOf("function")
	})

	beforeEach(() => {
		// session_start clears clipboardHasImage before the indicator paint. A Darwin
		// start/shutdown drops a stale proactive hint without reading the clipboard.
		Object.defineProperty(process, "platform", { value: "darwin" })
		mockGetNativeClipboard.mockReturnValue({
			clipboard: { hasImage: () => false, availableFormats: () => [] },
			error: null,
		})
		const resetPi = makeMockPi()
		clipboardImageExtension(resetPi)
		getHandler<unknown, void>(resetPi, "session_start")(void 0, makeMockCtx())
		getHandler<unknown, void>(resetPi, "session_shutdown")(void 0, makeMockCtx())
		__resetVisionGateForTest()
		vi.clearAllMocks()
		vi.useFakeTimers()
	})

	afterEach(() => {
		Object.defineProperty(process, "platform", { value: realPlatform })
		vi.useRealTimers()
	})

	describe("input transform", () => {
		it("returns transform with [Image #N] prefix when images are attached", async () => {
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			const ctx = makeMockCtx()
			startSession(pi, ctx)

			const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc123" }]
			const result = await callInput(pi, ctx, { text: "hello", images, source: "interactive" })

			expect(result).toMatchObject({
				action: "transform",
				text: expect.stringContaining("[Image #1]"),
				images: expect.arrayContaining(images),
			})
		})

		it("does not call addImage when no images are present", async () => {
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			const ctx = makeMockCtx()
			startSession(pi, ctx)

			await callInput(pi, ctx, { text: "hello", images: [], source: "interactive" })

			// Early return when no images — addImage must not be called.
			expect(mockAddImage).not.toHaveBeenCalled()
		})

		it("returns undefined (no transform) when no text and no images", async () => {
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			const ctx = makeMockCtx()
			startSession(pi, ctx)

			const result = await callInput(pi, ctx, { text: "", images: [], source: "interactive" })
			expect(result).toBeUndefined()
		})

		it("counter accumulates across submissions within a session", async () => {
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			const ctx = makeMockCtx()
			startSession(pi, ctx)

			await callInput(pi, ctx, {
				text: "first",
				images: [{ type: "image", mimeType: "image/png", data: "aaa" }],
				source: "interactive",
			})

			const result = (await callInput(pi, ctx, {
				text: "second",
				images: [{ type: "image", mimeType: "image/png", data: "bbb" }],
				source: "interactive",
			})) as { text: string }
			expect(result.text).toContain("[Image #2]")
		})

		it("multiple images in the same turn get sequential markers", async () => {
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			const ctx = makeMockCtx()
			startSession(pi, ctx)

			await callInput(pi, ctx, {
				text: "setup",
				images: [
					{ type: "image", mimeType: "image/png", data: "aaa" },
					{ type: "image", mimeType: "image/jpeg", data: "bbb" },
				],
				source: "interactive",
			})

			const result = (await callInput(pi, ctx, {
				text: "check both",
				images: [
					{ type: "image", mimeType: "image/png", data: "ccc" },
					{ type: "image", mimeType: "image/jpeg", data: "ddd" },
				],
				source: "interactive",
			})) as { text: string }
			expect(result.text).toContain("[Image #3]")
			expect(result.text).toContain("[Image #4]")
		})

		it("indicator shows clipboard hint (not 📎) immediately after images are submitted", async () => {
			// Proactive hint is Windows-only. Darwin no longer polls, so this
			// assertion cannot run on the default platform.
			Object.defineProperty(process, "platform", { value: "win32" })
			mockGetNativeClipboard.mockReturnValue({
				clipboard: { hasImage: () => true, availableFormats: () => [] },
				error: null,
			})

			const pi = makeMockPi()
			clipboardImageExtension(pi)
			const ctx = makeMockCtx()
			startSession(pi, ctx)

			const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc123" }]
			await callInput(pi, ctx, { text: "look at this", images, source: "interactive" })

			const calls = mockSetPendingImageIndicator.mock.calls
			const lastCall = calls[calls.length - 1][0]
			expect(lastCall).toBe("Image in clipboard · ctrl+v to paste")
			getHandler<unknown, void>(pi, "session_shutdown")(void 0, ctx)
		})

		it("leaves no clipboard hint after a Darwin submission when the pasteboard has an image", async () => {
			Object.defineProperty(process, "platform", { value: "darwin" })
			const hasImage = vi.fn(() => true)
			const availableFormats = vi.fn(() => ["public.png", "public.file-url"])
			mockGetNativeClipboard.mockReturnValue({
				clipboard: { hasImage, availableFormats },
				error: null,
			})

			const pi = makeMockPi()
			clipboardImageExtension(pi)
			const ctx = makeMockCtx()
			startSession(pi, ctx)

			const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc123" }]
			await callInput(pi, ctx, { text: "look at this", images, source: "interactive" })

			expect(mockSetPendingImageIndicator.mock.calls.at(-1)?.[0]).toBeNull()
			expect(hasImage).not.toHaveBeenCalled()
			expect(availableFormats).not.toHaveBeenCalled()
			expect(mockExecFile).not.toHaveBeenCalled()
		})

		it("indicator clears to null after images are submitted when clipboard is empty", async () => {
			mockGetNativeClipboard.mockReturnValue({
				clipboard: { hasImage: () => false, availableFormats: () => [] },
				error: null,
			})
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			const ctx = makeMockCtx()
			startSession(pi, ctx)

			const images: ImageContent[] = [{ type: "image", mimeType: "image/png", data: "abc123" }]
			await callInput(pi, ctx, { text: "message", images, source: "interactive" })

			const calls = mockSetPendingImageIndicator.mock.calls
			expect(calls[calls.length - 1][0]).toBeNull()
		})
	})

	describe("image file paths in the prompt", () => {
		const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47])
		let tmpDir: string
		let imgPath: string

		beforeEach(() => {
			tmpDir = mkdtempSync(join(tmpdir(), "typed-img-ext-"))
			imgPath = join(tmpDir, "a.png")
			writeFileSync(imgPath, PNG_BYTES)
		})

		afterEach(() => {
			rmSync(tmpDir, { recursive: true, force: true })
		})

		function startVisionSession() {
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			const ctx = makeMockCtx()
			startSession(pi, ctx)
			return { pi, ctx }
		}

		it("attaches a typed image path with [Image #1] and keeps the text", async () => {
			const { pi, ctx } = startVisionSession()
			const result = await callInput(pi, ctx, { text: `${imgPath} what's this?`, images: [], source: "interactive" })

			expect(result).toMatchObject({ action: "transform" })
			const { text, images } = result as { text: string; images: ImageContent[] }
			expect(text).toBe(`[Image #1] ${imgPath} what's this?`)
			expect(images).toHaveLength(1)
			expect(images[0].mimeType).toBe("image/png")
			expect(Buffer.from(images[0].data, "base64")).toEqual(PNG_BYTES)
			expect(mockAddImage).toHaveBeenCalledWith(1, images[0])
		})

		it("appends path images after existing attachments and numbers them sequentially", async () => {
			const { pi, ctx } = startVisionSession()
			const attached: ImageContent = { type: "image", mimeType: "image/jpeg", data: "ZmFrZQ==" }
			const result = await callInput(pi, ctx, { text: `look ${imgPath}`, images: [attached], source: "interactive" })

			const { text, images } = result as { text: string; images: ImageContent[] }
			expect(text).toBe(`[Image #1] [Image #2] look ${imgPath}`)
			expect(images[0]).toEqual(attached)
			expect(Buffer.from(images[1].data, "base64")).toEqual(PNG_BYTES)
			expect(mockAddImage).toHaveBeenNthCalledWith(1, 1, attached)
			expect(mockAddImage).toHaveBeenNthCalledWith(2, 2, expect.objectContaining({ mimeType: "image/png" }))
		})

		it("keeps the marker counter advancing across path-attach and paste turns", async () => {
			const { pi, ctx } = startVisionSession()
			await callInput(pi, ctx, { text: String(imgPath), images: [], source: "interactive" })
			const result = (await callInput(pi, ctx, {
				text: "and this",
				images: [{ type: "image", mimeType: "image/png", data: "aaa" }],
				source: "interactive",
			})) as { text: string }
			expect(result.text).toContain("[Image #2]")
		})

		it("attaches a path-only message with the marker as prefix", async () => {
			const { pi, ctx } = startVisionSession()
			const result = await callInput(pi, ctx, { text: String(imgPath), images: [], source: "interactive" })
			expect((result as { text: string }).text).toBe(`[Image #1] ${imgPath}`)
		})

		it("attaches a duplicated path only once", async () => {
			const { pi, ctx } = startVisionSession()
			const result = await callInput(pi, ctx, { text: `${imgPath} and ${imgPath}`, images: [], source: "interactive" })
			expect((result as { images: ImageContent[] }).images).toHaveLength(1)
		})

		it("leaves a typed path untouched (no extraction, no gate) for non-interactive sources on a text-only model", async () => {
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			const ctx = makeMockCtx({ model: TEXT_MODEL })
			startSession(pi, ctx)

			const result = await callInput(pi, ctx, { text: `look at ${imgPath}`, images: [], source: "rpc" })
			expect(result).toBeUndefined()
			expect(mockAddImage).not.toHaveBeenCalled()
			expect(ctx.ui.custom).not.toHaveBeenCalled()
		})

		it("extracts typed paths on a text-only model in the interactive TUI so they reach the gate", async () => {
			const { pi, ctx, custom, resolveDialog } = startGateSession({ model: TEXT_MODEL })

			const resultP = callInput(pi, ctx, { text: `look at ${imgPath}`, images: [], source: "interactive" })
			expect(custom).toHaveBeenCalledTimes(1)
			resolveDialog(0, { kind: "cancel" })
			await expect(resultP).resolves.toEqual({ action: "handled" })
			expect(mockAddImage).not.toHaveBeenCalled()

			// The path attachment survived cancellation: resubmitting reopens the gate.
			const resultP2 = callInput(pi, ctx, { text: `look at ${imgPath}`, images: [], source: "interactive" })
			expect(custom).toHaveBeenCalledTimes(2)
			resolveDialog(1, { kind: "cancel" })
			await expect(resultP2).resolves.toEqual({ action: "handled" })
			expect(mockAddImage).not.toHaveBeenCalled()
		})

		it("leaves text untouched when the path does not resolve to an image", async () => {
			const { pi, ctx } = startVisionSession()
			const missing = join(tmpDir, "missing.png")
			const result = await callInput(pi, ctx, { text: `open ${missing}`, images: [], source: "interactive" })
			expect(result).toBeUndefined()
			expect(mockAddImage).not.toHaveBeenCalled()
		})
	})

	describe("paste", () => {
		it("accepts the paste on a text-only model and shows the hint as an indicator segment, not a chat warning", async () => {
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			const ctx = makeMockCtx({ model: TEXT_MODEL })
			startSession(pi, ctx)

			mockReadClipboardImage.mockResolvedValue({
				bytes: Buffer.from([1, 2, 3, 4]),
				mimeType: "image/png",
			})

			pasteHandler?.()
			await settle()

			// Image accepted into pending; the text-only hint rides the 📎 indicator
			// (a chat warning cannot be retracted once the model switches).
			expect(mockSetPendingImageIndicator).toHaveBeenCalledWith(expect.stringContaining("📎 1 image"))
			expect(mockSetPendingImageIndicator).toHaveBeenCalledWith(expect.stringContaining("· ⚠ text-only"))
			expect(ctx.ui.notify).not.toHaveBeenCalled()
		})

		it("accepts the paste without the text-only segment on a vision model", async () => {
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			const ctx = makeMockCtx({ model: VISION_MODEL })
			startSession(pi, ctx)

			mockReadClipboardImage.mockResolvedValue({
				bytes: Buffer.from([1, 2, 3, 4]),
				mimeType: "image/png",
			})

			pasteHandler?.()
			await settle()
			const calls = mockSetPendingImageIndicator.mock.calls.map((call) => call[0])
			expect(calls).toContainEqual(expect.stringContaining("📎 1 image"))
			const last = calls.at(-1)
			expect(last).toContain("📎 1 image")
			expect(last).not.toContain("text-only")
			expect(ctx.ui.notify).not.toHaveBeenCalled()
		})

		it("model_select clears the text-only segment when the model gains vision", async () => {
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			let liveModel: Model<Api> = TEXT_MODEL
			const ctx = makeMockCtx({
				model: undefined, // live getter below
			})
			Object.defineProperty(ctx, "model", { get: () => liveModel, configurable: true })
			startSession(pi, ctx)

			mockReadClipboardImage.mockResolvedValue({
				bytes: Buffer.from([1, 2, 3, 4]),
				mimeType: "image/png",
			})
			pasteHandler?.()
			await settle()
			expect(mockSetPendingImageIndicator).toHaveBeenLastCalledWith(expect.stringContaining("· ⚠ text-only"))

			// The vision gate's switch (or /model) fires model_select.
			liveModel = VISION_MODEL
			getHandler<unknown, void>(pi, "model_select")(void 0, ctx)

			const last = mockSetPendingImageIndicator.mock.calls.at(-1)?.[0]
			expect(last).toContain("📎 1 image")
			expect(last).not.toContain("text-only")
		})

		it("pastes and submits one Darwin image without advertising a clipboard hint", async () => {
			Object.defineProperty(process, "platform", { value: "darwin" })
			const hasImage = vi.fn(() => true)
			const availableFormats = vi.fn(() => ["public.png", "public.file-url"])
			const getImageBinary = vi.fn(async () => [1, 2, 3, 4])
			mockGetNativeClipboard.mockReturnValue({
				clipboard: { hasImage, availableFormats, getImageBinary },
				error: null,
			})
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			const ctx = makeMockCtx()
			startSession(pi, ctx)

			mockReadClipboardImage.mockResolvedValue({
				bytes: Buffer.from([1, 2, 3, 4]),
				mimeType: "image/png",
			})
			pasteHandler?.()
			await settle()

			expect(mockReadClipboardImage).toHaveBeenCalledTimes(1)
			expect(mockSetPendingImageIndicator).toHaveBeenCalledWith(expect.stringContaining("📎 1 image"))

			const result = (await callInput(pi, ctx, { text: "look", images: [], source: "interactive" })) as {
				text: string
				images: ImageContent[]
			}
			expect(result.text).toBe("[Image #1] look")
			expect(result.images).toEqual([
				{ type: "image", data: Buffer.from([1, 2, 3, 4]).toString("base64"), mimeType: "image/png" },
			])
			expect(mockSetPendingImageIndicator).toHaveBeenLastCalledWith(null)
			expect(hasImage).not.toHaveBeenCalled()
			expect(availableFormats).not.toHaveBeenCalled()
			expect(getImageBinary).not.toHaveBeenCalled()
			expect(mockExecFile).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(5_000)
			expect(mockReadClipboardImage).toHaveBeenCalledTimes(1)
			expect(hasImage).not.toHaveBeenCalled()
		})

		it("notifies when Darwin paste finds no image and does not start polling", async () => {
			const hasImage = vi.fn(() => false)
			mockGetNativeClipboard.mockReturnValue({
				clipboard: { hasImage, availableFormats: () => ["public.file-url"] },
				error: null,
			})
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			const ctx = makeMockCtx()
			startSession(pi, ctx)

			mockReadClipboardImage.mockResolvedValue(null)
			pasteHandler?.()
			await settle()

			expect(ctx.ui.notify).toHaveBeenCalledWith("No image found on clipboard", "info")
			expect(mockSetPendingImageIndicator).not.toHaveBeenCalledWith(expect.stringContaining("📎"))
			await vi.advanceTimersByTimeAsync(5_000)
			expect(mockReadClipboardImage).toHaveBeenCalledTimes(1)
			expect(mockGetNativeClipboard).toHaveBeenCalledTimes(1)
			expect(hasImage).not.toHaveBeenCalled()
			expect(mockExecFile).not.toHaveBeenCalled()
		})

		it("notifies when clipboard image support is unavailable and does not poll", async () => {
			mockGetNativeClipboard.mockReturnValue({ clipboard: null, error: "no addon" })
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			const ctx = makeMockCtx()
			startSession(pi, ctx)

			pasteHandler?.()
			await settle()

			expect(ctx.ui.notify).toHaveBeenCalledWith("Clipboard image support is not available: no addon", "warning")
			expect(mockReadClipboardImage).not.toHaveBeenCalled()
			await vi.advanceTimersByTimeAsync(5_000)
			expect(mockGetNativeClipboard).toHaveBeenCalledTimes(1)
			expect(mockReadClipboardImage).not.toHaveBeenCalled()
			expect(mockExecFile).not.toHaveBeenCalled()
		})

		it("notifies when the clipboard read fails and does not retry", async () => {
			mockGetNativeClipboard.mockReturnValue({
				clipboard: { hasImage: () => true, availableFormats: () => ["public.png", "public.file-url"] },
				error: null,
			})
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			const ctx = makeMockCtx()
			startSession(pi, ctx)

			mockReadClipboardImage.mockRejectedValue(new Error("pasteboard unavailable"))
			pasteHandler?.()
			await settle()

			expect(ctx.ui.notify).toHaveBeenCalledWith("Clipboard image support is not available", "warning")
			expect(mockSetPendingImageIndicator).not.toHaveBeenCalledWith(expect.stringContaining("📎"))
			await vi.advanceTimersByTimeAsync(5_000)
			expect(mockReadClipboardImage).toHaveBeenCalledTimes(1)
			expect(mockGetNativeClipboard).toHaveBeenCalledTimes(1)
			expect(mockExecFile).not.toHaveBeenCalled()
		})

		it("pasted images flow through the gate and survive cancel exactly once", async () => {
			const pi = makeMockPi()
			clipboardImageExtension(pi)

			const dialogResolvers: Array<(result: unknown) => void> = []
			const custom = vi.fn(
				() =>
					new Promise((resolve) => {
						dialogResolvers.push(resolve)
					}),
			)
			const ctx = makeMockCtx({ model: TEXT_MODEL, ui: { custom: custom as ExtensionContext["ui"]["custom"] } })
			startSession(pi, ctx)

			mockReadClipboardImage.mockResolvedValue({
				bytes: Buffer.from([9, 9, 9]),
				mimeType: "image/png",
			})
			pasteHandler?.()
			await settle()

			// Submit: the gate opens.
			const resultP = callInput(pi, ctx, { text: "hello", images: [], source: "interactive" })
			expect(custom).toHaveBeenCalledTimes(1)
			dialogResolvers[0]?.({ kind: "cancel" })
			await expect(resultP).resolves.toEqual({ action: "handled" })

			// Resubmit the same draft: still one pasted image, gate reopens.
			const resultP2 = callInput(pi, ctx, { text: "hello", images: [], source: "interactive" })
			expect(custom).toHaveBeenCalledTimes(2)
			dialogResolvers[1]?.({ kind: "switch", model: SWITCH_TARGET })
			const result = (await resultP2) as { action: string; text: string; images: ImageContent[] }
			expect(result.action).toBe("transform")
			expect(result.images).toHaveLength(1)
			expect(result.text).toBe("[Image #1] hello")
			expect(mockAddImage).toHaveBeenCalledTimes(1)
		})
	})

	describe("acp submissions (rpc source)", () => {
		// ACP prompts arrive as input events with ctx.mode "rpc" (the ACP server
		// binds extensions with mode "rpc") + source "rpc" from
		// session.prompt(text, { source: "rpc", images }). The vision gate is
		// TUI-only (ctx.ui.custom is a no-op under ACP, so engaging it would
		// silently swallow the submission); ACP instead gets the server-level
		// drop + agent_message_chunk warning. These tests pin that the extension
		// never opens the gate for rpc submissions.
		it("passes rpc images through on a text-only model without engaging the vision gate", async () => {
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			const ctx = makeMockCtx({ model: TEXT_MODEL, mode: "rpc" })
			startSession(pi, ctx)

			const images: ImageContent[] = [img("abc")]
			const result = (await callInput(pi, ctx, { text: "hi", images, source: "rpc" })) as {
				action: string
				text: string
				images: ImageContent[]
			}
			// Not "handled": the submission flows on with images preserved, so the
			// ACP server can apply its drop + warning for text-only models.
			expect(result.action).toBe("transform")
			expect(result.images).toEqual(images)
			expect(result.text).toBe("[Image #1] hi")
			expect(ctx.ui.custom).not.toHaveBeenCalled()
			expect(mockAddImage).toHaveBeenCalledWith(1, images[0])
		})

		it("passes rpc images through with markers on a vision model", async () => {
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			const ctx = makeMockCtx({ model: VISION_MODEL, mode: "rpc" })
			startSession(pi, ctx)

			const images: ImageContent[] = [img("abc")]
			const result = (await callInput(pi, ctx, { text: "hi", images, source: "rpc" })) as {
				action: string
				text: string
				images: ImageContent[]
			}
			expect(result.action).toBe("transform")
			expect(result.text).toBe("[Image #1] hi")
			expect(result.images).toEqual(images)
			expect(ctx.ui.custom).not.toHaveBeenCalled()
		})
	})

	describe("vision gate (interactive TUI, text-only model)", () => {
		it("opens the gate dialog on submit with images; cancel restores the exact draft", async () => {
			const { pi, ctx, custom, resolveDialog } = startGateSession()

			const images: ImageContent[] = [img("abc")]
			const resultP = callInput(pi, ctx, { text: "hello", images, source: "interactive" })
			expect(custom).toHaveBeenCalledTimes(1)
			resolveDialog(0, { kind: "cancel" })

			await expect(resultP).resolves.toEqual({ action: "handled" })
			expect(ctx.ui.setEditorText).toHaveBeenCalledWith("hello")
			// No markers, no registry, no counter mutation.
			expect(mockAddImage).not.toHaveBeenCalled()
		})

		it("switch submits the images with markers on the new model", async () => {
			const { pi, ctx, resolveDialog } = startGateSession()

			const images: ImageContent[] = [img("abc")]
			const resultP = callInput(pi, ctx, { text: "hello", images, source: "interactive" })
			resolveDialog(0, { kind: "switch", model: SWITCH_TARGET })

			const result = (await resultP) as { action: string; text: string; images: ImageContent[] }
			expect(result.action).toBe("transform")
			expect(result.text).toBe("[Image #1] hello")
			expect(result.images).toEqual(images)
			expect(mockAddImage).toHaveBeenCalledWith(1, images[0])
		})

		it("remove sends the original trimmed text without images or markers", async () => {
			const { pi, ctx, resolveDialog } = startGateSession()

			const resultP = callInput(pi, ctx, { text: "  hello  ", images: [img("abc")], source: "interactive" })
			resolveDialog(0, { kind: "remove" })

			await expect(resultP).resolves.toEqual({ action: "transform", text: "hello", images: [] })
			expect(mockAddImage).not.toHaveBeenCalled()
			// Pending attachments cleared and the indicator updated.
			expect(mockSetPendingImageIndicator.mock.calls.at(-1)?.[0]).toBeNull()
		})

		it("remove consumes the submission when the text is empty", async () => {
			const { pi, ctx, resolveDialog } = startGateSession()

			const resultP = callInput(pi, ctx, { text: "  ", images: [img("abc")], source: "interactive" })
			resolveDialog(0, { kind: "remove" })

			await expect(resultP).resolves.toEqual({ action: "handled" })
			expect(mockAddImage).not.toHaveBeenCalled()
		})

		it("incoming images survive cancel and submit exactly once on switch", async () => {
			const { pi, ctx, custom, resolveDialog } = startGateSession()

			const incoming: ImageContent[] = [img("drop")]
			const resultP = callInput(pi, ctx, { text: "hello", images: incoming, source: "interactive" })
			resolveDialog(0, { kind: "cancel" })
			await resultP

			// Resubmit the same draft with no new images: the retained incoming
			// image is still attached (the gate reopens with it).
			const resultP2 = callInput(pi, ctx, { text: "hello", images: [], source: "interactive" })
			expect(custom).toHaveBeenCalledTimes(2)
			resolveDialog(1, { kind: "switch", model: SWITCH_TARGET })
			const result = (await resultP2) as { action: string; text: string; images: ImageContent[] }
			expect(result.action).toBe("transform")
			expect(result.images).toEqual(incoming)
			expect(result.text).toBe("[Image #1] hello")
			expect(mockAddImage).toHaveBeenCalledTimes(1)
		})

		it("an edited draft refreshes path attachments while retaining incoming ones", async () => {
			const tmp = mkdtempSync(join(tmpdir(), "gate-edit-"))
			try {
				const pngA = join(tmp, "a.png")
				const pngB = join(tmp, "b.png")
				writeFileSync(pngA, Buffer.from([1]))
				writeFileSync(pngB, Buffer.from([2]))

				const { pi, ctx, custom, resolveDialog } = startGateSession()
				const incoming: ImageContent[] = [img("drop")]
				const resultP = callInput(pi, ctx, {
					text: `see ${pngA}`,
					images: incoming,
					source: "interactive",
				})
				resolveDialog(0, { kind: "cancel" })
				await resultP

				// The user edits the draft to reference b.png instead.
				const resultP2 = callInput(pi, ctx, { text: `see ${pngB}`, images: [], source: "interactive" })
				expect(custom).toHaveBeenCalledTimes(2)
				resolveDialog(1, { kind: "switch", model: SWITCH_TARGET })
				const result = (await resultP2) as { images: ImageContent[]; text: string }
				// incoming retained; path refreshed to b.png only
				expect(result.images).toHaveLength(2)
				expect(result.images[0]).toEqual(img("drop"))
				expect(result.text).toBe(`[Image #1] [Image #2] see ${pngB}`)
			} finally {
				rmSync(tmp, { recursive: true, force: true })
			}
		})

		it("sending an image-free edited draft discards cancelled path attachments", async () => {
			const tmp = mkdtempSync(join(tmpdir(), "gate-discard-"))
			try {
				const imagePath = join(tmp, "photo.png")
				writeFileSync(imagePath, Buffer.from([1]))
				const { pi, ctx, custom, resolveDialog } = startGateSession()
				const originalText = `see ${imagePath}`
				const cancelled = callInput(pi, ctx, { text: originalText, source: "interactive" })
				resolveDialog(0, { kind: "cancel" })
				await expect(cancelled).resolves.toEqual({ action: "handled" })

				await expect(callInput(pi, ctx, { text: "plain message", source: "interactive" })).resolves.toBeUndefined()
				rmSync(imagePath)
				const retried = callInput(pi, ctx, { text: originalText, source: "interactive" })
				// Resolve an unexpected dialog too, so a regression cannot hang the test.
				if (custom.mock.calls.length > 1) resolveDialog(1, { kind: "cancel" })
				await expect(retried).resolves.toBeUndefined()
				expect(custom).toHaveBeenCalledTimes(1)
				expect(mockAddImage).not.toHaveBeenCalled()
			} finally {
				rmSync(tmp, { recursive: true, force: true })
			}
		})

		it("never opens the gate outside the interactive TUI boundary", async () => {
			const { pi, ctx, custom, resolveDialog } = startGateSession({ model: TEXT_MODEL, mode: "print" })

			// Non-TUI mode: existing behavior — attach with markers, no gate.
			const result = (await callInput(pi, ctx, {
				text: "hi",
				images: [img("abc")],
				source: "interactive",
			})) as { action: string; text: string }
			expect(result.action).toBe("transform")
			expect(result.text).toBe("[Image #1] hi")
			expect(custom).not.toHaveBeenCalled()
			void resolveDialog
		})

		it("a session change during the dialog discards the stale result without mutating state", async () => {
			const { pi, ctx, resolveDialog } = startGateSession()

			const resultP = callInput(pi, ctx, { text: "hello", images: [img("abc")], source: "interactive" })
			// The session is replaced while the dialog is open.
			const newCtx = makeMockCtx()
			startSession(pi, newCtx)

			resolveDialog(0, { kind: "switch", model: SWITCH_TARGET })

			// Stale: consumed without submitting to either session.
			await expect(resultP).resolves.toEqual({ action: "handled" })
			expect(mockAddImage).not.toHaveBeenCalled()
			expect(ctx.ui.setEditorText).not.toHaveBeenCalled()
		})

		it("prevents a second gate while a dialog is already open", async () => {
			const { pi, ctx, custom, resolveDialog } = startGateSession()

			const firstP = callInput(pi, ctx, { text: "one", images: [img("a")], source: "interactive" })
			expect(custom).toHaveBeenCalledTimes(1)

			const second = await callInput(pi, ctx, { text: "two", images: [img("b")], source: "interactive" })
			expect(second).toEqual({ action: "handled" })
			expect(ctx.ui.setEditorText).toHaveBeenCalledWith("two")
			expect(custom).toHaveBeenCalledTimes(1)

			resolveDialog(0, { kind: "cancel" })
			await expect(firstP).resolves.toEqual({ action: "handled" })
		})
	})

	describe("vision gate — streaming submissions", () => {
		it("restores the draft, notifies, and defers the dialog until the run finishes", async () => {
			const harness = startGateSession()
			const { pi, ctx, custom, resolveDialog } = harness

			const result = await callInput(pi, ctx, {
				text: "during stream",
				images: [img("abc")],
				source: "interactive",
				streamingBehavior: "steer",
			})
			expect(result).toEqual({ action: "handled" })
			expect(ctx.ui.setEditorText).toHaveBeenCalledWith("during stream")
			expect(ctx.ui.notify).toHaveBeenCalledWith(
				"text-only is text-only — switch available when generation finishes",
				"warning",
			)
			expect(custom).not.toHaveBeenCalled() // no dialog mid-stream

			// The run finishes: the deferred dialog opens.
			vi.mocked(ctx.ui.getEditorText).mockReturnValue("during stream")
			fireAgentEnd(harness)
			await vi.advanceTimersByTimeAsync(1)
			expect(custom).toHaveBeenCalledTimes(1)

			resolveDialog(0, { kind: "cancel" })
			await settle()
			// Cancel retained everything; a second agent_end must not reopen.
			fireAgentEnd(harness)
			await vi.advanceTimersByTimeAsync(1)
			expect(custom).toHaveBeenCalledTimes(1)
		})

		it("deferred switch keeps the draft; Enter then submits the images once", async () => {
			const harness = startGateSession()
			const { pi, ctx, resolveDialog } = harness
			void harness.custom

			await callInput(pi, ctx, {
				text: "during stream",
				images: [img("abc")],
				source: "interactive",
				streamingBehavior: "followUp",
			})
			vi.mocked(ctx.ui.getEditorText).mockReturnValue("during stream")
			fireAgentEnd(harness)
			await vi.advanceTimersByTimeAsync(1)

			resolveDialog(0, { kind: "switch", model: SWITCH_TARGET })
			await settle()

			// The user pressed Enter: the model is now vision-capable, so the normal
			// path merges the retained sources and submits exactly once.
			const liveCtx = makeMockCtx({ model: SWITCH_TARGET })
			const submitted = (await callInput(pi, liveCtx, {
				text: "during stream",
				images: [],
				source: "interactive",
			})) as { action: string; text: string; images: ImageContent[] }
			expect(submitted.action).toBe("transform")
			expect(submitted.text).toBe("[Image #1] during stream")
			expect(submitted.images).toEqual([img("abc")])
			expect(mockAddImage).toHaveBeenCalledTimes(1)
		})

		it("deferred remove suppresses path reattachment for one submission of the unchanged draft", async () => {
			const tmp = mkdtempSync(join(tmpdir(), "gate-defer-"))
			try {
				const pngPath = join(tmp, "a.png")
				writeFileSync(pngPath, Buffer.from([0x89, 0x50]))

				const harness = startGateSession()
				const { pi, ctx, custom, resolveDialog } = harness
				await callInput(pi, ctx, {
					text: `see ${pngPath}`,
					images: [],
					source: "interactive",
					streamingBehavior: "steer",
				})
				vi.mocked(ctx.ui.getEditorText).mockReturnValue(`see ${pngPath}`)
				fireAgentEnd(harness)
				await vi.advanceTimersByTimeAsync(1)

				resolveDialog(0, { kind: "remove" })
				await settle()

				// Next submission of the unchanged draft: text only, no reattachment,
				// no gate, no dialog.
				const next = await callInput(pi, ctx, { text: `see ${pngPath}`, images: [], source: "interactive" })
				expect(next).toBeUndefined()
				expect(mockAddImage).not.toHaveBeenCalled()
				expect(custom).toHaveBeenCalledTimes(1)

				// The suppression was consumed once: a further submission reattaches
				// (and the gate reopens).
				const after = callInput(pi, ctx, { text: `see ${pngPath}`, images: [], source: "interactive" })
				expect(custom).toHaveBeenCalledTimes(2)
				resolveDialog(1, { kind: "cancel" })
				await expect(after).resolves.toEqual({ action: "handled" })
			} finally {
				rmSync(tmp, { recursive: true, force: true })
			}
		})

		it("keeps deferred path suppression when a new attachment gate is cancelled", async () => {
			const tmp = mkdtempSync(join(tmpdir(), "gate-defer-cancel-"))
			try {
				const pngPath = join(tmp, "a.png")
				writeFileSync(pngPath, Buffer.from([0x89, 0x50]))
				const draft = `see ${pngPath}`
				const harness = startGateSession()
				const { pi, ctx, custom, resolveDialog } = harness

				await callInput(pi, ctx, {
					text: draft,
					images: [],
					source: "interactive",
					streamingBehavior: "steer",
				})
				vi.mocked(ctx.ui.getEditorText).mockReturnValue(draft)
				fireAgentEnd(harness)
				await vi.advanceTimersByTimeAsync(1)
				resolveDialog(0, { kind: "remove" })
				await settle()

				const incoming = img("new-incoming")
				const cancelled = callInput(pi, ctx, { text: draft, images: [incoming], source: "interactive" })
				expect(custom).toHaveBeenCalledTimes(2)
				resolveDialog(1, { kind: "cancel" })
				await expect(cancelled).resolves.toEqual({ action: "handled" })

				const accepted = callInput(pi, ctx, { text: draft, images: [], source: "interactive" })
				expect(custom).toHaveBeenCalledTimes(3)
				resolveDialog(2, { kind: "switch", model: SWITCH_TARGET })
				await expect(accepted).resolves.toMatchObject({
					action: "transform",
					images: [incoming],
				})
				expect(mockAddImage).toHaveBeenCalledTimes(1)
			} finally {
				rmSync(tmp, { recursive: true, force: true })
			}
		})

		it("a paste alone never arms the deferred dialog", async () => {
			const harness = startGateSession()
			fireAgentEnd(harness)
			await vi.advanceTimersByTimeAsync(1)
			expect(harness.custom).not.toHaveBeenCalled()
		})
	})

	describe("clipboard polling", () => {
		const POLL_MS = 1_000

		function screenshotClipboard() {
			const hasImage = vi.fn(() => true)
			const availableFormats = vi.fn(() => ["public.png", "public.file-url"])
			const getImageBinary = vi.fn(async () => [1, 2, 3])
			mockGetNativeClipboard.mockReturnValue({
				clipboard: { hasImage, availableFormats, getImageBinary },
				error: null,
			})
			return { hasImage, availableFormats, getImageBinary }
		}

		function expectNoProbe(spies: ReturnType<typeof screenshotClipboard>): void {
			expect(spies.hasImage).not.toHaveBeenCalled()
			expect(spies.availableFormats).not.toHaveBeenCalled()
			expect(spies.getImageBinary).not.toHaveBeenCalled()
			expect(mockGetNativeClipboard).not.toHaveBeenCalled()
			expect(mockReadClipboardImage).not.toHaveBeenCalled()
			expect(mockExecFile).not.toHaveBeenCalled()
		}

		it("does not probe, read, or spawn while a Darwin TUI session idles", async () => {
			Object.defineProperty(process, "platform", { value: "darwin" })
			const spies = screenshotClipboard()
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			const ctx = makeMockCtx({ mode: "tui" })
			startSession(pi, ctx)

			await vi.advanceTimersByTimeAsync(POLL_MS * 5)
			await settle()

			expectNoProbe(spies)
			expect(mockSetPendingImageIndicator).not.toHaveBeenCalledWith("Image in clipboard · ctrl+v to paste")
			expect(mockSetPendingImageIndicator).toHaveBeenLastCalledWith(null)
		})

		it("does not probe across idle or repeated Darwin ACP sessions", async () => {
			// ACP binds this extension with ctx.mode "rpc" (see bindAcpExtensions).
			Object.defineProperty(process, "platform", { value: "darwin" })
			const spies = screenshotClipboard()
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			const ctx = makeMockCtx({ mode: "rpc" })
			startSession(pi, ctx)
			await vi.advanceTimersByTimeAsync(POLL_MS * 5)
			expectNoProbe(spies)

			for (let i = 0; i < 3; i++) {
				startSession(pi, ctx)
				getHandler<unknown, void>(pi, "session_shutdown")(void 0, ctx)
			}
			startSession(pi, ctx)
			await vi.advanceTimersByTimeAsync(POLL_MS * 5)
			await settle()
			expectNoProbe(spies)
			getHandler<unknown, void>(pi, "session_shutdown")(void 0, ctx)
		})

		it("polls on Windows until shutdown and does not stack intervals", async () => {
			Object.defineProperty(process, "platform", { value: "win32" })
			let present = false
			const hasImage = vi.fn(() => present)
			const availableFormats = vi.fn(() => [] as string[])
			mockGetNativeClipboard.mockReturnValue({
				clipboard: { hasImage, availableFormats },
				error: null,
			})
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			const ctx = makeMockCtx()
			try {
				startSession(pi, ctx)
				expect(hasImage).toHaveBeenCalledTimes(1)
				expect(mockSetPendingImageIndicator).toHaveBeenLastCalledWith(null)

				present = true
				await vi.advanceTimersByTimeAsync(POLL_MS)
				expect(hasImage).toHaveBeenCalledTimes(2)
				expect(mockSetPendingImageIndicator).toHaveBeenLastCalledWith("Image in clipboard · ctrl+v to paste")

				hasImage.mockClear()
				startSession(pi, ctx)
				expect(hasImage).toHaveBeenCalledTimes(1)
				await vi.advanceTimersByTimeAsync(POLL_MS * 2)
				// One replacement interval: the initial probe plus two ticks, not two intervals' worth.
				expect(hasImage).toHaveBeenCalledTimes(3)

				const callsAtShutdown = hasImage.mock.calls.length
				getHandler<unknown, void>(pi, "session_shutdown")(void 0, ctx)
				await vi.advanceTimersByTimeAsync(POLL_MS * 5)
				expect(hasImage).toHaveBeenCalledTimes(callsAtShutdown)
				expect(mockExecFile).not.toHaveBeenCalled()
			} finally {
				getHandler<unknown, void>(pi, "session_shutdown")(void 0, ctx)
			}
		})

		it("shows the Windows hint for image formats hasImage() misses", () => {
			Object.defineProperty(process, "platform", { value: "win32" })
			const hasImage = vi.fn(() => false)
			const availableFormats = vi.fn(() => ["image/jpeg"])
			mockGetNativeClipboard.mockReturnValue({
				clipboard: { hasImage, availableFormats },
				error: null,
			})
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			const ctx = makeMockCtx()
			startSession(pi, ctx)
			expect(hasImage).toHaveBeenCalledTimes(1)
			expect(availableFormats).toHaveBeenCalledTimes(1)
			expect(mockSetPendingImageIndicator).toHaveBeenLastCalledWith("Image in clipboard · ctrl+v to paste")
			expect(mockExecFile).not.toHaveBeenCalled()
			getHandler<unknown, void>(pi, "session_shutdown")(void 0, ctx)
		})

		it("stays on-demand on Linux", async () => {
			Object.defineProperty(process, "platform", { value: "linux" })
			const spies = screenshotClipboard()
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			startSession(pi, makeMockCtx())
			await vi.advanceTimersByTimeAsync(POLL_MS * 5)
			expectNoProbe(spies)
			expect(mockSetPendingImageIndicator).toHaveBeenLastCalledWith(null)
		})

		it("clears a stale proactive hint and pending image when the next session starts", async () => {
			Object.defineProperty(process, "platform", { value: "win32" })
			mockGetNativeClipboard.mockReturnValue({
				clipboard: { hasImage: () => true, availableFormats: () => ["image/png"] },
				error: null,
			})
			const pi = makeMockPi()
			clipboardImageExtension(pi)
			const first = makeMockCtx()
			startSession(pi, first)
			expect(mockSetPendingImageIndicator).toHaveBeenLastCalledWith("Image in clipboard · ctrl+v to paste")

			mockReadClipboardImage.mockResolvedValue({
				bytes: Buffer.from([1, 2, 3]),
				mimeType: "image/png",
			})
			pasteHandler?.()
			await settle()
			expect(mockSetPendingImageIndicator).toHaveBeenLastCalledWith(expect.stringContaining("📎 1 image"))

			Object.defineProperty(process, "platform", { value: "darwin" })
			mockGetNativeClipboard.mockClear()
			mockReadClipboardImage.mockClear()
			mockExecFile.mockClear()
			const spies = screenshotClipboard()
			const second = makeMockCtx()
			startSession(pi, second)
			expect(mockSetPendingImageIndicator).toHaveBeenLastCalledWith(null)
			expectNoProbe(spies)

			await expect(callInput(pi, second, { text: "hello", images: [], source: "interactive" })).resolves.toBeUndefined()
			const submitted = await callInput(pi, second, {
				text: "next",
				images: [{ type: "image", mimeType: "image/png", data: "zzz" }],
				source: "interactive",
			})
			expect(submitted).toMatchObject({ action: "transform", text: "[Image #1] next" })
			expect(mockSetPendingImageIndicator).toHaveBeenLastCalledWith(null)
			expect(spies.hasImage).not.toHaveBeenCalled()
		})
	})
})
