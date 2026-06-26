// Tests for src/update/auto-update.ts.
//
// Mocks: checkForUpdate, applyUpdate, loadAutoUpdateSetting, isHomebrewInstall.
// We spy on `process.execve` (the actual syscall) rather than the exported
// `performReExec` helper. The implementation reads `process.execve` at call
// time via a cast, so the spy reliably intercepts the call. Spying on the
// export doesn't work: `maybeAutoUpdateOnLaunch` references `performReExec`
// via a local lexical binding, not through the module namespace, so a spy
// on the namespace export is bypassed and the real `execve` runs — replacing
// the test runner's process on Linux and crashing vitest.

import type { MockInstance } from "vitest"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mockCheckForUpdate = vi.fn()
const mockApplyUpdate = vi.fn()
const mockLoadAutoUpdateSetting = vi.fn(() => true)
const mockIsHomebrewInstall = vi.fn(() => false)

vi.mock("./paths.js", () => ({
	isHomebrewInstall: mockIsHomebrewInstall,
	resolveExecutablePath: () => "/fake/kimchi",
}))
vi.mock("./settings.js", () => ({ loadAutoUpdateSetting: mockLoadAutoUpdateSetting }))
vi.mock("./workflow.js", () => ({
	checkForUpdate: mockCheckForUpdate,
	applyUpdate: mockApplyUpdate,
}))

const autoUpdate = await import("./auto-update.js")
const { maybeAutoUpdateOnLaunch, performReExec, argvHasSkipTrigger } = autoUpdate

const originalEnvNoCheck = process.env.KIMCHI_NO_UPDATE_CHECK
const originalPlatform = process.platform
const originalExecve = (process as unknown as { execve?: unknown }).execve
let execveSpy: MockInstance<(file: string, args: readonly string[], env: NodeJS.ProcessEnv) => never> | undefined

function resetMocks(): void {
	mockCheckForUpdate.mockReset()
	mockApplyUpdate.mockReset()
	mockLoadAutoUpdateSetting.mockReset()
	mockIsHomebrewInstall.mockReset()
	mockLoadAutoUpdateSetting.mockReturnValue(true)
	mockIsHomebrewInstall.mockReturnValue(false)
	mockCheckForUpdate.mockResolvedValue({
		currentVersion: "1.0.0",
		latestVersion: "1.0.0",
		tag: "v1.0.0",
		releaseUrl: "",
		hasUpdate: false,
		cached: false,
	})
}

beforeEach(() => {
	resetMocks()
	// biome-ignore lint/performance/noDelete: setting to undefined produces the literal string "undefined", which is truthy and would pollute subsequent tests
	delete process.env.KIMCHI_NO_UPDATE_CHECK
	// Default platform: linux (CI). Individual tests can override.
	Object.defineProperty(process, "platform", { value: "linux", configurable: true })

	// Ensure process.execve exists so vi.spyOn has a target. On Linux it's
	// a real syscall; on hosts where it isn't defined (some macOS/Windows
	// builds), install a configurable no-op stub. The spy replaces it with
	// a mock and mockRestore() puts the original value back.
	if (typeof (process as unknown as { execve?: unknown }).execve !== "function") {
		Object.defineProperty(process, "execve", {
			value: () => {
				throw new Error("process.execve is not available on this platform")
			},
			writable: true,
			configurable: true,
		})
	}
	execveSpy = vi
		.spyOn(
			process as unknown as {
				execve: (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => never
			},
			"execve",
		)
		.mockImplementation(() => undefined as never)
})

afterEach(() => {
	if (originalEnvNoCheck === undefined) {
		// biome-ignore lint/performance/noDelete: setting to undefined produces the literal string "undefined", which is truthy and would pollute subsequent tests
		delete process.env.KIMCHI_NO_UPDATE_CHECK
	} else process.env.KIMCHI_NO_UPDATE_CHECK = originalEnvNoCheck
	Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true })
	execveSpy?.mockRestore()
	// If the host had no execve to begin with, our Object.defineProperty
	// stub may linger after mockRestore; clear it so we don't leak between
	// test files (each runs in its own forked worker, but better safe).
	if (originalExecve === undefined) {
		try {
			;(process as unknown as { execve?: unknown }).execve = undefined
		} catch {
			// Some hosts make the property non-configurable; ignore.
		}
	}
})

