import { getAgentConfigDir } from "../../../config.js"
import { SANDBOX_HOME, SANDBOX_USER } from "./constants.js"
import { formatRsyncFailure, runRsync } from "./rsync-runner.js"

/**
 * Exclude patterns for the harness config rsync. Applied on top of
 * BASE_EXCLUDE_GLOBS from rsync-runner (which already excludes .env,
 * .DS_Store, node_modules, etc.). These are the harness-specific files
 * that are either secret, runtime state, or machine-specific.
 */
export const HARNESS_CONFIG_EXCLUDES: readonly string[] = [
	"auth.json",
	"mcp.json",
	"mcp-cache.json",
	"models.json",
	"skills/",
	"sessions/",
	"ferment-locks/",
	"git/",
	"bin/",
	"rtk/",
	"trust.json",
	"auto-update.json",
	".curator_state.json",
	".usage.json",
	".usage.json.lock",
]

/** Remote destination for harness config: ~/.config/kimchi/harness/ (derived from SANDBOX_HOME). */
export const REMOTE_HARNESS_CONFIG_DIR = `${SANDBOX_HOME}/.config/kimchi/harness`

export interface ProvisionHarnessConfigResult {
	ok: boolean
	error?: string
}

/**
 * Sync the user's harness config (~/.config/kimchi/harness/) to the remote
 * sandbox. Only safe, non-secret files are transferred (settings.json,
 * keybindings.json, themes/). Sensitive files are excluded via
 * HARNESS_CONFIG_EXCLUDES.
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
			excludeGlobs: [...HARNESS_CONFIG_EXCLUDES],
			gitignoredPaths: [],
			deleteExtraneous: false,
			signal: args.signal,
		})
		return { ok: true }
	} catch (err) {
		if (args.signal?.aborted) throw err
		return { ok: false, error: formatRsyncFailure(err) }
	}
}
