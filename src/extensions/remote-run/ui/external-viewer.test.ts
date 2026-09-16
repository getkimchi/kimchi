import type { execFileSync } from "node:child_process"
import { describe, expect, it, vi } from "vitest"
import { openExternalDiff } from "./external-viewer.js"

describe("openExternalDiff", () => {
	it("prefers a known GUI editor from GIT_EDITOR over the OS opener", () => {
		const exec = vi.fn(() => Buffer.from("")) as unknown as typeof execFileSync

		const result = openExternalDiff("/tmp/x.patch", {
			env: { GIT_EDITOR: "code --wait", EDITOR: "vim" },
			platform: "darwin",
			_exec: exec,
		})

		expect(result.opened).toBe(true)
		expect((exec as unknown as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
			"code",
			["--wait", "/tmp/x.patch"],
			expect.anything(),
		])
	})

	it("prefers VISUAL before EDITOR (git precedence)", () => {
		const exec = vi.fn(() => Buffer.from("")) as unknown as typeof execFileSync

		openExternalDiff("/tmp/x.patch", {
			env: { VISUAL: "cursor", EDITOR: "zed" },
			platform: "darwin",
			_exec: exec,
		})

		expect((exec as unknown as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
			"cursor",
			["/tmp/x.patch"],
			expect.anything(),
		])
	})

	it("skips terminal editors (never hijacks the TUI) and uses the OS opener", () => {
		const exec = vi.fn(() => Buffer.from("")) as unknown as typeof execFileSync

		const result = openExternalDiff("/tmp/x.patch", {
			env: { EDITOR: "vim" },
			platform: "darwin",
			_exec: exec,
		})

		expect(result.opened).toBe(true)
		expect((exec as unknown as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
			"open",
			["/tmp/x.patch"],
			expect.anything(),
		])
	})

	it("uses the platform opener: xdg-open on linux, start on windows", () => {
		for (const [platform, expected] of [
			["linux", "xdg-open"],
			["darwin", "open"],
			["win32", "cmd"],
		] as const) {
			const exec = vi.fn(() => Buffer.from("")) as unknown as typeof execFileSync
			const result = openExternalDiff("/tmp/x.patch", { env: {}, platform, _exec: exec })
			expect(result.opened).toBe(true)
			expect((exec as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(expected)
		}
	})

	it("never throws: exec failures become a reported detail", () => {
		const exec = vi.fn(() => {
			throw new Error("spawn ENOENT")
		}) as unknown as typeof execFileSync

		const result = openExternalDiff("/tmp/x.patch", { env: {}, platform: "linux", _exec: exec })

		expect(result.opened).toBe(false)
		expect(result.detail).toContain("xdg-open failed: spawn ENOENT")
	})
})
