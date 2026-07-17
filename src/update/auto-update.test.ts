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
const mockParseCanarySha7 = vi.fn(() => null as string | null)
const mockGetVersion = vi.fn(() => "1.0.0")

vi.mock("./paths.js", () => ({
	isHomebrewInstall: mockIsHomebrewInstall,
	resolveExecutablePath: () => "/fake/kimchi",
}))
vi.mock("./settings.js", () => ({ loadAutoUpdateSetting: mockLoadAutoUpdateSetting }))
vi.mock("./workflow.js", () => ({
	checkForUpdate: mockCheckForUpdate,
	applyUpdate: mockApplyUpdate,
	parseCanarySha7: mockParseCanarySha7,
}))
vi.mock("../utils.js", () => ({ getVersion: mockGetVersion }))

const autoUpdate = await import("./auto-update.js")
const { maybeAutoUpdateOnLaunch, performReExec, argvHasSkipTrigger, isNonInteractiveLaunch, ReExecUnavailableError } =
	autoUpdate

const originalEnvNoCheck = process.env.KIMCHI_NO_UPDATE_CHECK
const originalPlatform = process.platform
const originalExecPath = process.execPath
const originalExecve = (process as unknown as { execve?: unknown }).execve
let execveSpy: MockInstance<(file: string, args: readonly string[], env: NodeJS.ProcessEnv) => never> | undefined

