import { spawnSync } from "node:child_process"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }))

const mockSpawn = vi.mocked(spawnSync)

function mockSpawnResult(stdout: string, status = 0) {
	// biome-ignore lint/suspicious/noExplicitAny: test mock
	mockSpawn.mockReturnValue({ stdout, stderr: "", status, pid: 1, signal: null, output: [] } as any)
}

beforeEach(() => {
	vi.resetModules()
	vi.clearAllMocks()
})

afterEach(() => {
	vi.unstubAllEnvs()
})

async function freshShim() {
	const mod = await import("./clipboard-linux-subprocess.js")
	return mod.createLinuxClipboard()
}

describe("availableFormats — X11", () => {
	beforeEach(() => {
		vi.stubEnv("WAYLAND_DISPLAY", "")
		vi.stubEnv("DISPLAY", ":0")
	})

	it("returns MIME types from xclip TARGETS output", async () => {
		mockSpawnResult("TARGETS\nimage/png\ntext/plain\n")
		const cb = await freshShim()
		const formats = cb.availableFormats()
		expect(formats).toContain("image/png")
		expect(formats).toContain("text/plain")
		expect(formats).not.toContain("TARGETS")
	})

	it("returns empty array when xclip fails", async () => {
		// biome-ignore lint/suspicious/noExplicitAny: test mock
		mockSpawn.mockReturnValue({ stdout: "", stderr: "error", status: 1, pid: 1, signal: null, output: [] } as any)
		const cb = await freshShim()
		expect(cb.availableFormats()).toEqual([])
	})

	it("calls xclip with correct args", async () => {
		mockSpawnResult("image/png\n")
		const cb = await freshShim()
		cb.availableFormats()
		expect(mockSpawn).toHaveBeenCalledWith(
			"xclip",
			["-selection", "clipboard", "-t", "TARGETS", "-o"],
			expect.objectContaining({ encoding: "utf8" }),
		)
	})
})

describe("availableFormats — Wayland", () => {
	beforeEach(() => {
		vi.stubEnv("WAYLAND_DISPLAY", "wayland-0")
		vi.stubEnv("DISPLAY", "")
	})

	it("returns MIME types from wl-paste output", async () => {
		mockSpawnResult("image/png\ntext/plain\n")
		const cb = await freshShim()
		const formats = cb.availableFormats()
		expect(formats).toContain("image/png")
	})

	it("calls wl-paste with correct args", async () => {
		mockSpawnResult("image/png\n")
		const cb = await freshShim()
		cb.availableFormats()
		expect(mockSpawn).toHaveBeenCalledWith("wl-paste", ["--list-types"], expect.objectContaining({ encoding: "utf8" }))
	})
})
