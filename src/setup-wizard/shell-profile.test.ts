import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { exportEnvToShellProfile } from "./shell-profile.js"

/**
 * Tests use a scratch HOME under tmpdir and reset $HOME / $SHELL between
 * cases so detection is deterministic.
 */
describe("exportEnvToShellProfile", () => {
	let tmpHome: string
	let prevHome: string | undefined
	let prevShell: string | undefined

	beforeEach(() => {
		// realpath because macOS tmpdirs have a /private prefix that the OS
		// resolves on access — the function-under-test resolves symlinks too,
		// so we compare against the resolved form.
		tmpHome = realpathSync(mkdtempSync(join(tmpdir(), "shellprofile-test-")))
		prevHome = process.env.HOME
		prevShell = process.env.SHELL
		process.env.HOME = tmpHome
	})

	afterEach(() => {
		// biome-ignore lint/performance/noDelete: env-var cleanup needs a real delete; assigning undefined would coerce to the literal string "undefined".
		if (prevHome === undefined) delete process.env.HOME
		else process.env.HOME = prevHome
		// biome-ignore lint/performance/noDelete: same reason as HOME above.
		if (prevShell === undefined) delete process.env.SHELL
		else process.env.SHELL = prevShell
		rmSync(tmpHome, { recursive: true, force: true })
	})

	it("appends export to zshrc", () => {
		process.env.SHELL = "/bin/zsh"
		writeFileSync(join(tmpHome, ".zshrc"), "# existing config\nalias ll='ls -la'\n")

		const result = exportEnvToShellProfile("KIMCHI_API_KEY", "test-key-123")
		expect(result.path).toBe(join(tmpHome, ".zshrc"))

		const content = readFileSync(result.path as string, "utf-8")
		expect(content).toContain("export KIMCHI_API_KEY=test-key-123")
		expect(content).toContain("alias ll='ls -la'")
	})

	it("updates existing export with new value", () => {
		process.env.SHELL = "/bin/zsh"
		writeFileSync(join(tmpHome, ".zshrc"), "# config\nexport KIMCHI_API_KEY=old-key\nalias ll='ls -la'\n")

		const result = exportEnvToShellProfile("KIMCHI_API_KEY", "new-key-456")
		const content = readFileSync(result.path as string, "utf-8")
		expect(content).toContain("export KIMCHI_API_KEY=new-key-456")
		expect(content).not.toContain("old-key")
		expect(content).toContain("alias ll='ls -la'")
	})

	it("does not duplicate on repeated calls", () => {
		process.env.SHELL = "/bin/zsh"
		writeFileSync(join(tmpHome, ".zshrc"), "")

		exportEnvToShellProfile("KIMCHI_API_KEY", "key1")
		exportEnvToShellProfile("KIMCHI_API_KEY", "key1")

		const content = readFileSync(join(tmpHome, ".zshrc"), "utf-8")
		const matches = content.split("\n").filter((line) => line === "export KIMCHI_API_KEY=key1")
		expect(matches.length).toBe(1)
	})

	it("fish shell uses set -gx syntax", () => {
		process.env.SHELL = "/usr/bin/fish"
		const fishDir = join(tmpHome, ".config", "fish")
		mkdirSync(fishDir, { recursive: true })
		writeFileSync(join(fishDir, "config.fish"), "# fish config\n")

		const result = exportEnvToShellProfile("KIMCHI_API_KEY", "fish-key")
		expect(result.path).toBe(join(fishDir, "config.fish"))

		const content = readFileSync(result.path as string, "utf-8")
		expect(content).toContain("set -gx KIMCHI_API_KEY fish-key")
	})

	it("creates profile if it does not exist", () => {
		process.env.SHELL = "/bin/zsh"

		const result = exportEnvToShellProfile("KIMCHI_API_KEY", "new-key")
		expect(result.path).toBe(join(tmpHome, ".zshrc"))

		const content = readFileSync(result.path as string, "utf-8")
		expect(content).toContain("export KIMCHI_API_KEY=new-key")
	})

	it("returns null path when shell is unknown and no profiles exist", () => {
		process.env.SHELL = ""

		const result = exportEnvToShellProfile("KIMCHI_API_KEY", "key")
		expect(result.path).toBeNull()
		expect(result.error).toBeUndefined()
	})

	it("follows symlinks", () => {
		process.env.SHELL = "/bin/zsh"

		const realDir = join(tmpHome, "dotfiles")
		mkdirSync(realDir, { recursive: true })
		const realFile = join(realDir, "zshrc")
		writeFileSync(realFile, "# real config\n")
		symlinkSync(realFile, join(tmpHome, ".zshrc"))

		const result = exportEnvToShellProfile("KIMCHI_API_KEY", "sym-key")
		expect(result.path).toBe(realFile)

		const content = readFileSync(realFile, "utf-8")
		expect(content).toContain("export KIMCHI_API_KEY=sym-key")

		// Symlink should still be a symlink — we wrote through it, not over it.
		const linkInfo = statSync(join(tmpHome, ".zshrc"))
		expect(linkInfo.isFile()).toBe(true)
	})

	it("rejects non-UTF-8 content", () => {
		process.env.SHELL = "/bin/zsh"
		// Lone continuation byte sequence — invalid UTF-8.
		writeFileSync(join(tmpHome, ".zshrc"), Buffer.from([0xff, 0xfe, 0x80, 0x81]))

		const result = exportEnvToShellProfile("KIMCHI_API_KEY", "key")
		expect(result.path).toBeNull()
		expect(result.error).toMatch(/non-UTF-8/)
	})

	it("surfaces permission error when parent directory is read-only", () => {
		process.env.SHELL = "/bin/zsh"
		const profile = join(tmpHome, ".zshrc")
		writeFileSync(profile, "# existing\n")
		chmodSync(tmpHome, 0o555)

		const result = exportEnvToShellProfile("KIMCHI_API_KEY", "key")
		expect(result.path).toBeNull()
		expect(result.error).toMatch(/read-only/)

		chmodSync(tmpHome, 0o755)
	})
})
