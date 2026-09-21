import { beforeEach, describe, expect, it, vi } from "vitest"

// ---------------------------------------------------------------------------
// Mocks — must be declared before imports that trigger module evaluation
// ---------------------------------------------------------------------------

vi.mock("../../api/me.js", () => ({
	getMe: vi.fn(),
}))

vi.mock("../../config.js", () => ({
	loadConfig: vi.fn(),
}))

import { getMe } from "../../api/me.js"
import { loadConfig } from "../../config.js"
import {
	_resetAutoDefaultGateCache,
	_setAutoDefaultGateCache,
	isAutoEntitledUser,
	isCastAiEmail,
	shouldDefaultToAuto,
	warmAutoDefaultGate,
} from "./auto-default-gate.js"

const getMeMock = vi.mocked(getMe)
const loadConfigMock = vi.mocked(loadConfig)

function mockApiKey(apiKey: string | undefined): void {
	loadConfigMock.mockReturnValue({ apiKey } as ReturnType<typeof loadConfig>)
}

beforeEach(() => {
	vi.clearAllMocks()
	_resetAutoDefaultGateCache()
})

describe("isCastAiEmail", () => {
	it.each(["alice@cast.ai", "ALICE@CAST.AI", "  alice@cast.ai  "])("accepts %s", (email) => {
		expect(isCastAiEmail(email)).toBe(true)
	})

	it.each(["alice@sub.cast.ai", "alice@notcast.ai", "alice@example.com"])("rejects %s", (email) => {
		expect(isCastAiEmail(email)).toBe(false)
	})
})

describe("isCastAiEmail malformed input", () => {
	it.each([["cast.ai"], [""], ["@"], ["alice@"], [undefined]])("rejects %s", (email) => {
		expect(isCastAiEmail(email as string | undefined)).toBe(false)
	})
})

describe("isAutoEntitledUser", () => {
	it("is false before the lookup resolves", () => {
		expect(isAutoEntitledUser()).toBe(false)
	})

	it("reflects the cached lookup result for sync render paths", async () => {
		mockApiKey("key-1")
		getMeMock.mockResolvedValue({ id: "user-1", email: "alice@cast.ai" })

		await shouldDefaultToAuto()

		expect(isAutoEntitledUser()).toBe(true)
	})

	it("stays false for a non-cast.ai account", async () => {
		mockApiKey("key-1")
		getMeMock.mockResolvedValue({ id: "user-1", email: "bob@example.com" })

		await shouldDefaultToAuto()

		expect(isAutoEntitledUser()).toBe(false)
	})

	it("can be seeded directly for discovery-filter tests", () => {
		_setAutoDefaultGateCache(true)
		expect(isAutoEntitledUser()).toBe(true)
		_setAutoDefaultGateCache(false)
		expect(isAutoEntitledUser()).toBe(false)
	})
})

describe("warmAutoDefaultGate", () => {
	it("starts the lookup without blocking so sync readers see the cached result", async () => {
		mockApiKey("key-1")
		getMeMock.mockResolvedValue({ id: "user-1", email: "alice@cast.ai" })

		warmAutoDefaultGate()
		await vi.waitFor(() => expect(isAutoEntitledUser()).toBe(true))

		expect(getMeMock).toHaveBeenCalledTimes(1)
	})
})

describe("shouldDefaultToAuto", () => {
	it("returns true for a cast.ai account", async () => {
		mockApiKey("key-1")
		getMeMock.mockResolvedValue({ id: "user-1", email: "alice@cast.ai" })

		await expect(shouldDefaultToAuto()).resolves.toBe(true)
		expect(getMeMock).toHaveBeenCalledWith("key-1", expect.objectContaining({ signal: expect.anything() }))
	})

	it("returns false for a non-cast.ai account", async () => {
		mockApiKey("key-1")
		getMeMock.mockResolvedValue({ id: "user-1", email: "bob@example.com" })

		await expect(shouldDefaultToAuto()).resolves.toBe(false)
	})

	it("returns false when the profile has no email", async () => {
		mockApiKey("key-1")
		getMeMock.mockResolvedValue({ id: "user-1" })

		await expect(shouldDefaultToAuto()).resolves.toBe(false)
	})

	it("caches the result so repeated session starts do not re-hit the network", async () => {
		mockApiKey("key-1")
		getMeMock.mockResolvedValue({ id: "user-1", email: "alice@cast.ai" })

		await expect(shouldDefaultToAuto()).resolves.toBe(true)
		await expect(shouldDefaultToAuto()).resolves.toBe(true)

		expect(getMeMock).toHaveBeenCalledTimes(1)
	})

	it("caches negative results too", async () => {
		mockApiKey("key-1")
		getMeMock.mockResolvedValue({ id: "user-1", email: "bob@example.com" })

		await expect(shouldDefaultToAuto()).resolves.toBe(false)
		await expect(shouldDefaultToAuto()).resolves.toBe(false)

		expect(getMeMock).toHaveBeenCalledTimes(1)
	})

	it("shares one in-flight lookup between concurrent callers", async () => {
		mockApiKey("key-1")
		getMeMock.mockResolvedValue({ id: "user-1", email: "alice@cast.ai" })

		const [first, second] = await Promise.all([shouldDefaultToAuto(), shouldDefaultToAuto()])

		expect(first).toBe(true)
		expect(second).toBe(true)
		expect(getMeMock).toHaveBeenCalledTimes(1)
	})
})

describe("shouldDefaultToAuto error handling", () => {
	it("falls back to multi-model when no API key is configured", async () => {
		mockApiKey(undefined)

		await expect(shouldDefaultToAuto()).resolves.toBe(false)
		expect(getMeMock).not.toHaveBeenCalled()
	})

	it("falls back to multi-model when the lookup fails", async () => {
		mockApiKey("key-1")
		getMeMock.mockRejectedValue(new Error("network failure"))

		await expect(shouldDefaultToAuto()).resolves.toBe(false)
	})

	it("falls back to multi-model when the lookup times out", async () => {
		mockApiKey("key-1")
		getMeMock.mockRejectedValue(Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" }))

		await expect(shouldDefaultToAuto()).resolves.toBe(false)
	})

	it("does not retry after a failure within the same process", async () => {
		mockApiKey("key-1")
		getMeMock.mockRejectedValue(new Error("network failure"))

		await expect(shouldDefaultToAuto()).resolves.toBe(false)
		await expect(shouldDefaultToAuto()).resolves.toBe(false)

		expect(getMeMock).toHaveBeenCalledTimes(1)
	})
})
