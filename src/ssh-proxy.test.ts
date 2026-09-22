import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { findProxyHelper } from "./ssh-proxy.js"

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }))

it("forwards a captured environment credential to proxy-helper without restoring it globally", async () => {
	vi.resetModules()
	vi.stubEnv("KIMCHI_API_KEY", "captured-environment-key")
	const exit = new Error("process exited")
	vi.spyOn(process, "exit").mockImplementation(() => {
		throw exit
	})
	vi.mocked(spawnSync).mockReturnValue({
		pid: 1,
		output: [],
		stdout: Buffer.alloc(0),
		stderr: Buffer.alloc(0),
		status: 0,
		signal: null,
	})
	try {
		const { captureApiKeyFromEnvironment } = await import("./config.js")
		captureApiKeyFromEnvironment()
		const { runProxy } = await import("./ssh-proxy.js")
		expect(() => runProxy("session-id", "/trusted/proxy-helper")).toThrow(exit)
		expect(spawnSync).toHaveBeenCalledWith(
			"/trusted/proxy-helper",
			["ssh-proxy", "session-id"],
			expect.objectContaining({
				env: expect.objectContaining({ KIMCHI_API_KEY: "captured-environment-key" }),
			}),
		)
		expect(process.env.KIMCHI_API_KEY).toBeUndefined()
	} finally {
		vi.unstubAllEnvs()
		vi.restoreAllMocks()
	}
})

describe("findProxyHelper", () => {
	let tmpBase: string

	beforeEach(() => {
		tmpBase = join(tmpdir(), `kimchi-proxy-helper-test-${process.pid}-${Date.now()}`)
		mkdirSync(tmpBase, { recursive: true })
	})

	afterEach(() => {
		rmSync(tmpBase, { recursive: true, force: true })
	})

	it("returns an explicit override without checking the filesystem", () => {
		expect(findProxyHelper("/custom/proxy-helper")).toBe("/custom/proxy-helper")
	})

	it("finds bundled proxy-helper.exe for Windows binary releases", () => {
		const shareDir = join(tmpBase, "share", "kimchi")
		const helper = join(shareDir, "bin", "proxy-helper.exe")
		mkdirSync(join(tmpBase, "bin"), { recursive: true })
		mkdirSync(join(shareDir, "bin"), { recursive: true })
		writeFileSync(join(shareDir, "package.json"), "{}")
		writeFileSync(helper, "")

		expect(
			findProxyHelper(undefined, {
				env: {},
				execPath: join(tmpBase, "bin", "kimchi.exe"),
				home: tmpBase,
				platform: "win32",
				pathDelimiter: ";",
				exists: existsSync,
			}),
		).toBe(helper)
	})

	it("finds bundled proxy-helper for POSIX binary releases", () => {
		const shareDir = join(tmpBase, "share", "kimchi")
		const helper = join(shareDir, "bin", "proxy-helper")
		mkdirSync(join(tmpBase, "bin"), { recursive: true })
		mkdirSync(join(shareDir, "bin"), { recursive: true })
		writeFileSync(join(shareDir, "package.json"), "{}")
		writeFileSync(helper, "")

		expect(
			findProxyHelper(undefined, {
				env: {},
				execPath: join(tmpBase, "bin", "kimchi"),
				home: tmpBase,
				platform: "linux",
				pathDelimiter: ":",
				exists: existsSync,
			}),
		).toBe(helper)
	})

	it("searches Windows PATH entries with semicolon delimiters", () => {
		const first = join(tmpBase, "first")
		const second = join(tmpBase, "second")
		const helper = join(second, "proxy-helper.exe")
		mkdirSync(first, { recursive: true })
		mkdirSync(second, { recursive: true })
		writeFileSync(helper, "")

		expect(
			findProxyHelper(undefined, {
				env: { PATH: `${first};${second}` },
				execPath: join(tmpBase, "bin", "kimchi.exe"),
				home: tmpBase,
				platform: "win32",
				pathDelimiter: ";",
				exists: existsSync,
			}),
		).toBe(helper)
	})

	it("searches POSIX PATH entries with colon delimiters", () => {
		const first = join(tmpBase, "first")
		const second = join(tmpBase, "second")
		const helper = join(second, "proxy-helper")
		mkdirSync(first, { recursive: true })
		mkdirSync(second, { recursive: true })
		writeFileSync(helper, "")

		expect(
			findProxyHelper(undefined, {
				env: { PATH: `${first}:${second}` },
				execPath: join(tmpBase, "bin", "kimchi"),
				home: tmpBase,
				platform: "linux",
				pathDelimiter: ":",
				exists: existsSync,
			}),
		).toBe(helper)
	})
})
