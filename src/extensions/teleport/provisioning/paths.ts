import { basename } from "node:path"
import { FALLBACK_TARGET_NAME, SANDBOX_HOME } from "./constants.js"

/**
 * Derive the sandbox destination directory for the local workspace at `localCwd`.
 * Uses `basename(localCwd)` (sanitised) as the target dir under `SANDBOX_HOME`.
 * Falls back to `FALLBACK_TARGET_NAME` if the basename is empty or `.`.
 */
export function deriveSandboxDest(localCwd: string): string {
	const trimmed = localCwd.replace(/\/+$/, "")
	const raw = basename(trimmed)
	const cleaned = raw.replace(/[/\0]/g, "_")
	const name = cleaned.length > 0 && cleaned !== "." ? cleaned : FALLBACK_TARGET_NAME
	return `${SANDBOX_HOME}/${name}/`
}

/**
 * Extract the repository folder name from a git remote URL (HTTPS or SSH
 * shorthand), strip a trailing `.git`, and coerce to the worker's
 * `targetDirectory` charset (`[A-Za-z0-9-_]`). Falls back to
 * `FALLBACK_TARGET_NAME` if no name can be recovered.
 */
export function repoBasename(repoUrl: string): string {
	let raw: string | undefined

	const sshMatch = repoUrl.match(/:([^/]+\/)?([^/]+?)(?:\.git)?$/)
	if (sshMatch?.[2]) raw = sshMatch[2]

	if (raw === undefined) {
		try {
			const parsed = new URL(repoUrl)
			const segments = parsed.pathname.split("/").filter(Boolean)
			const last = segments.at(-1)
			if (last) raw = last.replace(/\.git$/, "")
		} catch {
			// not a valid URL
		}
	}

	if (raw === undefined) {
		const stripped = basename(repoUrl.replace(/\.git$/, "").replace(/\/+$/, ""))
		if (stripped) raw = stripped
	}

	const cleaned = (raw ?? "").replace(/[^A-Za-z0-9\-_]/g, "_")
	return cleaned.length > 0 ? cleaned : FALLBACK_TARGET_NAME
}

/**
 * Derive a sandbox destination directory from a git remote URL.
 */
export function deriveSandboxDestFromRepoUrl(repoUrl: string): string {
	return `${SANDBOX_HOME}/${repoBasename(repoUrl)}/`
}
