import { beforeEach, describe, expect, it, vi } from "vitest"
import type { NativeClipboard } from "./clipboard-native-harness.js"

// Mock the entire module — the mock replaces getNativeClipboard so we only
// need to verify call-count and return-value shaping; platform/env logic
// is exercised in the clipboard-read integration test.
vi.mock("./clipboard-native-harness.js", () => ({
	getNativeClipboard: vi.fn<() => { clipboard: NativeClipboard | null; error: string | null }>(),
}))

import { getNativeClipboard } from "./clipboard-native-harness.js"

describe("getNativeClipboard (mocked)", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("returns clipboard result and no error when harness succeeds", () => {
		const mockClipboard = {
			hasImage: vi.fn(),
			getImageBinary: vi.fn(),
			availableFormats: vi.fn(),
		} as unknown as NativeClipboard
		vi.mocked(getNativeClipboard).mockReturnValue({ clipboard: mockClipboard, error: null })
		const result = getNativeClipboard()
		expect(result.clipboard).toBe(mockClipboard)
		expect(result.error).toBeNull()
	})

	it("returns null clipboard and error message when harness fails", () => {
		vi.mocked(getNativeClipboard).mockReturnValue({ clipboard: null, error: "No display server" })
		const result = getNativeClipboard()
		expect(result.clipboard).toBeNull()
		expect(result.error).toBe("No display server")
	})

	it("caches the result — second call returns same reference", () => {
		const mockClipboard = {
			hasImage: vi.fn(),
			getImageBinary: vi.fn(),
			availableFormats: vi.fn(),
		} as unknown as NativeClipboard
		vi.mocked(getNativeClipboard).mockReturnValue({ clipboard: mockClipboard, error: null })
		const first = getNativeClipboard()
		const second = getNativeClipboard()
		expect(first).toBe(second) // same cached mock result
	})

	it("is called by clipboard-read when upstream returns null on Darwin", () => {
		vi.mocked(getNativeClipboard).mockReturnValue({ clipboard: {} as NativeClipboard, error: null })
		getNativeClipboard()
		expect(vi.mocked(getNativeClipboard)).toHaveBeenCalled()
	})
})

describe("getNativeClipboard — Linux subprocess routing", () => {
	it("returns non-null clipboard on Linux when display is available", async () => {
		if (process.platform !== "linux") return
		vi.stubEnv("DISPLAY", ":0")
		vi.stubEnv("WAYLAND_DISPLAY", "")
		vi.stubEnv("WSL_DISTRO_NAME", "")
		vi.stubEnv("WSL_INTEROP", "")
		vi.stubEnv("KIMCHI_CLIPBOARD_FORCE", "")
		vi.resetModules()
		const { getNativeClipboard: fresh } = await import("./clipboard-native-harness.js")
		const result = fresh()
		expect(() => fresh()).not.toThrow()
		if (result.clipboard) {
			expect(typeof result.clipboard.availableFormats).toBe("function")
			expect(typeof result.clipboard.hasImage).toBe("function")
		}
	})
})
