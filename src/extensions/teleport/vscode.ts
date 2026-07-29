import { type SpawnOptions, type SpawnSyncOptions, spawn, spawnSync } from "node:child_process"

/**
 * Per-invocation hooks so tests can inject fake spawners without touching the
 * real process table.
 */
export interface VsCodeInternals {
	_spawnSync?: typeof spawnSync
	_spawn?: typeof spawn
}

/** Command kimchi shells out to when launching / detecting VSCode. */
const CODE_CMD = "code"

/** VSCode Remote-SSH scheme prefix. */
const REMOTE_SCHEME = "ssh-remote+"

/**
 * Detects whether VSCode's `code` command is available on PATH.
 *
 * Uses `shell: true` so it resolves `code.cmd` on Windows and the `code`
 * shell-script shim on macOS/Linux. Best-effort: any failure (non-zero exit,
 * signal, thrown error) is treated as "not available".
 */
export function isVsCodeAvailable(internals: VsCodeInternals = {}): boolean {
	const run = internals._spawnSync ?? spawnSync
	const opts: SpawnSyncOptions = { shell: true, stdio: "ignore", timeout: 5_000 }
	try {
		const result = run(CODE_CMD, ["--version"], opts)
		return result.status === 0
	} catch {
		return false
	}
}

/**
 * Launches VSCode connected to a remote SSH host, opening `remotePath` as the
 * workspace folder. Fire-and-forget: the child is detached and unreffed so
 * it survives the parent and kimchi's TUI keeps running.
 *
 * Uses `shell: true` for the same cross-platform `code` resolution reasons as
 * {@link isVsCodeAvailable}.
 */
export function launchVsCodeRemote(alias: string, remotePath: string, internals: VsCodeInternals = {}): void {
	const run = internals._spawn ?? spawn
	const target = `${REMOTE_SCHEME}${alias}`
	const opts: SpawnOptions = { shell: true, detached: true, stdio: "ignore" }
	const child = run(CODE_CMD, ["--remote", target, remotePath], opts)
	// Detach so VSCode outlives kimchi — we neither wait for nor observe it.
	child.unref()
}
