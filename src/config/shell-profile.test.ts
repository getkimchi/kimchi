import { execFileSync, spawnSync } from "node:child_process"
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { platform, tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { findShellProfileApiKey, removeShellProfileApiKey } from "./shell-profile.js"

const bashProfile = platform() === "darwin" ? ".bash_profile" : ".bashrc"

it.skipIf(spawnSync("fish", ["--version"]).status !== 0)("removes a Fish export after a completed function", () => {
	const home = mkdtempSync(join(tmpdir(), "kimchi-shell-profile-fish-"))
	try {
		vi.stubEnv("HOME", home)
		vi.stubEnv("SHELL", "fish")
		const path = join(home, ".config", "fish", "config.fish")
		mkdirSync(dirname(path), { recursive: true })
		const content = "function greeting\n  echo hello\nend\n"
		writeFileSync(path, `${content}set -gx KIMCHI_API_KEY old-key\n`)
		const profile = findShellProfileApiKey()
		expect(profile).toEqual({ path, shell: "fish", canRemove: true })
		if (!profile) throw new Error("Expected shell profile")
		removeShellProfileApiKey(profile)
		expect(readFileSync(path, "utf-8")).toBe(content)
	} finally {
		vi.unstubAllEnvs()
		rmSync(home, { recursive: true, force: true })
	}
})

for (const shell of ["/bin/bash", "/bin/zsh"]) {
	const profileName = shell.endsWith("zsh") ? ".zshrc" : bashProfile
	describe.skipIf(spawnSync(shell, ["--version"]).status !== 0)(`shell profile API key migration (${shell})`, () => {
		let home: string
		beforeEach(() => {
			home = mkdtempSync(join(tmpdir(), "kimchi-shell-profile-"))
			vi.stubEnv("HOME", home)
			vi.stubEnv("SHELL", shell)
		})
		afterEach(() => {
			vi.unstubAllEnvs()
			rmSync(home, { recursive: true, force: true })
		})

		function seed(relativePath: string, content: string | Buffer): string {
			const path = join(home, relativePath)
			mkdirSync(dirname(path), { recursive: true })
			writeFileSync(path, content, { mode: 0o640 })
			return path
		}

		it("detects and removes the legacy export", () => {
			const path = seed(profileName, "# keep\nexport KIMCHI_API_KEY=old-key\nalias ll='ls -la'\n")
			const profile = findShellProfileApiKey()
			expect(profile).toEqual({ path, shell: basename(shell), canRemove: true })
			if (!profile) throw new Error("Expected shell profile")
			removeShellProfileApiKey(profile)
			expect(readFileSync(path, "utf-8")).toBe("# keep\nalias ll='ls -la'\n")
			expect(statSync(path).mode & 0o777).toBe(0o640)
			expect(findShellProfileApiKey()).toBeUndefined()
		})

		it("falls back to an existing profile when SHELL is unknown", () => {
			vi.stubEnv("SHELL", "/bin/sh")
			const path = seed(".bashrc", "export KIMCHI_API_KEY=old-key\n")
			expect(findShellProfileApiKey()?.path).toBe(path)
		})

		it("ignores missing profiles, comments, references, and similarly named variables", () => {
			expect(findShellProfileApiKey()).toBeUndefined()
			seed(profileName, '# export KIMCHI_API_KEY=old-key\necho "$KIMCHI_API_KEY"\nexport KIMCHI_API_KEY_BACKUP=old\n')
			expect(findShellProfileApiKey()).toBeUndefined()
		})

		it("ignores bare assignments while removing a legacy export", () => {
			const content = "KIMCHI_API_KEY=unexported\n"
			const path = seed(profileName, content)
			expect(findShellProfileApiKey()).toBeUndefined()

			writeFileSync(path, `${content}export KIMCHI_API_KEY=legacy-key\n`)
			const profile = findShellProfileApiKey()
			if (!profile) throw new Error("Expected shell profile")
			removeShellProfileApiKey(profile)
			expect(readFileSync(path, "utf-8")).toBe(content)
			expect(findShellProfileApiKey()).toBeUndefined()
		})

		it.each([
			"if true; then\n  export KIMCHI_API_KEY=legacy-key\nfi\n",
			"for item in one; do\n  export KIMCHI_API_KEY=legacy-key\ndone\n",
			"if false; then\n  :\nelse\n  export KIMCHI_API_KEY=legacy-key\nfi\n",
		])("leaves blocks unchanged and syntactically valid: %s", (content) => {
			const path = seed(profileName, "export KIMCHI_API_KEY=legacy-key\n")
			const profile = findShellProfileApiKey()
			if (!profile) throw new Error("Expected shell profile")
			writeFileSync(path, content)
			execFileSync(shell, ["-n", path])
			expect(findShellProfileApiKey()).toEqual({ ...profile, canRemove: false })
			expect(() => removeShellProfileApiKey(profile)).toThrow("please edit it manually")
			execFileSync(shell, ["-n", path])
			expect(readFileSync(path, "utf-8")).toBe(content)
		})

		it.each([
			["multiline string", 'echo "example:\nexport KIMCHI_API_KEY=example\n"\n'],
			["heredoc", "cat <<'EOF'\nexport KIMCHI_API_KEY=example\nEOF\n"],
			["tab-stripped heredoc", "cat <<-EOF\n\texport KIMCHI_API_KEY=example\n\tEOF\n"],
			["dotted heredoc delimiter", "cat <<EOF.txt\nEOF\nexport KIMCHI_API_KEY=example\nEOF.txt\n"],
			["continued command", "printf '%s' \\\nexport KIMCHI_API_KEY=example\n"],
			["array data", "examples=(\n  export KIMCHI_API_KEY=example\n)\n"],
			["arithmetic shift", "flags=$((1 << 2))\n"],
			["command substitution", "output=$(\nexport KIMCHI_API_KEY=example\n)\n"],
			["backticks", "output=`\nexport KIMCHI_API_KEY=example\n`\n"],
			["function definition", "configure() {\n  export KIMCHI_API_KEY=example\n}\n"],
			["unfinished condition", "true &&\nexport KIMCHI_API_KEY=example\n"],
			["short function", "function configure\nexport KIMCHI_API_KEY=example\n"],
			["short loop", "for item in one\nexport KIMCHI_API_KEY=example\n"],
		])("skips a whole profile containing %s, including after the prompt opens", (_name, example) => {
			const exportLine = "export KIMCHI_API_KEY=real-key\n"
			const path = seed(profileName, exportLine)
			const profile = findShellProfileApiKey()
			if (!profile) throw new Error("Expected shell profile")
			const content = `${exportLine}${example}${exportLine}`
			writeFileSync(path, content)
			expect(findShellProfileApiKey()).toEqual({ ...profile, canRemove: false })
			expect(() => removeShellProfileApiKey(profile)).toThrow("please edit it manually")
			expect(readFileSync(path, "utf-8")).toBe(content)
		})

		it("removes an export alongside ordinary conditionals, plugin lists, and tool initialization", () => {
			const content = [
				`if [ -r "\${XDG_CACHE_HOME:-$HOME/.cache}/prompt.sh" ]; then`,
				`  source "\${XDG_CACHE_HOME:-$HOME/.cache}/prompt.sh"`,
				"fi",
				"plugins=(",
				"  git",
				"  node",
				")",
				'eval "$(mise activate)"',
				'[[ ! -f "$HOME/.shell-extra" ]] || source "$HOME/.shell-extra"',
				'command -v direnv >/dev/null && eval "$(direnv hook bash)"',
				"export KEEP_ME=unchanged",
				"",
			].join("\n")
			const path = seed(profileName, `${content}export KIMCHI_API_KEY=real-key\n`)
			const profile = findShellProfileApiKey()
			expect(profile?.canRemove).toBe(true)
			if (!profile) throw new Error("Expected shell profile")
			removeShellProfileApiKey(profile)
			expect(readFileSync(path, "utf-8")).toBe(content)
		})

		it("never executes profile commands, substitutions, or user startup hooks", () => {
			const hook = seed("startup-hook", 'touch "$HOME/hook-ran"\n')
			seed(".zshenv", 'touch "$HOME/hook-ran"\n')
			vi.stubEnv("BASH_ENV", hook)
			vi.stubEnv("ENV", hook)
			vi.stubEnv("SHELLOPTS", "verbose:xtrace")
			const content = 'touch "$HOME/profile-ran"\nvalue="$(touch "$HOME/substitution-ran")"\n'
			const path = seed(profileName, `${content}export KIMCHI_API_KEY=real-key\n`)
			const profile = findShellProfileApiKey()
			expect(profile?.canRemove).toBe(true)
			if (!profile) throw new Error("Expected shell profile")
			removeShellProfileApiKey(profile)
			expect(readFileSync(path, "utf-8")).toBe(content)
			for (const marker of ["hook-ran", "profile-ran", "substitution-ran"]) {
				expect(existsSync(join(home, marker))).toBe(false)
			}
		})

		it("requires manual cleanup when the shell checker is unavailable", () => {
			const content = "export KIMCHI_API_KEY=real-key\n"
			const path = seed(profileName, content)
			vi.stubEnv("SHELL", `/nonexistent/${basename(shell)}`)
			const profile = findShellProfileApiKey()
			expect(profile?.canRemove).toBe(false)
			if (!profile) throw new Error("Expected shell profile")
			expect(() => removeShellProfileApiKey(profile)).toThrow("please edit it manually")
			expect(readFileSync(path, "utf-8")).toBe(content)
		})

		it("requires manual cleanup when the original profile has a syntax error", () => {
			const content = "export KIMCHI_API_KEY=real-key\nif true; then\n"
			const path = seed(profileName, content)
			const profile = findShellProfileApiKey()
			expect(profile?.canRemove).toBe(false)
			if (!profile) throw new Error("Expected shell profile")
			expect(() => removeShellProfileApiKey(profile)).toThrow("please edit it manually")
			expect(readFileSync(path, "utf-8")).toBe(content)
		})

		it("does not mistake Unicode whitespace for a shell token boundary", () => {
			const path = seed(profileName, "\ufeffexport KIMCHI_API_KEY=example\n")
			expect(findShellProfileApiKey()).toBeUndefined()
			writeFileSync(path, "export KIMCHI_API_KEY=example;\u00a0#tag; export KEEP_ME=unchanged\n")
			expect(findShellProfileApiKey()?.canRemove).toBe(false)
		})

		it("accepts simple quoted lines and ignores complex-looking text in full-line comments", () => {
			const content = [
				'# example <<EOF, \\, `, $(...), ${VAR}, (array), "',
				"alias ll='ls -la'",
				'export PATH="$HOME/bin:$PATH"',
				'source "$HOME/.shell-extra"',
				"EDITOR=vim",
				"",
			].join("\n")
			const path = seed(profileName, `${content}export KIMCHI_API_KEY=real-key\n`)
			const profile = findShellProfileApiKey()
			if (!profile) throw new Error("Expected shell profile")
			removeShellProfileApiKey(profile)
			expect(readFileSync(path, "utf-8")).toBe(content)
		})

		it("removes legacy exports while preserving CRLF and the final newline convention", () => {
			const path = seed(
				profileName,
				'# keep\r\n  export KIMCHI_API_KEY="old-key" # obsolete\r\nexport KIMCHI_API_KEY=other;\r\n# last',
			)
			const profile = findShellProfileApiKey()
			if (!profile) throw new Error("Expected shell profile")
			removeShellProfileApiKey(profile)
			expect(readFileSync(path, "utf-8")).toBe("# keep\r\n# last")
		})

		it("preserves a symlink and edits made while the prompt was open", () => {
			const target = seed("dotfiles/zshrc", "export KIMCHI_API_KEY=old-key\n")
			const link = join(home, profileName)
			symlinkSync(target, link)
			const profile = findShellProfileApiKey()
			if (!profile) throw new Error("Expected shell profile")
			writeFileSync(target, "# newly added\nexport KIMCHI_API_KEY=old-key\n")
			removeShellProfileApiKey(profile)
			expect(lstatSync(link).isSymbolicLink()).toBe(true)
			expect(readFileSync(target, "utf-8")).toBe("# newly added\n")
		})

		it.each([
			"export KIMCHI_API_KEY=old-key; export KEEP=value\n",
			"export KIMCHI_API_KEY=old-key OTHER=value\n",
			"export KIMCHI_API_KEY=old#tag; export KEEP_ME=unchanged\n",
			'export KIMCHI_API_KEY="old"#tag; export KEEP_ME=unchanged\n',
		])("leaves unsupported shell expressions untouched: %s", (content) => {
			const path = seed(profileName, "export KIMCHI_API_KEY=legacy-key\n")
			const profile = findShellProfileApiKey()
			if (!profile) throw new Error("Expected shell profile")
			writeFileSync(path, content)
			expect(findShellProfileApiKey()).toEqual({ ...profile, canRemove: false })
			expect(() => removeShellProfileApiKey(profile)).toThrow("please edit it manually")
			expect(readFileSync(path, "utf-8")).toBe(content)
		})

		it.each([
			"old # obsolete",
			"'old';# obsolete",
			'"old"; # obsolete',
		])("accepts a trailing comment at a token boundary: %s", (value) => {
			const path = seed(profileName, `export KIMCHI_API_KEY=${value}\n`)
			const profile = findShellProfileApiKey()
			if (!profile) throw new Error("Expected shell profile")
			removeShellProfileApiKey(profile)
			expect(readFileSync(path, "utf-8")).toBe("")
		})

		it("rejects invalid UTF-8 without rewriting the profile", () => {
			const content = Buffer.concat([Buffer.from("export KIMCHI_API_KEY=old-key\n"), Buffer.from([0xff])])
			const path = seed(profileName, content)
			expect(() => findShellProfileApiKey()).toThrow("non-UTF-8")
			expect(readFileSync(path)).toEqual(content)
		})
	})
}
