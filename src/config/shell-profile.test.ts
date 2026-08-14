import {
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { exportEnvToShellProfile } from "./shell-profile.js"

describe("exportEnvToShellProfile", () => {
	let tmp: string
	let prevHome: string | undefined
	let prevShell: string | undefined

	beforeEach(() => {
		// macOS's per-process tmpdir resolves through /private — realpath now so
		// the assertions about returned paths line up with what the writer sees
		// after its own symlink resolution.
		tmp = realpathSync(mkdtempSync(join(tmpdir(), "kimchi-shell-test-")))
		prevHome = process.env.HOME
		prevShell = process.env.SHELL
		process.env.HOME = tmp
	})

	afterEach(() => {
		if (prevHome === undefined) delete process.env.HOME
		else process.env.HOME = prevHome
		if (prevShell === undefined) delete process.env.SHELL
		else process.env.SHELL = prevShell
		rmSync(tmp, { recursive: true, force: true })
	})

	it("appends export to .zshrc, preserving existing lines", () => {
		process.env.SHELL = "/bin/zsh"
		writeFileSync(join(tmp, ".zshrc"), "# existing config\nalias ll='ls -la'\n", "utf-8")

		const path = exportEnvToShellProfile("KIMCHI_API_KEY", "test-key-123")
		expect(path).toBe(join(tmp, ".zshrc"))

		const content = readFileSync(path as string, "utf-8")
		expect(content).toContain("export KIMCHI_API_KEY=test-key-123")
		expect(content).toContain("alias ll='ls -la'")
	})

	it("updates an existing export line in place", () => {
		process.env.SHELL = "/bin/zsh"
		writeFileSync(join(tmp, ".zshrc"), "# config\nexport KIMCHI_API_KEY=old-key\nalias ll='ls -la'\n", "utf-8")

		exportEnvToShellProfile("KIMCHI_API_KEY", "new-key-456")
		const content = readFileSync(join(tmp, ".zshrc"), "utf-8")
		expect(content).toContain("export KIMCHI_API_KEY=new-key-456")
		expect(content).not.toContain("old-key")
		expect(content).toContain("alias ll='ls -la'")
	})

	it("does not duplicate the export line on repeated calls", () => {
		process.env.SHELL = "/bin/zsh"
		writeFileSync(join(tmp, ".zshrc"), "", "utf-8")

		exportEnvToShellProfile("KIMCHI_API_KEY", "key1")
		exportEnvToShellProfile("KIMCHI_API_KEY", "key1")

		const content = readFileSync(join(tmp, ".zshrc"), "utf-8")
		const matches = content.split("\n").filter((l) => l === "export KIMCHI_API_KEY=key1").length
		expect(matches).toBe(1)
	})

	it("uses fish's set -gx syntax for fish shells", () => {
		process.env.SHELL = "/usr/bin/fish"
		const fishDir = join(tmp, ".config", "fish")
		mkdirSync(fishDir, { recursive: true })
		writeFileSync(join(fishDir, "config.fish"), "# fish config\n", "utf-8")

		const path = exportEnvToShellProfile("KIMCHI_API_KEY", "fish-key")
		expect(path).toBe(join(fishDir, "config.fish"))

		const content = readFileSync(path as string, "utf-8")
		expect(content).toContain("set -gx KIMCHI_API_KEY fish-key")
	})

	it("creates the profile when it does not yet exist", () => {
		process.env.SHELL = "/bin/zsh"
		const path = exportEnvToShellProfile("KIMCHI_API_KEY", "new-key")
		expect(path).toBe(join(tmp, ".zshrc"))

		const content = readFileSync(path as string, "utf-8")
		expect(content).toContain("export KIMCHI_API_KEY=new-key")
	})

	it("returns null when no shell can be detected and no profile exists", () => {
		process.env.SHELL = ""
		const path = exportEnvToShellProfile("KIMCHI_API_KEY", "key")
		expect(path).toBeNull()
	})

	it("follows symlinks to write the underlying file, leaving the link intact", () => {
		process.env.SHELL = "/bin/zsh"

		// Simulate a dotfiles repo: ~/.zshrc → ~/dotfiles/zshrc.
		const realDir = join(tmp, "dotfiles")
		mkdirSync(realDir, { recursive: true })
		const realFile = join(realDir, "zshrc")
		writeFileSync(realFile, "# real config\n", "utf-8")
		symlinkSync(realFile, join(tmp, ".zshrc"))

		const path = exportEnvToShellProfile("KIMCHI_API_KEY", "sym-key")
		expect(path).toBe(realFile)

		expect(readFileSync(realFile, "utf-8")).toContain("export KIMCHI_API_KEY=sym-key")

		// Symlink at ~/.zshrc must still be a symlink (we wrote the resolved
		// target, not the link itself).
		expect(lstatSync(join(tmp, ".zshrc")).isSymbolicLink()).toBe(true)
	})

	it("rejects non-UTF-8 content rather than corrupting the file", () => {
		process.env.SHELL = "/bin/zsh"
		writeFileSync(join(tmp, ".zshrc"), Buffer.from([0xff, 0xfe, 0x80, 0x81]))

		expect(() => exportEnvToShellProfile("KIMCHI_API_KEY", "key")).toThrow(/non-UTF-8/)
	})
})
