/**
 * Sandbox-ssh: the single owner of how local processes ssh into a sandbox
 * over the WS proxy tunnel (see CONTEXT.md). Every ssh/rsync/git invocation
 * into a sandbox derives its policy from here — the ssh option layout in
 * both argv and string form, the proxy auth environment, and the per-call
 * temp session (fresh known_hosts, removed on every exit path).
 *
 * Two forms, one policy:
 *  - argv form (buildSshArgv) for direct `spawn("ssh", ...)` calls;
 *  - string form (buildSshCommandString) for consumers that re-tokenize a
 *    command line: rsync's `-e` splitter and git's GIT_SSH_COMMAND (`sh -c`).
 *    Space-bearing values are POSIX single-quoted — the one quoting both
 *    parsers honor.
 *
 * The ProxyCommand value itself comes from buildProxyCommand already
 * shell-quoted for its own argv; quoting it again here as one token is
 * lossless (the '\'' escaping round-trips through both parsers).
 */

import { randomUUID } from "node:crypto"
import { mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** The two caller-varying inputs the policy needs. Everything else is fixed. */
export interface SandboxSshPolicy {
	/** ssh ProxyCommand value — the local node helper bridging the WS tunnel. */
	proxyCommand: string
	/** Per-call known_hosts path (inside the withSshSession temp dir). */
	knownHostsFile: string
}

/**
 * POSIX single-quote with '\'' escaping. Lossless for both `sh -c` (git's
 * GIT_SSH_COMMAND) and rsync's `-e` word splitter: adjacent quoted/unquoted
 * segments concatenate back to the original value.
 */
export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`
}

/**
 * The one sandbox ssh policy: route through the ProxyCommand tunnel, accept
 * the sandbox's ephemeral host key on first contact (the WSS endpoint's TLS
 * carries identity), never prompt, and keep idle tunnels alive.
 */
export function buildSshOptions(policy: SandboxSshPolicy): string[] {
	return [
		"-o",
		`ProxyCommand=${policy.proxyCommand}`,
		"-o",
		"StrictHostKeyChecking=accept-new",
		"-o",
		`UserKnownHostsFile=${policy.knownHostsFile}`,
		"-o",
		"BatchMode=yes",
		"-o",
		"ServerAliveInterval=15",
	]
}

export interface BuildSshArgvInput extends SandboxSshPolicy {
	/** `user@host` destination expanded by the tunnel (%h in ProxyCommand). */
	destination: string
	/** Command run on the sandbox; omitted for bare connection probes. */
	remoteCommand?: string
}

/** Argv form: policy options + destination + optional remote command. */
export function buildSshArgv(input: BuildSshArgvInput): string[] {
	const argv = [...buildSshOptions(input), input.destination]
	if (input.remoteCommand !== undefined) argv.push(input.remoteCommand)
	return argv
}

/**
 * String form for consumers that re-tokenize a command line — rsync's `-e`
 * splitter (POSIX single quotes only) and git's GIT_SSH_COMMAND (`sh -c`).
 * The two values that can contain spaces (ProxyCommand's `%h %p` suffix,
 * known_hosts under a space-bearing $TMPDIR) are single-quoted so each
 * survives as one token.
 */
export function buildSshCommandString(policy: SandboxSshPolicy): string {
	return [
		"ssh",
		"-o",
		`ProxyCommand=${shellQuote(policy.proxyCommand)}`,
		"-o",
		"StrictHostKeyChecking=accept-new",
		"-o",
		`UserKnownHostsFile=${shellQuote(policy.knownHostsFile)}`,
		"-o",
		"BatchMode=yes",
		"-o",
		"ServerAliveInterval=15",
	].join(" ")
}

/**
 * Env the ProxyCommand helper authenticates with: the cloud API key (listing
 * endpoint) and the per-workspace bearer token (WS tunnel). Callers resolve
 * the key (loadConfig etc.) — this module never reads config.
 */
export function buildSshProxyEnv(input: { apiKey: string; authToken: string }): NodeJS.ProcessEnv {
	return { KIMCHI_API_KEY: input.apiKey, AUTH_TOKEN: input.authToken }
}

export interface SshSession {
	/** Private temp dir for anything the call needs (list files, sockets). */
	dir: string
	/** Empty known_hosts — the call accepts the ephemeral host key fresh. */
	knownHostsFile: string
}

/**
 * Per-call ssh session: a private temp dir with an empty known_hosts, removed
 * on every exit path (success, error, abort). Replaces the
 * mkdtemp/writeFile/cleanup triplet each caller used to hand-roll.
 */
export async function withSshSession<T>(run: (session: SshSession) => Promise<T>): Promise<T> {
	const dir = join(tmpdir(), `kimchi-sandbox-ssh-${randomUUID()}`)
	const knownHostsFile = join(dir, "known_hosts")
	try {
		await mkdir(dir, { recursive: true })
		await writeFile(knownHostsFile, "", "utf-8")
		return await run({ dir, knownHostsFile })
	} finally {
		// Best-effort: cleanup failure must never mask the real result.
		await rm(dir, { recursive: true, force: true }).catch(() => {})
	}
}
