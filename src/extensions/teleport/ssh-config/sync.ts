import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import type { Workspace } from "../../../sandbox/cloud/types.js"
import { warn } from "../commands/errors.js"
import type { TeleportContext } from "../types.js"
import { resolveSshConfigPaths } from "./paths.js"
import { renderSshConfig } from "./render.js"

const INCLUDE_BEGIN = "# >>> kimchi managed include >>>"
const INCLUDE_END = "# <<< kimchi managed include <<<"

export interface SyncOptions {
	env?: NodeJS.ProcessEnv
	now?: Date
}

/**
 * Best-effort: rewrite the managed ssh_config file from the workspace list.
 * Atomic via tmp-file + rename. Failures are surfaced as warnings only — sync
 * is a side effect, not a critical path.
 */
export async function syncSshConfig(
	workspaces: Workspace[],
	ctx: TeleportContext,
	opts: SyncOptions = {},
): Promise<void> {
	const paths = resolveSshConfigPaths(opts.env)
	const body = renderSshConfig(workspaces, opts.now)
	try {
		await mkdir(paths.managedDir, { recursive: true, mode: 0o700 })
		const tmp = `${paths.managedFile}.tmp`
		await writeFile(tmp, body, { mode: 0o600 })
		await rename(tmp, paths.managedFile)
	} catch (err) {
		warn(ctx, `Could not sync ssh_config: ${err instanceof Error ? err.message : String(err)}`)
	}
}

/**
 * Idempotently add an `Include <managed-file>` directive to the user's
 * `~/.ssh/config`, fenced between marker comments so we can replace just our
 * block on later runs without disturbing the user's other content.
 */
export async function ensureIncludeDirective(ctx: TeleportContext, opts: SyncOptions = {}): Promise<void> {
	const paths = resolveSshConfigPaths(opts.env)
	const block = `${INCLUDE_BEGIN}\nInclude ${paths.managedFile}\n${INCLUDE_END}`

	try {
		await mkdir(paths.sshDir, { recursive: true, mode: 0o700 })

		let existing = ""
		try {
			existing = await readFile(paths.userConfigFile, "utf8")
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
		}

		const next = applyIncludeBlock(existing, block)
		if (next === existing) return

		const tmp = `${paths.userConfigFile}.tmp`
		await writeFile(tmp, next, { mode: 0o600 })
		await rename(tmp, paths.userConfigFile)
	} catch (err) {
		warn(ctx, `Could not update ~/.ssh/config: ${err instanceof Error ? err.message : String(err)}`)
	}
}

/**
 * Returns the file content with our fenced include block at the top. If a
 * block is already present (anywhere in the file) it is replaced in place;
 * otherwise the block is prepended. Returns the input unchanged when the
 * existing block already matches.
 *
 * Exported for testing.
 */
export function applyIncludeBlock(existing: string, block: string): string {
	const beginIdx = existing.indexOf(INCLUDE_BEGIN)
	const endIdx = existing.indexOf(INCLUDE_END)

	if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
		const before = existing.slice(0, beginIdx)
		const after = existing.slice(endIdx + INCLUDE_END.length)
		const current = existing.slice(beginIdx, endIdx + INCLUDE_END.length)
		if (current === block) return existing
		return `${before}${block}${after}`
	}

	if (existing.length === 0) return `${block}\n`
	const sep = existing.startsWith("\n") ? "" : "\n"
	return `${block}\n${sep}${existing}`
}
