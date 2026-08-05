import { getAgentConfigDir } from "../../../config.js"
import { SANDBOX_HOME, SANDBOX_USER } from "./constants.js"
import { formatRsyncFailure, runRsync } from "./rsync-runner.js"

/** Allowlist — only these transfer. --files-from is case-sensitive, so a
 * hypothetical Auth.json can't bypass this the way it would a lowercase
 * denylist. New secret files are safe by default. */
export const HARNESS_CONFIG_ALLOWLIST: readonly string[] = ["settings.json", "keybindings.json", "themes"]

/** Remote destination for harness config: ~/.config/kimchi/harness/ (derived from SANDBOX_HOME). */
export const REMOTE_HARNESS_CONFIG_DIR = `${SANDBOX_HOME}/.config/kimchi/harness`

export interface ProvisionHarnessConfigResult {
	ok: boolean
	error?: string
}

/**
 * Sync the user's harness config (~/.config/kimchi/harness/) to the remote
 * sandbox. Only safe, non-secret files are transferred (settings.json,
 * keybindings.json, themes/). Everything else — including auth.json,
 * mcp.json, models.json, and any future secret file — is implicitly
 * excluded.
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