function resetMocks(): void {
	mockCheckForUpdate.mockReset()
	mockApplyUpdate.mockReset()
	mockLoadAutoUpdateSetting.mockReset()
	mockIsHomebrewInstall.mockReset()
	mockParseCanarySha7.mockReset()
	mockGetVersion.mockReset()
	mockLoadAutoUpdateSetting.mockReturnValue(true)
	mockIsHomebrewInstall.mockReturnValue(false)
	mockParseCanarySha7.mockReturnValue(null)
	mockGetVersion.mockReturnValue("1.0.0")
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
	delete process.env.KIMCHI_NO_UPDATE_CHECK
	// Default platform: linux (CI). Individual tests can override.
	Object.defineProperty(process, "platform", { value: "linux", configurable: true })
	// Pretend we're running the packaged kimchi binary so the
	// packaged-binary guard in maybeAutoUpdateOnLaunch lets us through.
	// The test runner's real execPath is `node`, which would be rejected.
	Object.defineProperty(process, "execPath", { value: "/usr/local/bin/kimchi", configurable: true })

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
		delete process.env.KIMCHI_NO_UPDATE_CHECK
	} else process.env.KIMCHI_NO_UPDATE_CHECK = originalEnvNoCheck
	Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true })
	Object.defineProperty(process, "execPath", { value: originalExecPath, configurable: true })
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

	it("skips when running on a canary build", async () => {
		mockParseCanarySha7.mockReturnValue("abc1234")
		await maybeAutoUpdateOnLaunch()
		expect(mockCheckForUpdate).not.toHaveBeenCalled()
		expect(mockApplyUpdate).not.toHaveBeenCalled()
		expect(execveSpy).not.toHaveBeenCalled()
	})

	it("skips when caller signal is already aborted", async () => {
		const controller = new AbortController()
		controller.abort()
		await maybeAutoUpdateOnLaunch({ signal: controller.signal })
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

	it("skips when getVersion() is 'dev' (source/dev launch)", async () => {
		mockGetVersion.mockReturnValue("dev")
		await maybeAutoUpdateOnLaunch()
		expect(mockCheckForUpdate).not.toHaveBeenCalled()
		expect(mockApplyUpdate).not.toHaveBeenCalled()
		expect(execveSpy).not.toHaveBeenCalled()
	})

	it("skips when getVersion() is 'unknown'", async () => {
		mockGetVersion.mockReturnValue("unknown")
		await maybeAutoUpdateOnLaunch()
		expect(mockCheckForUpdate).not.toHaveBeenCalled()
		expect(mockApplyUpdate).not.toHaveBeenCalled()
		expect(execveSpy).not.toHaveBeenCalled()
	})

	it("skips when process.execPath is not the packaged kimchi binary", async () => {
		Object.defineProperty(process, "execPath", { value: "/usr/local/bin/node", configurable: true })
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

	it("does NOT treat --flag=value as a subcommand", () => {
		expect(argvHasSkipTrigger(["node", "kimchi", "--some-flag=update"])).toBe(false)
	})

	it("does NOT treat a flag value as a subcommand (e.g. --tag=update)", () => {
		expect(argvHasSkipTrigger(["node", "kimchi", "--tag=update"])).toBe(false)
	})

	it("does NOT treat a positional after a flag as a subcommand (e.g. kimchi --some-flag update)", () => {
		// Only argv[2] is checked — scanning later positionals would cause
		// false positives like `kimchi --tag update`.
		expect(argvHasSkipTrigger(["node", "kimchi", "--some-flag", "update"])).toBe(false)
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

describe("isNonInteractiveLaunch — pure function over an argv array", () => {
	it("returns true for --mode=acp", () => {
		expect(isNonInteractiveLaunch(["node", "kimchi", "--mode=acp"])).toBe(true)
	})

	it("returns true for --mode json", () => {
		expect(isNonInteractiveLaunch(["node", "kimchi", "--mode", "json"])).toBe(true)
	})

	it("returns true for --mode=rpc", () => {
		expect(isNonInteractiveLaunch(["node", "kimchi", "--mode=rpc"])).toBe(true)
	})

	it("returns true for --print", () => {
		expect(isNonInteractiveLaunch(["node", "kimchi", "--print"])).toBe(true)
	})

	it("returns true for -p", () => {
		expect(isNonInteractiveLaunch(["node", "kimchi", "-p"])).toBe(true)
	})

	it("returns true for --export", () => {
		expect(isNonInteractiveLaunch(["node", "kimchi", "--export"])).toBe(true)
	})

	it("returns true for --export=file.html", () => {
		expect(isNonInteractiveLaunch(["node", "kimchi", "--export=file.html"])).toBe(true)
	})

	it("returns false for a plain TUI launch", () => {
		expect(isNonInteractiveLaunch(["node", "kimchi"])).toBe(false)
	})

	it("returns false for --mode=tui", () => {
		expect(isNonInteractiveLaunch(["node", "kimchi", "--mode=tui"])).toBe(false)
	})

	it("returns false for unrelated flags", () => {
		expect(isNonInteractiveLaunch(["node", "kimchi", "--theme", "dark"])).toBe(false)
	})
})

describe("maybeAutoUpdateOnLaunch — non-interactive mode skip", () => {
	it("skips when argv selects a non-interactive mode (--mode=acp)", async () => {
		const originalArgv = process.argv
		process.argv = ["node", "kimchi", "--mode=acp"]
		try {
			await maybeAutoUpdateOnLaunch()
			expect(mockCheckForUpdate).not.toHaveBeenCalled()
			expect(mockApplyUpdate).not.toHaveBeenCalled()
			expect(execveSpy).not.toHaveBeenCalled()
		} finally {
			process.argv = originalArgv
		}
	})

	it("skips when argv contains --print", async () => {
		const originalArgv = process.argv
		process.argv = ["node", "kimchi", "--print"]
		try {
			await maybeAutoUpdateOnLaunch()
			expect(mockCheckForUpdate).not.toHaveBeenCalled()
		} finally {
			process.argv = originalArgv
		}
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
		// [process.execPath, ...userArgs] where userArgs is process.argv.slice(2)
		// — argv[0] re-states the executable, argv[1] (the launcher's own
		// entry / a /$bunfs/… virtual path) is intentionally dropped, and the
		// rest is the user's original args.
		const [file, args, env] = execveSpy?.mock.calls[0] as [string, string[], NodeJS.ProcessEnv]
		expect(file).toBe(process.execPath)
		expect(args[0]).toBe(process.execPath)
		expect(args.slice(1)).toEqual(process.argv.slice(2))
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

describe("maybeAutoUpdateOnLaunch — deadline / abort handling", () => {
	function makeStderrSpy() {
		const originalWrite = process.stderr.write.bind(process.stderr)
		const spy = vi.fn((_chunk: string | Uint8Array, _enc?: unknown, _cb?: unknown) => true)
		;(process.stderr.write as unknown) = spy
		return {
			spy,
			restore: () => {
				;(process.stderr.write as unknown) = originalWrite
			},
			getLines: () => spy.mock.calls.map((c) => String(c[0])).join(""),
		}
	}

	it("skips re-exec when signal aborts during checkForUpdate", async () => {
		const controller = new AbortController()
		mockCheckForUpdate.mockImplementation(async () => {
			controller.abort()
			return {
				currentVersion: "1.0.0",
				latestVersion: "1.1.0",
				tag: "v1.1.0",
				releaseUrl: "https://example/v1.1.0",
				hasUpdate: true,
				cached: false,
			}
		})

		await expect(maybeAutoUpdateOnLaunch({ signal: controller.signal })).resolves.toBeUndefined()
		expect(mockApplyUpdate).not.toHaveBeenCalled()
		expect(execveSpy).not.toHaveBeenCalled()
	})

	it("proceeds with re-exec after applyUpdate completes even if signal aborts mid-install", async () => {
		const controller = new AbortController()
		mockCheckForUpdate.mockResolvedValue({
			currentVersion: "1.0.0",
			latestVersion: "1.1.0",
			tag: "v1.1.0",
			releaseUrl: "https://example/v1.1.0",
			hasUpdate: true,
			cached: false,
		})
		mockApplyUpdate.mockImplementation(async () => {
			controller.abort()
			return { from: "v1.1.0", to: "v1.1.0" }
		})

		// Once applyUpdate has committed, we proceed with re-exec regardless
		// of signal state — the install must complete atomically.
		await expect(maybeAutoUpdateOnLaunch({ signal: controller.signal })).resolves.toBeUndefined()
		expect(mockApplyUpdate).toHaveBeenCalledOnce()
		expect(execveSpy).toHaveBeenCalledOnce()
	})

	it("skips re-exec when applyUpdate times out", async () => {
		vi.useFakeTimers()
		const originalWrite = process.stderr.write.bind(process.stderr)
		const writeSpy = vi.fn((_chunk: string | Uint8Array, _enc?: unknown, _cb?: unknown) => true)
		;(process.stderr.write as unknown) = writeSpy
		try {
			mockCheckForUpdate.mockResolvedValue({
				currentVersion: "1.0.0",
				latestVersion: "1.1.0",
				tag: "v1.1.0",
				releaseUrl: "https://example/v1.1.0",
				hasUpdate: true,
				cached: false,
			})
			// Never resolves — simulates a hung download
			mockApplyUpdate.mockReturnValue(new Promise(() => {}))

			const pending = maybeAutoUpdateOnLaunch()
			// Advance past both the 5s check timeout and the 30s apply timeout
			await vi.advanceTimersByTimeAsync(31_000)
			await expect(pending).resolves.toBeUndefined()

			expect(mockApplyUpdate).toHaveBeenCalledOnce()
			expect(execveSpy).not.toHaveBeenCalled()
			const lines = writeSpy.mock.calls.map((c) => String(c[0])).join("")
			expect(lines).toContain("timed out")
		} finally {
			vi.useRealTimers()
			;(process.stderr.write as unknown) = originalWrite
		}
	})

	it("logs an audit line with tag + releaseUrl before applying", async () => {
		const stderr = makeStderrSpy()
		try {
			mockCheckForUpdate.mockResolvedValue({
				currentVersion: "1.0.0",
				latestVersion: "1.1.0",
				tag: "v1.1.0",
				releaseUrl: "https://github.com/getkimchi/kimchi/releases/tag/v1.1.0",
				hasUpdate: true,
				cached: false,
			})
			mockApplyUpdate.mockResolvedValue({ from: "v1.1.0", to: "v1.1.0" })

			await maybeAutoUpdateOnLaunch()

			const lines = stderr.getLines()
			expect(lines).toContain(
				"[kimchi-auto-update] applying update v1.1.0 from https://github.com/getkimchi/kimchi/releases/tag/v1.1.0\n",
			)
		} finally {
			stderr.restore()
		}
	})

	it("logs `<no url>` in the audit line when releaseUrl is empty", async () => {
		const stderr = makeStderrSpy()
		try {
			mockCheckForUpdate.mockResolvedValue({
				currentVersion: "1.0.0",
				latestVersion: "1.1.0",
				tag: "v1.1.0",
				releaseUrl: "",
				hasUpdate: true,
				cached: false,
			})
			mockApplyUpdate.mockResolvedValue({ from: "v1.1.0", to: "v1.1.0" })

			await maybeAutoUpdateOnLaunch()

			const lines = stderr.getLines()
			expect(lines).toContain("[kimchi-auto-update] applying update v1.1.0 from <no url>\n")
		} finally {
			stderr.restore()
		}
	})
})

describe("performReExec — re-exec primitive selection", () => {
	// These tests drive performReExec directly with controlled
	// process.execve / globalThis.Bun state. beforeEach installs an execve
	// stub + spy (see top of file); we override per-test as needed and the
	// global afterEach restores execve. We additionally save/restore
	// globalThis.Bun and process.exit here.
	const hadBun = Object.hasOwn(globalThis, "Bun")
	const originalBun = (globalThis as unknown as { Bun?: unknown }).Bun
	let exitSpy: MockInstance<(code?: number) => never> | undefined

	afterEach(() => {
		if (hadBun) (globalThis as unknown as { Bun?: unknown }).Bun = originalBun
		else (globalThis as unknown as { Bun?: unknown }).Bun = undefined
		exitSpy?.mockRestore()
		exitSpy = undefined
	})

	function removeExecve(): void {
		// Simulate the Bun-compiled runtime where process.execve is absent.
		// Restore the beforeEach spy first (it installs a configurable stub via
		// vi.spyOn, which can leave a non-writable property), then forcibly
		// redefine the slot as undefined so performReExec's `typeof === "function"`
		// guard is false.
		execveSpy?.mockRestore()
		execveSpy = undefined
		Object.defineProperty(process, "execve", { value: undefined, writable: true, configurable: true })
	}

	it("prefers process.execve, passing [execPath, ...userArgs]", () => {
		// execveSpy (from beforeEach) is a no-op returning undefined, so the
		// call falls through to the post-execve throw — that's expected.
		expect(() => performReExec(["--foo", "bar"], process.env)).toThrow(/execve returned unexpectedly/)
		expect(execveSpy).toHaveBeenCalledTimes(1)
		const [file, args] = execveSpy?.mock.calls[0] as [string, string[], NodeJS.ProcessEnv]
		expect(file).toBe(process.execPath)
		expect(args).toEqual([process.execPath, "--foo", "bar"])
	})

	it("falls back to Bun.spawnSync when execve is absent, and exits with the child code", () => {
		removeExecve()
		const spawnSync = vi.fn((_cmd: readonly string[], _opts: { stdio: string[]; env: unknown }) => ({ exitCode: 0 }))
		;(globalThis as unknown as { Bun?: unknown }).Bun = { spawnSync }
		// process.exit really terminates in production (performReExec is typed
		// `never`); the test mock must also halt control flow, otherwise
		// execution falls through to the ReExecUnavailableError throw. We make
		// the mock throw a sentinel to model the non-return.
		const exitSentinel = new Error("__exit__")
		exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw exitSentinel
		}) as never)

		expect(() => performReExec(["--foo"], process.env)).toThrow(exitSentinel)

		expect(spawnSync).toHaveBeenCalledTimes(1)
		const [cmd, opts] = spawnSync.mock.calls[0] as [string[], { stdio: string[]; env: unknown }]
		expect(cmd).toEqual([process.execPath, "--foo"])
		expect(opts.stdio).toEqual(["inherit", "inherit", "inherit"])
		expect(exitSpy).toHaveBeenCalledWith(0)
	})

	it("propagates the child's non-zero exit code", () => {
		removeExecve()
		;(globalThis as unknown as { Bun?: unknown }).Bun = { spawnSync: vi.fn(() => ({ exitCode: 42 })) }
		const exitSentinel = new Error("__exit__")
		exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw exitSentinel
		}) as never)

		expect(() => performReExec([], process.env)).toThrow(exitSentinel)
		expect(exitSpy).toHaveBeenCalledWith(42)
	})

	it("uses 128+signal when child is killed by signal (exitCode null)", () => {
		removeExecve()
		;(globalThis as unknown as { Bun?: unknown }).Bun = {
			spawnSync: vi.fn(() => ({ exitCode: null, signalCode: "SIGTERM" })),
		}
		const exitSentinel = new Error("__exit__")
		exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw exitSentinel
		}) as never)

		expect(() => performReExec([], process.env)).toThrow(exitSentinel)
		expect(exitSpy).toHaveBeenCalledWith(128 + 15) // SIGTERM = 15 → exit 143
	})

	it("exits with code 1 when signalCode is null and exitCode is null", () => {
		removeExecve()
		;(globalThis as unknown as { Bun?: unknown }).Bun = {
			spawnSync: vi.fn(() => ({ exitCode: null, signalCode: null })),
		}
		const exitSentinel = new Error("__exit__")
		exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			throw exitSentinel
		}) as never)

		expect(() => performReExec([], process.env)).toThrow(exitSentinel)
		expect(exitSpy).toHaveBeenCalledWith(1)
	})

	it("throws ReExecUnavailableError when neither execve nor Bun.spawnSync exists", () => {
		removeExecve()
		;(globalThis as unknown as { Bun?: unknown }).Bun = undefined
		expect(() => performReExec([], process.env)).toThrow(ReExecUnavailableError)
	})
})

