import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { isHomebrewInstall, resetHomebrewKegCacheForTests, stableExecutablePath } from "./paths.js"

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>()
	return {
		...actual,
		existsSync: vi.fn(actual.existsSync),
		realpathSync: Object.assign(vi.fn(actual.realpathSync), { native: actual.realpathSync.native }),
	}
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Write an empty file, creating parent dirs as needed. */
function touch(p: string): void {
	mkdirSync(join(p, ".."), { recursive: true })
	writeFileSync(p, "")
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("isHomebrewInstall", () => {
	let tmp: string
	let origExecPath: PropertyDescriptor | undefined
	let origPlatform: PropertyDescriptor | undefined
	let origEnv: string | undefined

	beforeEach(() => {
		resetHomebrewKegCacheForTests()
		vi.mocked(realpathSync).mockClear()
		tmp = mkdtempSync(join(tmpdir(), "kimchi-paths-test-"))
		origExecPath = Object.getOwnPropertyDescriptor(process, "execPath")
		origPlatform = Object.getOwnPropertyDescriptor(process, "platform")
		origEnv = process.env.HOMEBREW_PREFIX
	})

	afterEach(() => {
		if (origExecPath) Object.defineProperty(process, "execPath", origExecPath)
		if (origPlatform) Object.defineProperty(process, "platform", origPlatform)
		if (origEnv === undefined) process.env.HOMEBREW_PREFIX = undefined
		else process.env.HOMEBREW_PREFIX = origEnv
		rmSync(tmp, { recursive: true, force: true })
		resetHomebrewKegCacheForTests()
	})

	function setExecPath(p: string) {
		Object.defineProperty(process, "execPath", { value: p, writable: true, configurable: true })
	}

	function setPlatform(p: string) {
		Object.defineProperty(process, "platform", { value: p, writable: true, configurable: true })
	}

	it("returns false on win32 regardless of path", () => {
		setPlatform("win32")
		setExecPath("C:\\Program Files\\kimchi\\kimchi.exe")
		expect(isHomebrewInstall()).toBe(false)
	})

	it("returns true via symlink detection (bin → Cellar)", () => {
		// Fake layout:
		//   <tmp>/Cellar/kimchi/1.2.3/bin/kimchi   ← real binary
		//   <tmp>/bin/kimchi                        ← symlink → Cellar path
		const cellarBin = join(tmp, "Cellar", "kimchi", "1.2.3", "bin")
		const realBinary = join(cellarBin, "kimchi")
		touch(realBinary)

		const prefixBin = join(tmp, "bin")
		mkdirSync(prefixBin, { recursive: true })
		const symlink = join(prefixBin, "kimchi")
		symlinkSync(realBinary, symlink)

		process.env.HOMEBREW_PREFIX = tmp
		setExecPath(symlink)
		expect(isHomebrewInstall()).toBe(true)
	})

	it("returns false when a real (non-symlink) binary sits in <prefix>/bin/", () => {
		// Reproduces the install.sh layout on a host that also has Homebrew:
		//   <tmp>/Cellar/…           ← exists (some other brew package)
		//   <tmp>/bin/kimchi         ← real file dropped by install.sh, NOT a symlink
		// The binary's resolved path is not under Cellar, so detection must
		// return false even though a Cellar dir exists under the same prefix.
		mkdirSync(join(tmp, "Cellar"), { recursive: true })
		const binPath = join(tmp, "bin", "kimchi")
		touch(binPath)

		process.env.HOMEBREW_PREFIX = tmp
		setExecPath(binPath)
		expect(isHomebrewInstall()).toBe(false)
	})

	it("names Homebrew's opt link for the binary, which an upgrade keeps", () => {
		const keg = join(tmp, "Cellar", "kimchi", "1.2.3")
		touch(join(keg, "bin", "kimchi"))
		mkdirSync(join(tmp, "opt"), { recursive: true })
		symlinkSync(keg, join(tmp, "opt", "kimchi"))
		process.env.HOMEBREW_PREFIX = tmp
		setExecPath(join(keg, "bin", "kimchi"))
		expect(stableExecutablePath()).toBe(join(tmp, "opt", "kimchi", "bin", "kimchi"))
	})

	it("keeps the executable path outside Homebrew", () => {
		mkdirSync(join(tmp, "Cellar"), { recursive: true })
		const binPath = join(tmp, "bin", "kimchi")
		touch(binPath)
		process.env.HOMEBREW_PREFIX = tmp
		setExecPath(binPath)
		expect(stableExecutablePath()).toBe(binPath)
	})

	it("reuses the first realpath result across install and stable-path queries", () => {
		const keg = join(tmp, "Cellar", "kimchi", "1.2.3")
		const binary = join(keg, "bin", "kimchi")
		touch(binary)
		mkdirSync(join(tmp, "opt"), { recursive: true })
		symlinkSync(keg, join(tmp, "opt", "kimchi"))
		process.env.HOMEBREW_PREFIX = tmp
		setExecPath(binary)

		expect(isHomebrewInstall()).toBe(true)
		expect(realpathSync).toHaveBeenCalledTimes(2)

		expect(isHomebrewInstall()).toBe(true)
		expect(stableExecutablePath()).toBe(join(tmp, "opt", "kimchi", "bin", "kimchi"))
		expect(realpathSync).toHaveBeenCalledTimes(2)
	})

	it("caches a failed realpath probe as a non-Homebrew install", () => {
		process.env.HOMEBREW_PREFIX = tmp
		setExecPath(join(tmp, "missing", "kimchi"))

		expect(isHomebrewInstall()).toBe(false)
		expect(realpathSync).toHaveBeenCalledOnce()
		expect(isHomebrewInstall()).toBe(false)
		expect(stableExecutablePath()).toBe(process.execPath)
		expect(realpathSync).toHaveBeenCalledOnce()
	})

	it("retries after an unexpected probe error leaves the cache cold", () => {
		const keg = join(tmp, "Cellar", "kimchi", "1.2.3")
		const binPath = join(keg, "bin", "kimchi")
		touch(binPath)
		setExecPath(binPath)
		process.env.HOMEBREW_PREFIX = tmp
		vi.mocked(existsSync).mockImplementationOnce(() => {
			throw new Error("unexpected probe failure")
		})
		expect(isHomebrewInstall).toThrow("unexpected probe failure")

		mkdirSync(join(tmp, "opt"), { recursive: true })
		const optKeg = join(tmp, "opt", "kimchi")
		symlinkSync(keg, optKeg)
		expect(isHomebrewInstall()).toBe(true)
		expect(stableExecutablePath()).toBe(join(optKeg, "bin", "kimchi"))
	})

	it("returns false when Cellar directory does not exist under prefix", () => {
		// prefix exists but has no Cellar/ → not treated as a Homebrew install.
		const fakePrefix = join(tmp, "fake-prefix")
		mkdirSync(fakePrefix, { recursive: true })
		process.env.HOMEBREW_PREFIX = fakePrefix
		setExecPath(join(fakePrefix, "bin", "kimchi"))
		expect(isHomebrewInstall()).toBe(false)
	})
})
