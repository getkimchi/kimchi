import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "./__mocks__/context.js"
import { backendFor } from "./pr-cost-reporting/ledger/records.js"
import { flushWorkSummaries } from "./work-attribution/summary.js"

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
	...createContext(),
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
		refreshedSessionIsCurrent: vi.fn().mockReturnValue(true),
		refreshLatestMessagesFromSession: vi.fn(),
		markImagesAsStripped: vi.fn(),
		getLatestMessages: vi.fn().mockReturnValue([]),
		storeImageDescription: vi.fn(),
		getImageDataHash: vi.fn().mockReturnValue("test-hash"),
	}
})

import {
	getLatestMessages,
	markImagesAsStripped,
	refreshedSessionIsCurrent,
	refreshLatestMessagesFromSession,
	sessionHasImages,
	storeImageDescription,
} from "./model-guard.js"
// Import the extension after mocks are set up
import stripImagesExtension, { stripSessionImages } from "./strip-images.js"

describe("strip-images extension", () => {
	let attributionDir: string
	afterEach(async () => {
		await flushWorkSummaries()
		vi.unstubAllEnvs()
		rmSync(attributionDir, { recursive: true, force: true })
	})
	let mockPi: ReturnType<typeof createMockPi>

	beforeEach(() => {
		attributionDir = mkdtempSync(join(tmpdir(), "strip-attribution-"))
		vi.stubEnv("PI_CODING_AGENT_DIR", attributionDir)
		vi.clearAllMocks()
		completeMock.mockReset()
		mockNotify.mockClear()
		mockRegisterCommand.mockClear()
		markImagesAsStripped()
		mockPi = createMockPi()
		vi.mocked(sessionHasImages).mockReturnValue(true)
		vi.mocked(refreshedSessionIsCurrent).mockReturnValue(true)
		vi.mocked(refreshLatestMessagesFromSession).mockImplementation(async () => ({
			status: "ok",
			messages: getLatestMessages(),
			generation: 1,
			revision: 1,
		}))
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
		it("processes images returned by the lazy session refresh", async () => {
			vi.mocked(getLatestMessages).mockReturnValue([
				{ role: "user", content: [{ type: "image", data: "restored-image", mimeType: "image/png" }] },
			] as never)
			completeMock.mockResolvedValue({ content: [{ type: "text", text: "restored description" }] })
			stripImagesExtension(mockPi as never)
			const handler = mockPi.getHandler("strip-images") as (args: string[], ctx: unknown) => Promise<void>

			await handler([], createMockCtx())

			expect(refreshLatestMessagesFromSession).toHaveBeenCalledOnce()
			expect(refreshLatestMessagesFromSession).toHaveBeenCalledWith(expect.anything())
			expect(completeMock).toHaveBeenCalledOnce()
			expect(storeImageDescription).toHaveBeenCalledWith("test-hash", "restored description")
		})

		it("does not invoke a model when lazy refresh fails", async () => {
			vi.mocked(refreshLatestMessagesFromSession).mockResolvedValue({ status: "superseded" })
			const result = await stripSessionImages(createMockCtx() as never)

			expect(result).toEqual({ status: "refresh-failed", reason: "superseded" })
			expect(completeMock).not.toHaveBeenCalled()
			expect(markImagesAsStripped).toHaveBeenCalledTimes(1) // beforeEach only
		})

		it("does not commit stripped state after the session changes during analysis", async () => {
			vi.mocked(getLatestMessages).mockReturnValue([
				{ role: "user", content: [{ type: "image", data: "stale-image", mimeType: "image/png" }] },
			] as never)
			completeMock.mockResolvedValue({ content: [{ type: "text", text: "stale description" }] })
			vi.mocked(refreshedSessionIsCurrent).mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false)

			const result = await stripSessionImages(createMockCtx() as never)

			expect(result).toEqual({ status: "refresh-failed", reason: "superseded" })
			expect(storeImageDescription).not.toHaveBeenCalled()
			expect(markImagesAsStripped).toHaveBeenCalledTimes(1)
		})

		it("deduplicates identical restored image blocks", async () => {
			vi.mocked(getLatestMessages).mockReturnValue([
				{
					role: "user",
					content: [
						{ type: "image", data: "same-image", mimeType: "image/png" },
						{ type: "image", data: "same-image", mimeType: "image/png" },
					],
				},
			] as never)
			completeMock.mockResolvedValue({ content: [{ type: "text", text: "one description" }] })

			const result = await stripSessionImages(createMockCtx() as never)

			expect(result).toMatchObject({ status: "stripped", processedCount: 1 })
			expect(completeMock).toHaveBeenCalledOnce()
		})

		it("returns description failures after stripping with placeholders", async () => {
			vi.mocked(getLatestMessages).mockReturnValue([
				{ role: "user", content: [{ type: "image", data: "broken-image", mimeType: "image/png" }] },
			] as never)
			completeMock.mockRejectedValue(new Error("caption failed"))
			const diagnostic = vi.spyOn(console, "error").mockImplementation(() => {})

			const result = await stripSessionImages(createMockCtx() as never)

			expect(result).toMatchObject({ status: "stripped", processedCount: 0, errors: ["caption failed"] })
			expect(markImagesAsStripped).toHaveBeenCalledTimes(2) // beforeEach and completion
			diagnostic.mockRestore()
		})

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

		it.each(["identity", "request"])("describes images when %s persistence fails", async (stage) => {
			vi.mocked(getLatestMessages).mockReturnValue([
				{ role: "user", content: [{ type: "image", data: "image-data", mimeType: "image/png" }] },
			] as never)
			completeMock.mockResolvedValue({ content: [{ type: "text", text: "saved description" }], stopReason: "stop" })
			const blockLedger = () => {
				vi.spyOn(backendFor(attributionDir), "insertRecord").mockImplementation(() => {
					throw new Error("attribution storage unavailable")
				})
			}
			if (stage === "identity") blockLedger()
			const ctx = createMockCtx({
				modelRegistry: {
					getAvailable: () => [],
					getApiKeyAndHeaders: async () => {
						if (stage === "request") blockLedger()
						return { ok: true, apiKey: "key", headers: { "X-Test": "preserved" } }
					},
				},
			})
			stripImagesExtension(mockPi as never)
			const handler = mockPi.getHandler("strip-images") as (args: string[], ctx: unknown) => Promise<void>
			await handler([], ctx)
			expect(completeMock).toHaveBeenCalledOnce()
			expect(completeMock.mock.calls[0][2].headers).toEqual({ "X-Test": "preserved" })
			expect(storeImageDescription).toHaveBeenCalledWith("test-hash", "saved description")
			expect(mockNotify).toHaveBeenCalledWith(expect.stringContaining("Work attribution unavailable"), "warning")
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
			const usage = backendFor(attributionDir)
				.readRecords({})
				.map((row) => JSON.parse(row.body))
				.filter((row) => row.nativeUsage)
			expect(usage).toHaveLength(1)
			expect(usage[0].nativeUsage).toMatchObject({ finalized: true, raw: {} })
		})
	})
})
