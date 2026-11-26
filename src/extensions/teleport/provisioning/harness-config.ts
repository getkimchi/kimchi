import { spawn } from "node:child_process"
import { getAgentConfigDir, loadConfig } from "../../../config.js"
import { SANDBOX_HOME, SANDBOX_USER } from "./constants.js"
import { buildProxyCommand } from "./proxy-command.js"
import { formatRsyncFailure, runRsync } from "./rsync-runner.js"
import { buildSshArgv, buildSshProxyEnv, withSshSession } from "./sandbox-ssh.js"

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

/** Fresh remotes resolve their default env to envs/default/ — the harness
 *  config target must match where the remote kimchi actually reads it. */
const REMOTE_ENVS_DEFAULT_HARNESS_CONFIG_DIR = `${SANDBOX_HOME}/.config/kimchi/envs/default/harness`

/**
 * Pure: the sh probe that classifies the remote's default env. Prints
 * "legacy" when ~/.config/kimchi holds any state besides envs/ (mirrors
 * resolveKimchiEnv's probe in src/env-root.ts), "fresh" otherwise.
 */
export function buildRemoteEnvProbeCommand(): string {
	const d = `${SANDBOX_HOME}/.config/kimchi`
	return `for e in ${d}/* ${d}/.[!.]*; do [ -e "$e" ] || continue; b=\${e##*/}; [ "$b" = envs ] || { echo legacy; exit 0; }; done; echo fresh`
}

/**
 * Pure: pick the provisioning target from the probe's output. A "legacy"
 * result targets the legacy harness dir; anything else (fresh remote, or a
 * probe that failed) targets the remote's envs/default tree — the SAFE
 * fallback: creating envs/ never flips a remote that already resolved
 * legacy (the probe ignores envs/), while planting the legacy marker on a
 * remote that resolved fresh would orphan its sessions and auth. Without
 * this, provisioning a remote that had already created envs/default state
 * could flip the remote's default env.
 */
export function resolveRemoteHarnessConfigDir(probeOutput: string | undefined): string {
	return probeOutput?.trim() === "legacy" ? REMOTE_HARNESS_CONFIG_DIR : REMOTE_ENVS_DEFAULT_HARNESS_CONFIG_DIR
}

async function probeRemoteDefaultEnv(args: {
	remoteHost: string
	authToken: string
	signal?: AbortSignal
}): Promise<string | undefined> {
	try {
		return await withSshSession(async ({ knownHostsFile }) => {
			const argv = buildSshArgv({
				proxyCommand: buildProxyCommand(),
				knownHostsFile,
				destination: `${SANDBOX_USER}@${args.remoteHost}`,
				remoteCommand: buildRemoteEnvProbeCommand(),
			})
			return await new Promise<string | undefined>((resolve) => {
				let stdout = ""
				const child = spawn(argv[0], argv.slice(1), {
					env: {
						...process.env,
						...buildSshProxyEnv({ apiKey: loadConfig().apiKey, authToken: args.authToken }),
					},
					signal: args.signal,
					stdio: ["ignore", "pipe", "ignore"],
				})
				child.stdout?.on("data", (chunk: Buffer) => {
					stdout += chunk.toString("utf-8")
				})
				child.on("error", () => resolve(undefined))
				child.on("close", (code) => resolve(code === 0 ? stdout : undefined))
			})
		})
	} catch {
		return undefined
	}
}

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
	/** Test seam: overrides the remote default-env probe. */
	_probe?: (args: { remoteHost: string; authToken: string; signal?: AbortSignal }) => Promise<string | undefined>
}): Promise<ProvisionHarnessConfigResult> {
	const localConfigDir = getAgentConfigDir()
	try {
		// Sync into the remote's ACTUAL default-env harness dir (probed above):
		// a remote that already created envs/default state must not be flipped
		// to the legacy layout by this mkdir, or its earlier sessions/auth
		// would be orphaned.
		const remoteTarget = resolveRemoteHarnessConfigDir(await (args._probe ?? probeRemoteDefaultEnv)(args))
		await runRsync({
			// Trailing slash is load-bearing: without it rsync copies the `harness`
			// directory *into* the remote `harness` dir (which mkdir just created),
			// nesting it as .../harness/harness/settings.json instead of
			// .../harness/settings.json. The trailing slash copies the dir's
			// *contents* into the dest.
			localPath: `${localConfigDir}/`,
			remotePath: remoteTarget,
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
