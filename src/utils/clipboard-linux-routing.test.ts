/**
 * Red-green regression tests for the Linux clipboard subprocess routing.
 *
 * These tests run only on Linux (CI workers are Linux-based). They verify
 * that getNativeClipboard() routes through the xclip/wl-paste subprocess
 * shim rather than the native .node addon. If the routing is removed or
 * reverted, these tests fail.
 *
 * Strategy: mock node:child_process (so spawnSync is interceptable) but do
 * NOT mock clipboard-native-harness — load the real module to exercise the
 * actual routing logic.
 */
import { spawnSync } from "node:child_process"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }))

const mockSpawn = vi.mocked(spawnSync)

function stubSpawn(stdout: string, status = 0) {
	// biome-ignore lint/suspicious/noExplicitAny: test mock
	mockSpawn.mockReturnValue({ stdout, stderr: "", status, pid: 1, signal: null, output: [] } as any)
}

beforeEach(() => {
	vi.resetModules()
	vi.clearAllMocks()
	stubSpawn("image/png\ntext/plain\n")
})

afterEach(() => {
	vi.unstubAllEnvs()
})

describe("Linux clipboard subprocess routing", () => {
	it("returns subprocess-backed clipboard on X11 Linux", async () => {
		if (process.platform !== "linux") return

		vi.stubEnv("DISPLAY", ":0")
		vi.stubEnv("WAYLAND_DISPLAY", "")
		vi.stubEnv("WSL_DISTRO_NAME", "")
		vi.stubEnv("WSL_INTEROP", "")
		vi.stubEnv("TERMUX_VERSION", "")
		vi.stubEnv("KIMCHI_CLIPBOARD_FORCE", "")

		const { getNativeClipboard } = await import("./clipboard-native-harness.js")
		const { clipboard } = getNativeClipboard()

		expect(clipboard).not.toBeNull()
		expect(typeof clipboard?.availableFormats).toBe("function")
		expect(typeof clipboard?.hasImage).toBe("function")
		expect(typeof clipboard?.getImageBinary).toBe("function")
	})

	it("invokes xclip for availableFormats on X11", async () => {
		if (process.platform !== "linux") return

		vi.stubEnv("DISPLAY", ":0")
		vi.stubEnv("WAYLAND_DISPLAY", "")
		vi.stubEnv("WSL_DISTRO_NAME", "")
		vi.stubEnv("WSL_INTEROP", "")
		vi.stubEnv("TERMUX_VERSION", "")

		const { getNativeClipboard } = await import("./clipboard-native-harness.js")
		const { clipboard } = getNativeClipboard()
		clipboard?.availableFormats()

		expect(mockSpawn).toHaveBeenCalledWith(
			"xclip",
			["-selection", "clipboard", "-t", "TARGETS", "-o"],
			expect.objectContaining({ encoding: "utf8" }),
		)
	})

	it("invokes wl-paste for availableFormats on Wayland", async () => {
		if (process.platform !== "linux") return

		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0")
		vi.stubEnv("DISPLAY", "")
		vi.stubEnv("WSL_DISTRO_NAME", "")
		vi.stubEnv("WSL_INTEROP", "")
		vi.stubEnv("TERMUX_VERSION", "")

		const { getNativeClipboard } = await import("./clipboard-native-harness.js")
		const { clipboard } = getNativeClipboard()
		clipboard?.availableFormats()

		expect(mockSpawn).toHaveBeenCalledWith("wl-paste", ["--list-types"], expect.objectContaining({ encoding: "utf8" }))
	})

	it("does not call spawnSync on non-Linux platforms", async () => {
		if (process.platform === "linux") return

		const { getNativeClipboard } = await import("./clipboard-native-harness.js")
		getNativeClipboard()

		// Non-Linux should not touch xclip/wl-paste at all
		expect(mockSpawn).not.toHaveBeenCalled()
	})
})
