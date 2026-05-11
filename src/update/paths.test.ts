import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { isHomebrewInstall } from "./paths.js"

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

	it("returns false when execPath is outside any Homebrew prefix", () => {
		// No Cellar in tmp → prefix is not a real Homebrew installation.
		process.env.HOMEBREW_PREFIX = undefined
		setExecPath(join(tmp, "bin", "kimchi"))
		expect(isHomebrewInstall()).toBe(false)
	})

	it("returns true when real path is inside <prefix>/Cellar/", () => {
		// Build a fake Cellar layout:
		//   <tmp>/Cellar/kimchi/1.2.3/bin/kimchi   ← the real binary
		const cellarBin = join(tmp, "Cellar", "kimchi", "1.2.3", "bin")
		const realBinary = join(cellarBin, "kimchi")
		touch(realBinary)

		// Point HOMEBREW_PREFIX at our fake prefix so the well-known defaults
		// (/opt/homebrew, /usr/local) don't interfere.
		process.env.HOMEBREW_PREFIX = tmp

		// execPath = realBinary (no symlink needed for check 1).
		setExecPath(realBinary)
		expect(isHomebrewInstall()).toBe(true)
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

	it("returns false when Cellar directory does not exist under prefix", () => {
		// prefix exists but has no Cellar/ → not treated as a Homebrew install.
		const fakePrefix = join(tmp, "fake-prefix")
		mkdirSync(fakePrefix, { recursive: true })
		process.env.HOMEBREW_PREFIX = fakePrefix
		setExecPath(join(fakePrefix, "bin", "kimchi"))
		expect(isHomebrewInstall()).toBe(false)
	})
})
