import { beforeEach, describe, expect, it, vi } from "vitest"

// All mock functions must be vi.hoisted
const { completeMock, mockNotify, mockRegisterCommand } = vi.hoisted(() => ({
	completeMock: vi.fn(),
	mockNotify: vi.fn(),
	mockRegisterCommand: vi.fn(),
}))

vi.mock("@earendil-works/pi-ai/compat", async () => {
	const actual = await vi.importActual<typeof import("@earendil-works/pi-ai/compat")>("@earendil-works/pi-ai/compat")
	return { ...actual, complete: (...args: unknown[]) => completeMock(...args) }
})

// Mock the ExtensionAPI interface
const createMockCtx = (overrides: Record<string, unknown> = {}) => ({
	model: overrides.model ?? { provider: "kimchi-dev", id: "test-model", input: ["text", "image"] },
	modelRegistry: overrides.modelRegistry ?? {
		getAvailable: () => [{ provider: "kimchi-dev", id: "vision-model", input: ["text", "image"] }],
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
	},
	sessionManager: overrides.sessionManager ?? { getSessionId: () => "strip-images-session" },
	ui: { notify: mockNotify },
})

const createMockPi = () => {
	const handlers: Record<string, unknown> = {}
	return {
		registerCommand: mockRegisterCommand.mockImplementation(
			(name: string, config: { handler: (args: string[], ctx: unknown) => Promise<void> }) => {
				handlers[name] = config.handler
			},
		),
		getHandler: (name: string) => handlers[name],
	}
}

// Mock model-guard to control sessionHasImages behavior
vi.mock("./model-guard.js", async () => {
	const actual = await vi.importActual("./model-guard.js")
	return {
		...(actual as Record<string, unknown>),
		hasImages: vi.fn().mockReturnValue(true),
		sessionHasImages: vi.fn().mockReturnValue(true),
		markImagesAsStripped: vi.fn(),
		getLatestMessages: vi.fn().mockReturnValue([]),
		storeImageDescription: vi.fn(),
		getImageDataHash: vi.fn().mockReturnValue("test-hash"),
	}
})

import { getLatestMessages, markImagesAsStripped, sessionHasImages } from "./model-guard.js"
// Import the extension after mocks are set up
import stripImagesExtension from "./strip-images.js"

describe("strip-images extension", () => {
	let mockPi: ReturnType<typeof createMockPi>

	beforeEach(() => {
		vi.clearAllMocks()
		completeMock.mockReset()
		mockNotify.mockClear()
		mockRegisterCommand.mockClear()
		markImagesAsStripped()
		mockPi = createMockPi()
		vi.mocked(sessionHasImages).mockReturnValue(true)
	})

	describe("command registration", () => {
		it("registers the strip-images command", () => {
			stripImagesExtension(mockPi as never)
			expect(mockRegisterCommand).toHaveBeenCalledWith(
				"strip-images",
				expect.objectContaining({ description: expect.any(String) }),
			)
		})
	})

	describe("no images in context", () => {
		it("notifies when sessionHasImages returns false", async () => {
			const ctx = createMockCtx()
			vi.mocked(sessionHasImages).mockReturnValue(false)
			stripImagesExtension(mockPi as never)

			const handler = mockPi.getHandler("strip-images") as (args: string[], ctx: unknown) => Promise<void>
			await handler([], ctx)

			expect(mockNotify).toHaveBeenCalledWith("No images in current context.", "info")
		})
	})

	describe("strip-images command handler", () => {
		it("requires a vision-capable model to process images", async () => {
			const ctx = createMockCtx({
				model: { id: "non-vision-model", input: ["text"] },
				modelRegistry: {
					getAvailable: () => [{ id: "non-vision-model-2", input: ["text"] }],
					getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {} }),
				},
			})
			stripImagesExtension(mockPi as never)

			const handler = mockPi.getHandler("strip-images") as (args: string[], ctx: unknown) => Promise<void>
			await handler([], ctx)

			expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("No vision-capable model available"), "error")
		})

		it("requires API key to be available", async () => {
			const ctx = createMockCtx({
				model: { id: "vision-model", input: ["text", "image"] },
				modelRegistry: {
					getAvailable: () => [{ id: "vision-model", input: ["text", "image"] }],
					getApiKeyAndHeaders: async () => ({ ok: false }),
				},
			})
			stripImagesExtension(mockPi as never)

			const handler = mockPi.getHandler("strip-images") as (args: string[], ctx: unknown) => Promise<void>
			await handler([], ctx)

			expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("no API key available"), "error")
		})

		it("uses a concrete vision model instead of dispatching image analysis through Auto", async () => {
			vi.mocked(getLatestMessages).mockReturnValue([
				{ role: "user", content: [{ type: "image", data: "image-data", mimeType: "image/png" }] },
			] as never)
			completeMock.mockReturnValue({
				content: [{ type: "text", text: "description" }],
				stopReason: "stop",
			})
			const ctx = createMockCtx({
				model: { provider: "kimchi-dev", id: "auto", input: ["text", "image"] },
				modelRegistry: {
					getAvailable: () => [
						{ provider: "kimchi-dev", id: "auto", input: ["text", "image"] },
						{ provider: "kimchi-dev", id: "vision-model", input: ["text", "image"] },
					],
					getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {} }),
				},
			})
			stripImagesExtension(mockPi as never)

			const handler = mockPi.getHandler("strip-images") as (args: string[], ctx: unknown) => Promise<void>
			await handler([], ctx)

			expect(completeMock.mock.calls[0]?.[0]).toMatchObject({ id: "vision-model" })
		})

		it("preserves the explicit image-analysis token limit", async () => {
			let sentOptions: unknown
			vi.mocked(getLatestMessages).mockReturnValue([
				{ role: "user", content: [{ type: "image", data: "image-data", mimeType: "image/png" }] },
			] as never)
			completeMock.mockImplementation((_model: unknown, _context: unknown, options: unknown) => {
				sentOptions = options
				return { content: [{ type: "text", text: "description" }], stopReason: "stop" }
			})
			stripImagesExtension(mockPi as never)

			const handler = mockPi.getHandler("strip-images") as (args: string[], ctx: unknown) => Promise<void>
			await handler([], createMockCtx())

			expect(sentOptions).toMatchObject({ maxTokens: 200 })
			expect(sentOptions).not.toHaveProperty("onPayload")
		})
	})
})
