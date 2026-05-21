import { beforeEach, describe, expect, it, vi } from "vitest"

// All mock functions must be vi.hoisted
const { mockNotify, mockRegisterCommand } = vi.hoisted(() => ({
	mockNotify: vi.fn(),
	mockRegisterCommand: vi.fn(),
}))

// Mock the ExtensionAPI interface
const createMockCtx = (overrides: Record<string, unknown> = {}) => ({
	model: overrides.model ?? { id: "test-model", input: ["text", "image"] },
	modelRegistry: overrides.modelRegistry ?? {
		getAvailable: () => [{ id: "vision-model", input: ["text", "image"] }],
		getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "test-key", headers: {} }),
	},
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

import { markImagesAsStripped, sessionHasImages } from "./model-guard.js"
// Import the extension after mocks are set up
import stripImagesExtension from "./strip-images.js"

describe("strip-images extension", () => {
	let mockPi: ReturnType<typeof createMockPi>

	beforeEach(() => {
		vi.clearAllMocks()
		mockNotify.mockClear()
		mockRegisterCommand.mockClear()
		markImagesAsStripped()
		mockPi = createMockPi()
		vi.mocked(sessionHasImages).mockReturnValue(true)
	})

	describe("command registration", () => {
		it("registers the strip-images command", () => {
			const ctx = createMockCtx()
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
	})
})
