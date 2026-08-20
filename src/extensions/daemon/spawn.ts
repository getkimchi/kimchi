/**
 * Detached daemon spawn + stop.
 *
 * Lifecycle contract (the whole point of this module): a daemon spawned
 * here OUTLIVES the kimchi session. It must escape every kill chain the
 * harness has:
 *
 *   1. `ProcessRegistry.shutdown()` kills managed background processes on
 *      `session_shutdown` via the upstream `exec` AbortController →
 *      `killProcessTree` (SIGKILL to the process group). We never go
 *      through upstream `ops.exec`, so the registry never sees us.
 *   2. `killTrackedDetachedChildren()` fires on kimchi SIGHUP/SIGTERM and
 *      kills every pid registered via `trackDetachedChildPid`. We never
 *      call that function.
 *   3. Nothing else reaps orphans: with `detached: true` node calls
 *      `setsid` in the child, so the daemon becomes its own process-group
 *      leader, reparented to init when kimchi exits.
 *
 * Spawn mechanics:
 *   spawn("bash", ["-c", "exec bash -c \"<command>\" >> <log> 2>&1"], { detached, stdio: "ignore" })
 *
 * The outer `exec` replaces the outer shell with ONE inner `bash -c`, so
 * `child.pid` is the daemon's process-group id: `kill(-pid)` in stop()
 * reaches exactly the daemon tree. If the user's command ends in `exec`
 * (or is a single simple command) the inner bash may replace itself too,
 * but for compound commands a thin inner-bash wrapper stays behind as the
 * group leader — group kill behaves the same either way. stdout and
 * stderr are shell-redirected into the state-dir log file (stdio is
 * ignored, so kimchi keeps no pipes open and `unref()` lets the node
 * process exit freely).
 *
 * Windows note: `detached: true` + `windowsHide` behaves differently (no
 * setsid, no process groups); stop() falls back to `taskkill /T /F`.
 * Verified on POSIX only — benchmark targets are Linux containers.
 */
import { spawn, spawnSync } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import { type DaemonRecord, isPidAlive, makeDaemonId, registerDaemon, unregisterDaemon } from "./state.js"

/** How long to wait after spawn before checking the daemon didn't die instantly. */
const CRASH_GRACE_MS = 500

/** Grace between SIGTERM and SIGKILL when stopping. */
const STOP_TERM_GRACE_MS = 2000

/** Default shell. POSIX-first; Windows support is best-effort. */
const SHELL = process.platform === "win32" ? "cmd.exe" : "bash"
const SHELL_ARGS = (cmd: string) => (process.platform === "win32" ? ["/c", cmd] : ["-c", cmd])

export interface SpawnDaemonOptions {
	command: string
	cwd: string
	name?: string
	stateDir: string
	/** Override for tests: crash-detection grace in ms. */
	crashGraceMs?: number
}

export type SpawnDaemonOutcome = { ok: true; record: DaemonRecord } | { ok: false; error: string }

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Read the last `maxBytes` of a log file (or undefined when absent). */
export function readLogTail(logFile: string, maxBytes = 8192): string | undefined {
	if (!existsSync(logFile)) return undefined
	try {
		const buf = readFileSync(logFile)
		let slice = buf.length > maxBytes ? buf.subarray(buf.length - maxBytes) : buf
		// Snap the cut to a UTF-8 code-point boundary — slicing mid-sequence
		// would write replacement characters (mojibake) at the start of the
		// tail. Continuation bytes have the form 10xx xxxx; skip past them.
		let start = 0
		while (start < slice.length && (slice[start] & 0xc0) === 0x80) start++
		if (start > 0) slice = slice.subarray(start)
		return slice.toString("utf8")
	} catch (err) {
		console.error(`daemon: failed to read log ${logFile}:`, err)
		return undefined
	}
}

