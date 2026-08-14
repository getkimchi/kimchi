import { getAgentConfigDir } from "../../../config.js"
import { SANDBOX_HOME, SANDBOX_USER } from "./constants.js"
import { formatRsyncFailure, runRsync } from "./rsync-runner.js"

/** Allowlist — only these transfer. --files-from is case-sensitive, so a
 * hypothetical Auth.json can't bypass this the way it would a lowercase
 * denylist. New secret files are safe by default.
 *
 * NOTE: models.json may carry provider `apiKey` fields. Syncing it verbatim
 * is an accepted trade-off: those keys land on the remote sandbox the user
 * owns. auth.json / mcp.json (OAuth + MCP tokens) stay excluded. */
export const HARNESS_CONFIG_ALLOWLIST: readonly string[] = [
	"settings.json",
	"keybindings.json",
	// Trailing slash is load-bearing: in --files-from mode, a bare `themes`
	// entry transfers as an EMPTY directory while rsync still exits 0 —
	// the remote gets no theme files at all and the session falls back
	// with "Failed to load theme". Verified on GNU rsync 3.5 (Linux) and
	// macOS openrsync — both need `themes/` to recurse.
	"themes/",
	"models.json",
]

/** Remote destination for harness config: ~/.config/kimchi/harness/ (derived from SANDBOX_HOME). */
export const REMOTE_HARNESS_CONFIG_DIR = `${SANDBOX_HOME}/.config/kimchi/harness`

export interface ProvisionHarnessConfigResult {
	ok: boolean
	error?: string
}

/**
 * Sync the user's harness config (~/.config/kimchi/harness/) to the remote
 * sandbox. Only allowlisted files transfer (settings.json, keybindings.json,
 * themes/, models.json). auth.json and mcp.json (OAuth + MCP tokens) and any
 * future secret file are implicitly excluded. models.json may carry provider
 * apiKey fields — see HARNESS_CONFIG_ALLOWLIST note.
 *
 * Runs with deleteExtraneous=false so remote-only files (auth.json, mcp.json
 * created by the remote) are preserved — we overwrite synced files but don't
 * wipe the remote's own state.
 *
 * Failures are non-fatal: the caller decides whether to warn or refuse.
 * On abort (signal already aborted), re-throws so the caller's cancellation
 * path handles it.
 */
export async function provisionHarnessConfig(args: {
	remoteHost: string
	authToken: string
	signal?: AbortSignal
}): Promise<ProvisionHarnessConfigResult> {
	const localConfigDir = getAgentConfigDir()
	try {
		await runRsync({
			// Trailing slash is load-bearing: without it rsync copies the `harness`
			// directory *into* the remote `harness` dir (which mkdir just created),
			// nesting it as .../harness/harness/settings.json instead of
			// .../harness/settings.json. The trailing slash copies the dir's
			// *contents* into the dest.
			localPath: `${localConfigDir}/`,
			remotePath: REMOTE_HARNESS_CONFIG_DIR,
			isSourceDirectory: true,
			remoteHost: args.remoteHost,
			remoteUser: SANDBOX_USER,
			authToken: args.authToken,
			filesFrom: [...HARNESS_CONFIG_ALLOWLIST],
			deleteExtraneous: false,
			signal: args.signal,
		})
		return { ok: true }
	} catch (err) {
		if (args.signal?.aborted) throw err
		return { ok: false, error: formatRsyncFailure(err) }
	}
}
