import { basename } from "node:path"
import { FALLBACK_TARGET_NAME, SANDBOX_HOME } from "./constants.js"

export { deriveSandboxDestFromRepoUrl } from "./git-clone.js"

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