export async function spawnDaemon(opts: SpawnDaemonOptions): Promise<SpawnDaemonOutcome> {
	const { command, cwd, name, stateDir } = opts
	if (command.trim().length === 0) {
		return { ok: false, error: "Empty command — nothing to daemonize." }
	}
	const id = makeDaemonId(name)
	const logFile = `${stateDir}/${id}.log`
	const pidFile = `${stateDir}/${id}.pid`

	// Wrap the user's command behind `bash -c` so exec applies to ONE
	// process: `exec <compound> >> log` would only exec+redirect the first
	// segment and silently drop the rest. JSON.stringify double-quotes and
	// escapes for safe single-arg shell embedding. Windows (cmd) has no
	// exec/setsid semantics; run the command plainly there.
	const wrapped =
		process.platform === "win32"
			? `${command} >> ${JSON.stringify(logFile)} 2>&1`
			: `exec bash -c ${JSON.stringify(command)} >> ${JSON.stringify(logFile)} 2>&1`

	const child = spawn(SHELL, SHELL_ARGS(wrapped), {
		cwd,
		// NOT process.env passthrough blind spot: daemons want the same env the
		// user's shell would see; process.env is the sanest default here.
		env: process.env,
		detached: true,
		stdio: "ignore",
		windowsHide: true,
	})
	child.unref()

	if (child.pid === undefined) {
		return { ok: false, error: "Failed to spawn daemon: no pid assigned." }
	}

	const record: DaemonRecord = {
		id,
		pid: child.pid,
		command,
		cwd,
		name,
		startedAt: new Date().toISOString(),
		logFile,
		pidFile,
	}
	registerDaemon(stateDir, record)

	// Crash-grace: give the daemon a moment to die if it's going to
	// (port-in-use, missing binary, bad flags). The single most common
	// "server started" lie is a command that exits inside the first second.
	const grace = opts.crashGraceMs ?? CRASH_GRACE_MS
	if (grace > 0) await sleep(grace)
	if (!isPidAlive(child.pid)) {
		const tail = readLogTail(logFile, 2048)
		unregisterDaemon(stateDir, id)
		return {
			ok: false,
			error:
				`Daemon ${id} (pid ${child.pid}) exited immediately. The command probably failed at startup.` +
				(tail ? `\n\n--- last output ---\n${tail.trimEnd()}` : ""),
		}
	}

	return { ok: true, record }
}

/**
 * Stop a daemon: SIGTERM the process group, grace, then SIGKILL. The
 * daemon is a process-group leader (spawned detached), so -pid reaches
 * the whole tree. Idempotent: a dead pid is reported, not an error.
 */
export async function stopDaemon(record: DaemonRecord, stateDir: string): Promise<{ stopped: boolean; note: string }> {
	const { pid } = record
	if (!isPidAlive(pid)) {
		unregisterDaemon(stateDir, record.id)
		return { stopped: false, note: `Daemon ${record.id} (pid ${pid}) was already not running. Record cleaned up.` }
	}

	if (process.platform === "win32") {
		// No POSIX process groups; taskkill /T kills the tree.
		spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" })
	} else {
		try {
			process.kill(-pid, "SIGTERM")
		} catch (err) {
			// ESRCH on a disappearing group is fine — the liveness check above
			// raced a natural exit.
			console.error(`daemon: SIGTERM to group -${pid} failed:`, err)
		}
		const deadline = Date.now() + STOP_TERM_GRACE_MS
		while (isPidAlive(pid) && Date.now() < deadline) {
			await sleep(100)
		}
		if (isPidAlive(pid)) {
			try {
				process.kill(-pid, "SIGKILL")
			} catch (err) {
				console.error(`daemon: SIGKILL to group -${pid} failed:`, err)
			}
		}
	}

	unregisterDaemon(stateDir, record.id)
	const stillAlive = isPidAlive(pid)
	return stillAlive
		? {
				stopped: false,
				note: `Sent SIGKILL to daemon ${record.id} (pid ${pid}) but it is still alive — manual intervention needed.`,
			}
		: { stopped: true, note: `Daemon ${record.id} (pid ${pid}) stopped. Log kept at ${record.logFile}.` }
}
