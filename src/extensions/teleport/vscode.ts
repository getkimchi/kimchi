import { type SpawnOptions, type SpawnSyncOptions, spawn, spawnSync } from "node:child_process"

/**
 * Per-invocation hooks so tests can inject fake spawners without touching the
 * real process table.
 */
export interface VsCodeInternals {
	_spawnSync?: typeof spawnSync
	_spawn?: typeof spawn
}

/** Commands to probe, in priority order: stable first, then Insiders. */
const CODE_COMMANDS = ["code", "code-insiders"]

/** VS Code Remote-SSH scheme prefix. */
const REMOTE_SCHEME = "ssh-remote+"

/**
 * Resolves which `code` command is available on PATH.
 *
 * Probes `code` first, then falls back to `code-insiders` for users running
 * the Insiders build. Uses `shell: true` so it resolves `code.cmd` on Windows
 * and the `code` shell-script shim on macOS/Linux. Best-effort: any failure
 * (non-zero exit, signal, thrown error) is treated as "not available".
 */
export function resolveVsCodeCommand(internals: VsCodeInternals = {}): string | null {
	const run = internals._spawnSync ?? spawnSync
	const opts: SpawnSyncOptions = { shell: true, stdio: "ignore", timeout: 5_000 }
	for (const cmd of CODE_COMMANDS) {
		try {
			const result = run(cmd, ["--version"], opts)
			if (result.status === 0) return cmd
		} catch {
			// try next candidate
		}
	}
	return null
}

/**
 * Detects whether a VS Code command (`code` or `code-insiders`) is available
 * on PATH. Convenience wrapper around {@link resolveVsCodeCommand}.
 */
export function isVsCodeAvailable(internals: VsCodeInternals = {}): boolean {
	return resolveVsCodeCommand(internals) !== null
}

/**
 * Launches VS Code connected to a remote SSH host, opening `remotePath` as the
 * workspace folder. Fire-and-forget: the child is detached and unreffed so
 * it survives the parent and kimchi's TUI keeps running.
 *
 * Uses `shell: true` for the same cross-platform `code` resolution reasons as
 * {@link resolveVsCodeCommand}.
 *
 * @param command The command to launch (from {@link resolveVsCodeCommand}).
 */
export function launchVsCodeRemote(
	command: string,
	alias: string,
	remotePath: string,
	internals: VsCodeInternals = {},
): void {
	const run = internals._spawn ?? spawn
	const target = `${REMOTE_SCHEME}${alias}`
	const opts: SpawnOptions = { shell: true, detached: true, stdio: "ignore" }
	const child = run(command, ["--remote", target, remotePath], opts)
	// Detach so VS Code outlives kimchi — we neither wait for nor observe it.
	child.unref()
}