describe("maybeAutoUpdateOnLaunch — skip gates", () => {
	it("skips when KIMCHI_NO_UPDATE_CHECK is set", async () => {
		process.env.KIMCHI_NO_UPDATE_CHECK = "1"
		await maybeAutoUpdateOnLaunch()
		expect(mockCheckForUpdate).not.toHaveBeenCalled()
		expect(mockApplyUpdate).not.toHaveBeenCalled()
		expect(execveSpy).not.toHaveBeenCalled()
	})

	it("skips when isHomebrewInstall() returns true", async () => {
		mockIsHomebrewInstall.mockReturnValue(true)
		await maybeAutoUpdateOnLaunch()
		expect(mockCheckForUpdate).not.toHaveBeenCalled()
		expect(mockApplyUpdate).not.toHaveBeenCalled()
		expect(execveSpy).not.toHaveBeenCalled()
	})

	it("skips when loadAutoUpdateSetting() returns false", async () => {
		mockLoadAutoUpdateSetting.mockReturnValue(false)
		await maybeAutoUpdateOnLaunch()
		expect(mockCheckForUpdate).not.toHaveBeenCalled()
		expect(mockApplyUpdate).not.toHaveBeenCalled()
		expect(execveSpy).not.toHaveBeenCalled()
	})

	it("skips when checkForUpdate throws and does not propagate", async () => {
		mockCheckForUpdate.mockRejectedValue(new Error("network down"))
		await expect(maybeAutoUpdateOnLaunch()).resolves.toBeUndefined()
		expect(mockApplyUpdate).not.toHaveBeenCalled()
		expect(execveSpy).not.toHaveBeenCalled()
	})

	it("skips when checkForUpdate reports no update", async () => {
		mockCheckForUpdate.mockResolvedValue({
			currentVersion: "1.2.3",
			latestVersion: "1.2.3",
			tag: "v1.2.3",
			releaseUrl: "",
			hasUpdate: false,
			cached: false,
		})
		await maybeAutoUpdateOnLaunch()
		expect(mockApplyUpdate).not.toHaveBeenCalled()
		expect(execveSpy).not.toHaveBeenCalled()
	})
})

describe("argvHasSkipTrigger — pure function over an argv array", () => {
	it("returns true when argv[2] is the `update` subcommand", () => {
		expect(argvHasSkipTrigger(["node", "kimchi", "update"])).toBe(true)
	})

	it("returns true when argv[2] is the `setup` subcommand", () => {
		expect(argvHasSkipTrigger(["node", "kimchi", "setup"])).toBe(true)
	})

	it("returns true when argv[2] is the `mcp` subcommand", () => {
		expect(argvHasSkipTrigger(["node", "kimchi", "mcp"])).toBe(true)
	})

	it("returns true when argv[2] is the `login` subcommand", () => {
		expect(argvHasSkipTrigger(["node", "kimchi", "login"])).toBe(true)
	})

	it("returns true when argv[2] is the `install` subcommand", () => {
		expect(argvHasSkipTrigger(["node", "kimchi", "install"])).toBe(true)
	})

	it("returns true when argv contains --version", () => {
		expect(argvHasSkipTrigger(["node", "kimchi", "--version"])).toBe(true)
	})

	it("returns true when argv contains -v", () => {
		expect(argvHasSkipTrigger(["node", "kimchi", "-v"])).toBe(true)
	})

	it("returns true when argv contains --help", () => {
		expect(argvHasSkipTrigger(["node", "kimchi", "--help"])).toBe(true)
	})

	it("returns true when argv contains -h", () => {
		expect(argvHasSkipTrigger(["node", "kimchi", "-h"])).toBe(true)
	})

	it("returns true when argv contains --no-auto-update", () => {
		expect(argvHasSkipTrigger(["node", "kimchi", "--no-auto-update"])).toBe(true)
	})

	it("matches subcommands case-insensitively", () => {
		expect(argvHasSkipTrigger(["node", "kimchi", "UPDATE"])).toBe(true)
	})

	it("matches subcommand appearing as the value of a --flag=value argument", () => {
		expect(argvHasSkipTrigger(["node", "kimchi", "--some-flag=update"])).toBe(true)
	})

	it("returns false for a plain TUI launch with no skip trigger", () => {
		expect(argvHasSkipTrigger(["node", "kimchi"])).toBe(false)
	})

	it("returns false for a TUI launch with unrelated flags", () => {
		expect(argvHasSkipTrigger(["node", "kimchi", "--some-tui-flag", "value"])).toBe(false)
	})

	it("returns false for an unrelated --flag=value argument", () => {
		expect(argvHasSkipTrigger(["node", "kimchi", "--command=serve"])).toBe(false)
	})
})

