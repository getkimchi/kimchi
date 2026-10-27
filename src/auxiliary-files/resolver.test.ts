import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { pickPackageDirForBinary, resolveAuxiliaryFilesDir, resolveValidatedAuxiliaryFilesDir } from "./resolver.js"

describe("resolveAuxiliaryFilesDir", () => {
	// Whitespace in the home path is intentional: it would break if the resolver used string concatenation instead of path.join.
	const home = "/home alice"

	it("returns PI_PACKAGE_DIR when it is set", () => {
		const env = { PI_PACKAGE_DIR: "/custom/path" }
		expect(resolveAuxiliaryFilesDir(env, home)).toBe("/custom/path")
	})

	it("returns PI_PACKAGE_DIR even when XDG_DATA_HOME is also set", () => {
		const env = {
			PI_PACKAGE_DIR: "/custom/path",
			XDG_DATA_HOME: "/xdg/data",
		}
		expect(resolveAuxiliaryFilesDir(env, home)).toBe("/custom/path")
	})

	it("returns $XDG_DATA_HOME/kimchi/ when XDG_DATA_HOME is set and PI_PACKAGE_DIR is not", () => {
		const env = { XDG_DATA_HOME: "/xdg/data" }
		expect(resolveAuxiliaryFilesDir(env, home)).toBe("/xdg/data/kimchi")
	})

	it("returns ~/.local/share/kimchi/ when neither PI_PACKAGE_DIR nor XDG_DATA_HOME is set", () => {
		const env: Record<string, string | undefined> = {}
		expect(resolveAuxiliaryFilesDir(env, home)).toBe("/home alice/.local/share/kimchi")
	})

	it("treats an empty-string PI_PACKAGE_DIR as unset and falls through", () => {
		// Matches the XDG spec's treatment of empty env vars: empty is equivalent to unset.
		// Prevents silently returning "" (or a relative path via path.join) as an auxiliary files dir.
		const env = { PI_PACKAGE_DIR: "" }
		expect(resolveAuxiliaryFilesDir(env, home)).toBe("/home alice/.local/share/kimchi")
	})

	it("treats an empty-string XDG_DATA_HOME as unset and falls through", () => {
		const env = { XDG_DATA_HOME: "" }
		expect(resolveAuxiliaryFilesDir(env, home)).toBe("/home alice/.local/share/kimchi")
	})

	it("handles XDG_DATA_HOME with a trailing slash", () => {
		const env = { XDG_DATA_HOME: "/xdg/data/" }
		expect(resolveAuxiliaryFilesDir(env, home)).toBe("/xdg/data/kimchi")
	})

	describe("binary-sibling share directory", () => {
		let tmpBase: string

		beforeEach(() => {
			tmpBase = join(tmpdir(), `kimchi-resolver-test-${process.pid}`)
			// Simulate dist/bin/kimchi + dist/share/kimchi/package.json
			mkdirSync(join(tmpBase, "bin"), { recursive: true })
			mkdirSync(join(tmpBase, "share", "kimchi"), { recursive: true })
			writeFileSync(join(tmpBase, "share", "kimchi", "package.json"), "{}")
		})

		afterEach(() => {
			rmSync(tmpBase, { recursive: true, force: true })
		})

		it("returns sibling share dir when package.json exists next to the binary", () => {
			const execPath = join(tmpBase, "bin", "kimchi")
			const env: Record<string, string | undefined> = {}
			expect(resolveAuxiliaryFilesDir(env, home, execPath)).toBe(join(tmpBase, "share", "kimchi"))
		})

		it("PI_PACKAGE_DIR takes precedence over sibling share dir", () => {
			const execPath = join(tmpBase, "bin", "kimchi")
			const env = { PI_PACKAGE_DIR: "/custom/path" }
			expect(resolveAuxiliaryFilesDir(env, home, execPath)).toBe("/custom/path")
		})

		it("falls through to XDG when sibling share dir has no package.json", () => {
			rmSync(join(tmpBase, "share", "kimchi", "package.json"))
			const execPath = join(tmpBase, "bin", "kimchi")
			const env = { XDG_DATA_HOME: "/xdg/data" }
			expect(resolveAuxiliaryFilesDir(env, home, execPath)).toBe("/xdg/data/kimchi")
		})
	})

	describe("resolveValidatedAuxiliaryFilesDir", () => {
		let tmpBase: string

		// Valid aux layout: package.json + theme/dark.json + theme/light.json
		const makeValidAuxDir = (dir: string) => {
			mkdirSync(join(dir, "theme"), { recursive: true })
			writeFileSync(join(dir, "package.json"), "{}")
			writeFileSync(join(dir, "theme", "dark.json"), "{}")
			writeFileSync(join(dir, "theme", "light.json"), "{}")
		}

		beforeEach(() => {
			tmpBase = join(tmpdir(), `kimchi-resolver-validated-test-${process.pid}`)
		})

		afterEach(() => {
			rmSync(tmpBase, { recursive: true, force: true })
		})

		it("returns the validated sibling share dir when PI_PACKAGE_DIR is unset", () => {
			const shareDir = join(tmpBase, "share", "kimchi")
			makeValidAuxDir(shareDir)
			mkdirSync(join(tmpBase, "bin"), { recursive: true })
			const execPath = join(tmpBase, "bin", "kimchi")
			expect(resolveValidatedAuxiliaryFilesDir({}, home, execPath)).toBe(shareDir)
		})

		it("throws the validation error when PI_PACKAGE_DIR is unset and nothing valid resolves", () => {
			mkdirSync(join(tmpBase, "bin"), { recursive: true })
			const execPath = join(tmpBase, "bin", "kimchi")
			expect(() => resolveValidatedAuxiliaryFilesDir({}, home, execPath)).toThrow(/Auxiliary files directory not found/)
		})

		it("recovers to a valid binary-adjacent share dir when PI_PACKAGE_DIR was inherited from a source checkout", () => {
			// Simulates launching dist/bin/kimchi from inside another kimchi/pi
			// session: the parent exports its own package dir (a source checkout
			// with themes/ instead of theme/), which fails validation.
			const shareDir = join(tmpBase, "share", "kimchi")
			makeValidAuxDir(shareDir)
			const sourceCheckout = join(tmpBase, "source-checkout")
			mkdirSync(join(sourceCheckout, "themes"), { recursive: true })
			writeFileSync(join(sourceCheckout, "package.json"), "{}")
			mkdirSync(join(tmpBase, "bin"), { recursive: true })
			const execPath = join(tmpBase, "bin", "kimchi")
			const env = { PI_PACKAGE_DIR: sourceCheckout }
			expect(resolveValidatedAuxiliaryFilesDir(env, home, execPath)).toBe(shareDir)
		})

		it("keeps an explicit-but-invalid PI_PACKAGE_DIR when no valid sibling exists", () => {
			mkdirSync(join(tmpBase, "bin"), { recursive: true })
			const execPath = join(tmpBase, "bin", "kimchi")
			const env = { PI_PACKAGE_DIR: "/user/chosen/dir" }
			expect(resolveValidatedAuxiliaryFilesDir(env, home, execPath)).toBe("/user/chosen/dir")
		})

		it("recovers to a valid installed data dir when the sibling share dir is stale", () => {
			// Upgrade/nested-launch case: the binary-adjacent share dir exists but
			// lacks theme/ (stale 0.85.1-era layout), while the installed data dir
			// has the full layout. The recovery must not stop at the first bad
			// candidate.
			const shareDir = join(tmpBase, "share", "kimchi")
			mkdirSync(shareDir, { recursive: true })
			writeFileSync(join(shareDir, "package.json"), "{}")
			const tmpHome = join(tmpBase, "home")
			makeValidAuxDir(join(tmpHome, ".local", "share", "kimchi"))
			mkdirSync(join(tmpBase, "bin"), { recursive: true })
			const execPath = join(tmpBase, "bin", "kimchi")
			const sourceCheckout = join(tmpBase, "source-checkout")
			mkdirSync(sourceCheckout, { recursive: true })
			writeFileSync(join(sourceCheckout, "package.json"), "{}")
			const env = { PI_PACKAGE_DIR: sourceCheckout }
			expect(resolveValidatedAuxiliaryFilesDir(env, tmpHome, execPath)).toBe(join(tmpHome, ".local", "share", "kimchi"))
		})

		it("keeps the env var when both it and the sibling are valid", () => {
			const shareDir = join(tmpBase, "share", "kimchi")
			makeValidAuxDir(shareDir)
			const customDir = join(tmpBase, "custom")
			makeValidAuxDir(customDir)
			mkdirSync(join(tmpBase, "bin"), { recursive: true })
			const execPath = join(tmpBase, "bin", "kimchi")
			const env = { PI_PACKAGE_DIR: customDir }
			expect(resolveValidatedAuxiliaryFilesDir(env, home, execPath)).toBe(customDir)
		})
	})

	describe("pickPackageDirForBinary", () => {
		let tmpBase: string
		beforeEach(() => {
			tmpBase = join(tmpdir(), `resolver-pick-${Date.now()}-${Math.random().toString(36).slice(2)}`)
			mkdirSync(tmpBase, { recursive: true })
		})
		afterEach(() => {
			rmSync(tmpBase, { recursive: true, force: true })
		})

		const writePkg = (dir: string, version?: string) => {
			mkdirSync(dir, { recursive: true })
			writeFileSync(join(dir, "package.json"), JSON.stringify({ version }))
		}

		it("returns primary when versions match", () => {
			const primary = join(tmpBase, "inherited")
			const sibling = join(tmpBase, "sibling")
			writePkg(primary, "1.3.0")
			writePkg(sibling, "1.3.0")
			expect(pickPackageDirForBinary(primary, sibling)).toBe(primary)
		})

		it("returns the binary-adjacent share when versions differ (stale inherited dir)", () => {
			const primary = join(tmpBase, "inherited")
			const sibling = join(tmpBase, "sibling")
			writePkg(primary, "0.85.1")
			writePkg(sibling, "1.3.0")
			expect(pickPackageDirForBinary(primary, sibling)).toBe(sibling)
		})

		it("keeps primary when a version cannot be read", () => {
			const primary = join(tmpBase, "inherited")
			const sibling = join(tmpBase, "sibling")
			writePkg(primary, "0.85.1")
			writePkg(sibling) // unreadable version
			expect(pickPackageDirForBinary(primary, sibling)).toBe(primary)
		})

		it("keeps primary when it already equals the sibling", () => {
			const sibling = join(tmpBase, "sibling")
			writePkg(sibling, "1.3.0")
			expect(pickPackageDirForBinary(sibling, sibling)).toBe(sibling)
		})
	})
})
