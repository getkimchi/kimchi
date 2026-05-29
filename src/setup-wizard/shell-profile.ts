import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs"
import { homedir, platform } from "node:os"
import { basename, dirname, join } from "node:path"

export interface ExportResult {
	/** Absolute path of the profile we wrote to, or null when no shell profile was detected. */
	path: string | null
	/** Non-fatal warning (e.g. profile file contains non-UTF-8 bytes); the export was skipped. */
	error?: string
	/** The line the user should add manually when the automated write fails. */
	manualLine?: string
}

/**
 * Append (or update) an `export KEY=VALUE` line in the user's shell
 * profile so the key is available to future shells.
 *
 * Behavior:
 *   - Shell detected from `$SHELL` (zsh / bash / fish), with a fallback
 *     to the first profile file that exists on disk.
 *   - macOS bash → `~/.bash_profile`; Linux bash → `~/.bashrc`.
 *   - fish uses `set -gx KEY VALUE`; everything else uses `export KEY=VALUE`.
 *   - Symlinks are resolved before writing so we update the real file
 *     (e.g. a dotfiles repo target) instead of replacing the symlink.
 *   - Existing matching lines are replaced in-place; otherwise the
 *     export is appended. Repeated calls are idempotent.
 *   - Profiles containing invalid UTF-8 are left untouched and surface
 *     an `error` field; this is treated as non-fatal by callers.
 *   - Writes are atomic (tmp + rename) so a failed write can't half-clobber
 *     a user's `.zshrc`.
 *
 * Returns `{ path: null }` when no shell profile is detected — that's a
 * normal outcome on a barebones system, not an error.
 */
export function exportEnvToShellProfile(key: string, value: string): ExportResult {
	const detected = detectShellProfile()
	if (!detected) return { path: null }

	let { path: profilePath } = detected
	const { shell } = detected

	// Resolve symlinks so we read/write the real file. If the symlink target
	// doesn't exist yet, realpathSync throws ENOENT — fall through and treat
	// profilePath as the file we'll create.
	if (existsSync(profilePath)) {
		try {
			profilePath = realpathSync(profilePath)
		} catch {
			// Couldn't resolve — proceed with the original path.
		}
	}

	const exportLine = shell === "fish" ? `set -gx ${key} ${value}` : `export ${key}=${value}`
	const matchPrefix = shell === "fish" ? `set -gx ${key} ` : `export ${key}=`

	let existing = ""
	if (existsSync(profilePath)) {
		const buf = readFileSync(profilePath)
		if (!isValidUtf8(buf)) {
			return {
				path: null,
				error: `shell profile ${profilePath} contains non-UTF-8 content, skipping`,
			}
		}
		existing = buf.toString("utf-8")
	}

	const newContent = upsertExportLine(existing, exportLine, matchPrefix)
	try {
		atomicWriteFile(profilePath, newContent)
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code
		const reason =
			code === "EACCES" || code === "EPERM"
				? `${profilePath} is read-only`
				: err instanceof Error
					? err.message
					: String(err)
		return { path: null, error: reason, manualLine: `Update ${profilePath} with:\n${exportLine}` }
	}
	return { path: profilePath }
}

/**
 * Replace an existing `export KEY=…` line, or append if none is found.
 * Preserves the trailing newline convention of the existing file (so we
 * don't accidentally introduce or strip a final newline that the user's
 * editor was managing).
 */
function upsertExportLine(content: string, exportLine: string, matchPrefix: string): string {
	const lines = content.split("\n")
	for (let i = 0; i < lines.length; i += 1) {
		if (lines[i].trimStart().startsWith(matchPrefix)) {
			lines[i] = exportLine
			return lines.join("\n")
		}
	}
	// No existing line. Insert the new line *before* the trailing empty
	// entry that comes from a final newline in `content`, so the file
	// ends with `…\nexport …\n` rather than `…\n\nexport …`.
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines[lines.length - 1] = exportLine
		lines.push("")
	} else {
		lines.push(exportLine)
	}
	return lines.join("\n")
}

interface DetectedProfile {
	path: string
	shell: "zsh" | "bash" | "fish"
}

function detectShellProfile(): DetectedProfile | null {
	const home = homedir()
	if (!home) return null

	const shellEnv = process.env.SHELL ? basename(process.env.SHELL) : ""
	switch (shellEnv) {
		case "zsh":
			return { path: join(home, ".zshrc"), shell: "zsh" }
		case "bash":
			return {
				path: join(home, platform() === "darwin" ? ".bash_profile" : ".bashrc"),
				shell: "bash",
			}
		case "fish":
			return { path: join(home, ".config", "fish", "config.fish"), shell: "fish" }
	}

	// Fallback: probe for an existing profile file. macOS users with a
	// generic /bin/sh shell still typically have ~/.zshrc; Linux users
	// most often have ~/.bashrc.
	if (platform() === "darwin" && existsFile(join(home, ".zshrc"))) {
		return { path: join(home, ".zshrc"), shell: "zsh" }
	}
	if (existsFile(join(home, ".bashrc"))) {
		return { path: join(home, ".bashrc"), shell: "bash" }
	}
	if (existsFile(join(home, ".bash_profile"))) {
		return { path: join(home, ".bash_profile"), shell: "bash" }
	}
	return null
}

function existsFile(path: string): boolean {
	try {
		return statSync(path).isFile()
	} catch {
		return false
	}
}

function isValidUtf8(buf: Buffer): boolean {
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(buf)
		return true
	} catch {
		return false
	}
}

function atomicWriteFile(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true })
	const tmp = `${path}.${process.pid}.tmp`
	writeFileSync(tmp, content, "utf-8")
	renameSync(tmp, path)
}