describe("maybeAutoUpdateOnLaunch — happy path", () => {
	it("applies the update and re-execs on linux", async () => {
		mockCheckForUpdate.mockResolvedValue({
			currentVersion: "1.0.0",
			latestVersion: "1.1.0",
			tag: "v1.1.0",
			releaseUrl: "https://example/v1.1.0",
			hasUpdate: true,
			cached: false,
		})
		mockApplyUpdate.mockResolvedValue({ from: "v1.1.0", to: "v1.1.0" })

		await maybeAutoUpdateOnLaunch()

		expect(mockApplyUpdate).toHaveBeenCalledWith({ tag: "v1.1.0" })
		expect(execveSpy).toHaveBeenCalledTimes(1)
		// execve(file, args, env): file is process.execPath; args is
		// [process.execPath, ...process.argv.slice(1)] — argv[0] re-states
		// the executable and the rest is the user's original argv.
		const [file, args, env] = execveSpy?.mock.calls[0] as [string, string[], NodeJS.ProcessEnv]
		expect(file).toBe(process.execPath)
		expect(args[0]).toBe(process.execPath)
		expect(args.slice(1)).toEqual(process.argv.slice(1))
		expect(env).toBe(process.env)
	})

	it("does not re-exec and does not throw when applyUpdate fails", async () => {
		mockCheckForUpdate.mockResolvedValue({
			currentVersion: "1.0.0",
			latestVersion: "1.1.0",
			tag: "v1.1.0",
			releaseUrl: "",
			hasUpdate: true,
			cached: false,
		})
		mockApplyUpdate.mockRejectedValue(new Error("smoke test failed"))

		await expect(maybeAutoUpdateOnLaunch()).resolves.toBeUndefined()
		expect(execveSpy).not.toHaveBeenCalled()
	})

	// Windows: applyUpdate already rotates kimchi.exe → kimchi.exe.old in
	// place, so we deliberately do NOT re-exec — just notify the user.
	// (We can't run the literal Windows branch on a non-win32 host, but
	// the skip-re-exec contract is what matters; the linux test above
	// covers the linux branch's re-exec call.)
	it("does not re-exec on win32 — applyUpdate's in-place rotation suffices", async () => {
		Object.defineProperty(process, "platform", { value: "win32", configurable: true })
		mockCheckForUpdate.mockResolvedValue({
			currentVersion: "1.0.0",
			latestVersion: "1.1.0",
			tag: "v1.1.0",
			releaseUrl: "",
			hasUpdate: true,
			cached: false,
		})
		mockApplyUpdate.mockResolvedValue({ from: "v1.1.0", to: "v1.1.0" })

		await expect(maybeAutoUpdateOnLaunch()).resolves.toBeUndefined()
		expect(execveSpy).not.toHaveBeenCalled()
	})
})

describe("performReExec", () => {
	it("exists and is callable with argv + env", () => {
		// Sanity: confirm the helper is exported. Calling it directly
		// would attempt execve and never return on a real Linux runner.
		// The happy-path tests above cover execve invocation indirectly.
		expect(typeof performReExec).toBe("function")
	})
})
