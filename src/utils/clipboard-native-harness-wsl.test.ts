/**
 * Tests for the WSL / headless Linux guard inside clipboard-native-harness.ts.
 *
 * We test the exported `hasDisplayServer` helper directly so the tests work
 * on all platforms (macOS CI, Linux, WSL) without trying to load the native
 * .node binding.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

beforeEach(() => {
	vi.resetModules()
})

afterEach(() => {
	vi.unstubAllEnvs()
})

async function freshHasDisplayServer(): Promise<() => boolean> {
	const mod = await import("./clipboard-native-harness.js")
	return mod.hasDisplayServer
}

describe("hasDisplayServer — WSL / headless Linux guard", () => {
	it("returns false on WSL when WSL_DISTRO_NAME is set", async () => {
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu")
		vi.stubEnv("WSL_INTEROP", "")
		vi.stubEnv("DISPLAY", "")
		vi.stubEnv("WAYLAND_DISPLAY", "")
		vi.stubEnv("KIMCHI_CLIPBOARD_FORCE", "")

		const hasDisplayServer = await freshHasDisplayServer()
		// Simulate linux platform logic inline (function reads process.platform)
		// On non-linux hosts the guard returns true immediately; test the logic
		// via the exported helper which only applies the guard on linux.
		// We call it and accept that on macOS/win32 it returns true (correct).
		if (process.platform === "linux") {
			expect(hasDisplayServer()).toBe(false)
		} else {
			// On macOS/Windows the function correctly returns true; WSL cannot
			// run there so the check is a no-op.
			expect(hasDisplayServer()).toBe(true)
		}
	})

	it("returns false on WSL when WSL_INTEROP is set (even if WSLg sets DISPLAY)", async () => {
		vi.stubEnv("WSL_DISTRO_NAME", "")
		vi.stubEnv("WSL_INTEROP", "/run/WSL/1_interop")
		vi.stubEnv("DISPLAY", ":0") // WSLg sets this even without a real X server
		vi.stubEnv("WAYLAND_DISPLAY", "")
		vi.stubEnv("KIMCHI_CLIPBOARD_FORCE", "")

		const hasDisplayServer = await freshHasDisplayServer()
		if (process.platform === "linux") {
			expect(hasDisplayServer()).toBe(false)
		} else {
			expect(hasDisplayServer()).toBe(true)
		}
	})

	it("returns true when KIMCHI_CLIPBOARD_FORCE=1 even on WSL", async () => {
		vi.stubEnv("WSL_DISTRO_NAME", "Ubuntu")
		vi.stubEnv("WSL_INTEROP", "/run/WSL/1_interop")
		vi.stubEnv("DISPLAY", ":0")
		vi.stubEnv("KIMCHI_CLIPBOARD_FORCE", "1")

		const hasDisplayServer = await freshHasDisplayServer()
		// Force flag overrides WSL check on all platforms
		expect(hasDisplayServer()).toBe(true)
	})

	it("returns false on headless Linux (no DISPLAY, no WAYLAND, no WSL)", async () => {
		vi.stubEnv("WSL_DISTRO_NAME", "")
		vi.stubEnv("WSL_INTEROP", "")
		vi.stubEnv("DISPLAY", "")
		vi.stubEnv("WAYLAND_DISPLAY", "")
		vi.stubEnv("KIMCHI_CLIPBOARD_FORCE", "")

		const hasDisplayServer = await freshHasDisplayServer()
		if (process.platform === "linux") {
			expect(hasDisplayServer()).toBe(false)
		} else {
			expect(hasDisplayServer()).toBe(true)
		}
	})

	it("returns true on Linux with DISPLAY set and no WSL", async () => {
		vi.stubEnv("WSL_DISTRO_NAME", "")
		vi.stubEnv("WSL_INTEROP", "")
		vi.stubEnv("DISPLAY", ":1")
		vi.stubEnv("WAYLAND_DISPLAY", "")
		vi.stubEnv("KIMCHI_CLIPBOARD_FORCE", "")

		const hasDisplayServer = await freshHasDisplayServer()
		// On linux: DISPLAY is set and no WSL → should return true
		// On macOS/win32: always returns true
		expect(hasDisplayServer()).toBe(true)
	})

	it("returns true on Linux with WAYLAND_DISPLAY set and no WSL", async () => {
		vi.stubEnv("WSL_DISTRO_NAME", "")
		vi.stubEnv("WSL_INTEROP", "")
		vi.stubEnv("DISPLAY", "")
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0")
		vi.stubEnv("KIMCHI_CLIPBOARD_FORCE", "")

		const hasDisplayServer = await freshHasDisplayServer()
		expect(hasDisplayServer()).toBe(true)
	})
})