describe("maybeAutoUpdateOnLaunch — re-exec unavailable fallback", () => {
	// When performReExec can't hand off (no execve, no Bun), the binary is
	// still swapped on disk; maybeAutoUpdateOnLaunch must swallow the
	// ReExecUnavailableError, log a restart hint, and NOT surface it as an
	// "unexpected" error.
	const hadBun = Object.hasOwn(globalThis, "Bun")
	const originalBun = (globalThis as unknown as { Bun?: unknown }).Bun

	afterEach(() => {
		if (hadBun) (globalThis as unknown as { Bun?: unknown }).Bun = originalBun
		else (globalThis as unknown as { Bun?: unknown }).Bun = undefined
	})

	it("logs a restart hint (not 'unexpected') and resolves when no re-exec primitive exists", async () => {
		const originalWrite = process.stderr.write.bind(process.stderr)
		const writeSpy = vi.fn((_chunk: string | Uint8Array, _enc?: unknown, _cb?: unknown) => true)
		;(process.stderr.write as unknown) = writeSpy
		try {
			// Drop execve robustly: the beforeEach spy may leave a non-writable
			// slot, so redefine rather than assign.
			Object.defineProperty(process, "execve", { value: undefined, writable: true, configurable: true })
			;(globalThis as unknown as { Bun?: unknown }).Bun = undefined
			mockCheckForUpdate.mockResolvedValue({
				currentVersion: "1.0.0",
				latestVersion: "1.1.0",
				tag: "v1.1.0",
				releaseUrl: "https://example/v1.1.0",
				hasUpdate: true,
				cached: false,
			})
			mockApplyUpdate.mockResolvedValue({ from: "v1.1.0", to: "v1.1.0" })

			await expect(maybeAutoUpdateOnLaunch()).resolves.toBeUndefined()

			const lines = writeSpy.mock.calls.map((c) => String(c[0])).join("")
			// Message uses check.latestVersion ("1.1.0"), mirroring the win32 branch.
			expect(lines).toContain("restart your terminal to use 1.1.0")
			expect(lines).not.toContain("unexpected")
		} finally {
			;(process.stderr.write as unknown) = originalWrite
		}
	})
})
