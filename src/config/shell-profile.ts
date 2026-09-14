import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { chmodSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir, platform } from "node:os"
import { basename, join } from "node:path"

interface ShellProfile {
	path: string
	shell: "zsh" | "bash" | "fish"
}

/** Match the profiles selected by Kimchi's former shell-profile exporter. */
function detectShellProfile(): ShellProfile | undefined {
	const home = homedir()
	switch (basename(process.env.SHELL ?? "")) {
		case "zsh":
			return { path: join(home, ".zshrc"), shell: "zsh" }
		case "bash":
			return { path: join(home, platform() === "darwin" ? ".bash_profile" : ".bashrc"), shell: "bash" }
		case "fish":
			return { path: join(home, ".config", "fish", "config.fish"), shell: "fish" }
	}
	const candidates: ShellProfile[] = [
		...(platform() === "darwin" ? [{ path: join(home, ".zshrc"), shell: "zsh" as const }] : []),
		{ path: join(home, ".bashrc"), shell: "bash" },
		{ path: join(home, ".bash_profile"), shell: "bash" },
	]
	return candidates.find(({ path }) => {
		try {
			return statSync(path).isFile()
		} catch {
			return false
		}
	})
}

function readProfile(path: string): string {
	const raw = readFileSync(path)
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw)
	} catch {
		throw new Error(`Shell profile ${path} contains non-UTF-8 content; please edit it manually.`)
	}
}

function assignmentPrefix(shell: ShellProfile["shell"]): RegExp {
	// Only migrate the export forms the old installer wrote. Bare assignments
	// can also be array data and are outside this migration's scope.
	return shell === "fish" ? /^[\t ]*set[\t ]+-gx[\t ]+KIMCHI_API_KEY[\t ]+/ : /^[\t ]*export[\t ]+KIMCHI_API_KEY=/
}

function isLiteralKey(value: string): boolean {
	// Optional matching quotes around a plain key, followed by a token boundary.
	const literal = /^(['"]?)[\w./+=:@-]*\1(?=$|[\t ;])/.exec(value)
	if (!literal) return false
	let suffix = value.slice(literal[0].length).replace(/^[\t ]+|[\t ]+$/g, "")
	if (suffix.startsWith(";")) suffix = suffix.slice(1).replace(/^[\t ]+/, "")
	return suffix === "" || suffix.startsWith("#")
}

/** Parse only: profile commands and substitutions must never run. */
function hasCompleteSyntax(content: string, shell: ShellProfile["shell"]): boolean {
	const configuredShell = process.env.SHELL ?? ""
	const executable = basename(configuredShell) === shell ? configuredShell : shell
	const args = {
		bash: ["--noprofile", "--norc", "-pn"],
		// Short forms can consume the following export despite accepting EOF.
		zsh: ["-d", "-f", "-n", "-o", "NO_SHORT_LOOPS", "-o", "NO_SHORT_REPEAT"],
		fish: ["--no-config", "--no-execute"],
	}[shell]
	const result = spawnSync(executable, args, {
		input: content,
		encoding: "utf-8",
		timeout: 1_000,
		// Exclude inherited startup hooks, shell options, and verbose key tracing.
		env: { PATH: process.env.PATH, HOME: homedir() },
	})
	// Some shells report incomplete syntax as a warning with a successful status.
	// Never forward diagnostics: they may contain a key from the input.
	return result.status === 0 && result.stdout === "" && result.stderr === ""
}

/** Build the complete edit first. Undefined means this profile needs manual cleanup. */
function migrateProfile(content: string, shell: ShellProfile["shell"]): string | undefined {
	// EOF can silently terminate heredocs or continued commands in syntax-only
	// mode (including trailing &&/|| in Zsh). Keep skipping these profiles.
	const code = content.replace(/^[\t ]*#.*$/gm, "")
	if (/<<|\\\r?\n|\0|[|&][\t ]*(?:#.*)?\r?$/m.test(code)) return undefined
	const prefix = assignmentPrefix(shell)
	const beforeExports: string[] = []
	let before = ""
	let updated = ""
	for (const text of content.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
		const line = text.replace(/\r?\n$/, "")
		if (prefix.test(line)) {
			if (!isLiteralKey(line.replace(prefix, ""))) return undefined
			beforeExports.push(before)
		} else {
			updated += text
		}
		before += text
	}
	if (updated === content) return updated
	// A complete prefix places each export outside blocks, arrays, strings, and
	// substitutions. Check the original and the entire proposed edit as well.
	return [content, ...beforeExports, updated].every((part) => hasCompleteSyntax(part, shell)) ? updated : undefined
}

/** Read files only: never source a profile or evaluate the key's value. */
export function findShellProfileApiKey(): (ShellProfile & { canRemove: boolean }) | undefined {
	const profile = detectShellProfile()
	if (!profile) return undefined
	let content: string
	try {
		content = readProfile(profile.path)
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
		throw error
	}
	const prefix = assignmentPrefix(profile.shell)
	if (!content.split("\n").some((line) => prefix.test(line))) return undefined
	return { ...profile, canRemove: migrateProfile(content, profile.shell) !== undefined }
}

/** Remove literal assignments without deleting commands sharing the same line. */
export function removeShellProfileApiKey(profile: ShellProfile): void {
	// Resolve again and reread after the prompt so edits made while it was open survive.
	const path = realpathSync(profile.path)
	const content = readProfile(path)
	const updated = migrateProfile(content, profile.shell)
	if (updated === undefined) {
		throw new Error(`Could not safely remove KIMCHI_API_KEY from ${profile.path}; please edit it manually.`)
	}
	if (updated === content) return
	const tmp = `${path}.${randomUUID()}.tmp`
	try {
		writeFileSync(tmp, updated, { flag: "wx", mode: 0o600 })
		chmodSync(tmp, statSync(path).mode & 0o777)
		renameSync(tmp, path)
	} finally {
		rmSync(tmp, { force: true })
	}
}
