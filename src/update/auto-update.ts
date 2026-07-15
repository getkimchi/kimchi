// On-launch auto-update: decide whether to swap the binary in the background
// and re-exec into the new version before any UI loads. See Phase 2 of
// .kimchi/docs/auto-update-plan.md for the full decision matrix.
//
// Failure philosophy: any error path falls through to normal launch on the
// current version. We never throw out of this module — entry.ts wraps the
// call in its own try/catch but we also catch internally as defense-in-depth.

import { basename } from "node:path"
import { type CliMode, getCliModeArg, hasExportFlag, hasPrintFlag, PROTOCOL_MODES } from "../cli-modes.js"
import { getVersion } from "../utils.js"
import { isHomebrewInstall } from "./paths.js"
import { loadAutoUpdateSetting } from "./settings.js"
import { applyUpdate, checkForUpdate, parseCanarySha7 } from "./workflow.js"

const LOG_PREFIX = "[kimchi-auto-update]"

// Subcommands that suppress auto-update so we never recurse into
// `kimchi update --force` etc. Compared case-insensitively against any
// positional argument (not just argv[2]) so `kimchi --some-flag update`
// is also recognized. Only bare positional tokens are checked —
// `--flag=update` is a flag value, not a subcommand.
const SKIP_SUBCOMMANDS = new Set(["update", "setup", "mcp", "login", "install"])

// Pure flags that suppress auto-update. Checked anywhere in argv.
const SKIP_FLAGS = new Set(["--no-auto-update", "--version", "-v", "--help", "-h"])

/** Return true when argv selects a non-interactive mode (ACP/JSON/RPC/print/
 *  export). In those modes stdout/stderr belong to the caller and a re-exec
 *  mid-startup would corrupt the protocol stream or break scripts.
 *
 *  Broader than cli-args.ts:isProtocolOrPrintMode: also skips `--export`,
 *  which writes to a file and exits — a re-exec there would surprise the
 *  caller just as much as in protocol modes. */
export function isNonInteractiveLaunch(argv: readonly string[]): boolean {
	const mode = getCliModeArg(argv)
	return (mode !== undefined && PROTOCOL_MODES.has(mode as CliMode)) || hasPrintFlag(argv) || hasExportFlag(argv)
}

/** Race a promise against a timeout. Returns the promise's result if it
 *  resolves before `ms` elapses; rejects with a TimeoutError otherwise.
 *  Used to cap the checkForUpdate phase without abandoning applyUpdate. */
class TimeoutError extends Error {
	constructor() {
		super("auto-update check timed out")
		this.name = "TimeoutError"
	}
}

function raceWithTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new TimeoutError()), ms)
		;(timer as { unref?: () => void }).unref?.()
	})
	return Promise.race([promise, timeout]).finally(() => {
		if (timer) clearTimeout(timer)
	})
}

function warn(message: string): void {
	process.stderr.write(`${LOG_PREFIX} ${message}\n`)
}

/** Thrown by performReExec when no re-exec primitive is available. Callers
 *  treat this as "binary swapped on disk, but couldn't hand off in-process"
 *  and fall back to a "restart your terminal" message instead of erroring. */
export class ReExecUnavailableError extends Error {
	constructor() {
		super("no re-exec primitive available (process.execve and Bun.spawnSync both missing)")
		this.name = "ReExecUnavailableError"
	}
}

/**
 * Replace the running process with the freshly-installed binary at
 * `process.execPath`, passing the original user args (`userArgs`) and env.
 * Linux/macOS only — Windows uses the `.old` rotation and never calls this.
 *
 * Two mechanisms, in order:
 *   1. `process.execve` — a true exec(2) syscall (Node.js 23+). Replaces the
 *      process image; never returns on success. Not in @types/node, so we
 *      cast through `unknown`.
 *   2. `Bun.spawnSync` — the shipped artifact is a Bun-compiled binary, and
 *      Bun does NOT implement `process.execve`. We launch the new binary as
 *      a child with inherited stdio, wait for it, and exit with its code.
 *      Not a real image replacement, but functionally equivalent for a CLI
 *      that's about to hand control to the new version anyway.
 *
 * Note we re-launch `process.execPath` (the real binary) with `userArgs`
 * only. In a Bun-compiled binary `process.argv[1]` is a virtual `/$bunfs/…`
 * script path that must NOT be forwarded; the binary embeds its own entry.
 *
 * Exported so tests can spy on it. Production callers should invoke
 * `maybeAutoUpdateOnLaunch`, which gates platform + applies the update
 * first. Returns `never` on the success paths (process replaced or exited);
 * throws `ReExecUnavailableError` when neither mechanism exists.
 */
export function performReExec(userArgs: readonly string[], env: NodeJS.ProcessEnv): never {
	const execve = (
		process as unknown as {
			execve?: (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => never
		}
	).execve
	if (typeof execve === "function") {
		// execve's arg vector is the full argv INCLUDING argv[0]; convention
		// is argv[0] === the program path.
		execve(process.execPath, [process.execPath, ...userArgs], env)
		// execve does not return on success.
		throw new Error("process.execve returned unexpectedly")
	}

	const bunSpawnSync = (globalThis as unknown as { Bun?: { spawnSync?: BunSpawnSync } }).Bun?.spawnSync
	if (typeof bunSpawnSync === "function") {
		const result = bunSpawnSync([process.execPath, ...userArgs], {
			stdio: ["inherit", "inherit", "inherit"],
			env,
		})
		// Mirror the child's exit so the terminal sees the same status.
		// When the child is killed by a signal, Bun reports exitCode as null
		// and a signalCode string (e.g. "SIGTERM"). Coalescing null to 0 would
		// mask the failure — use 128+signal-number (the POSIX convention) so
		// the shell sees a non-zero exit matching the child's termination.
		if (result.exitCode !== null) {
			process.exit(result.exitCode)
		}
		const signalNum = result.signalCode ? SIGNAL_TO_NUM[result.signalCode] : undefined
		process.exit(signalNum !== undefined ? 128 + signalNum : 1)
	}

	throw new ReExecUnavailableError()
}

/** Minimal structural type for the slice of `Bun.spawnSync` we use — avoids a
 *  hard dependency on @types/bun in a file that also builds under Node. */
type BunSpawnSync = (
	cmd: readonly string[],
	opts: { stdio: [string, string, string]; env: NodeJS.ProcessEnv },
) => { exitCode: number | null; signalCode?: string | null }

/** Map common signal names to their POSIX numbers so we can derive the
 *  conventional 128+signal exit code when Bun reports exitCode as null. */
const SIGNAL_TO_NUM: Record<string, number> = {
	SIGHUP: 1,
	SIGINT: 2,
	SIGQUIT: 3,
	SIGILL: 4,
	SIGTRAP: 5,
	SIGABRT: 6,
	SIGBUS: 7,
	SIGFPE: 8,
	SIGKILL: 9,
	SIGUSR1: 10,
	SIGSEGV: 11,
	SIGUSR2: 12,
	SIGPIPE: 13,
	SIGALRM: 14,
	SIGTERM: 15,
}

/** Return true when any argv token should suppress auto-update. Exported so
 *  tests can drive it without mutating the worker's `process.argv` (vitest's
 *  worker harness reads it at startup and corrupts state if it's replaced). */
export function argvHasSkipTrigger(argv: readonly string[]): boolean {
	// Pure flags anywhere in argv.
	for (const arg of argv) {
		if (SKIP_FLAGS.has(arg)) return true
	}
	// Subcommand anywhere in argv (case-insensitive). Only bare positional
	// tokens are checked — arguments starting with `--` are flag values, not
	// subcommands.
	for (let i = 2; i < argv.length; i += 1) {
		const arg = argv[i]
		if (!arg.startsWith("-") && SKIP_SUBCOMMANDS.has(arg.toLowerCase())) return true
	}
	return false
}

/** Default startup budget for the update *check* phase. Only
 *  `checkForUpdate` is raced against this deadline; once we commit to
 *  `applyUpdate` we await it fully so the install is never torn down
 *  mid-swap by a timeout. This prevents cli.js from booting while
 *  `applyUpdate` is still mutating files on disk. */
const AUTO_UPDATE_DEFAULT_TIMEOUT_MS = 5_000

/** Hard cap on the apply phase. We never abandon applyUpdate mid-swap, but
 *  a hung network or filesystem during download/copy shouldn't stall TUI
 *  startup indefinitely. If applyUpdate hasn't finished after 30 seconds
 *  we log a warning and continue on the current version. */
const AUTO_UPDATE_APPLY_TIMEOUT_MS = 30_000

export interface MaybeAutoUpdateOnLaunchOptions {
	/** Optional external signal (e.g. from entry.ts). Checked at
	 *  checkpoints before applyUpdate starts; ignored once the install
	 *  has committed. */
	signal?: AbortSignal
}

/**
 * Decide whether to auto-update on launch and, if so, run the swap and
 * re-exec into the new binary.
 *
 * Skipped when ANY of these are true:
 *   - KIMCHI_NO_UPDATE_CHECK is set
 *   - argv contains a subcommand (`update`/`setup`/`mcp`/`login`/`install`)
 *   - argv contains `--no-auto-update`, `--version`, `-v`, `--help`, `-h`
 *   - argv selects a non-interactive mode (ACP/JSON/RPC/print/export)
 *   - isHomebrewInstall() returns true
 *   - running on a canary build (canary users stay on the canary track;
 *     currency is checked via `kimchi update --canary`)
 *   - running from source/dev (getVersion() is "dev" or "unknown", or
 *     process.execPath is not the packaged kimchi binary)
 *   - loadAutoUpdateSetting() returns false
 *   - checkForUpdate throws or reports no update
 *   - applyUpdate throws (network, checksum, smoke-test failure)
 *   - opts.signal is already aborted (caller's deadline has passed)
 *
 * On success (Linux/macOS): hand off to the new binary via performReExec
 * (execve under Node, Bun.spawnSync under the compiled binary). If no
 * re-exec primitive exists, the binary is still swapped on disk — we log a
 * "restart your terminal" note and continue on the current version.
 * On success (Windows): `atomicInstall` rotates `kimchi.exe` → `kimchi.exe.old`
 * in-place, so the current run continues on the (still-current) binary; the
 * user's next terminal relaunch picks up the new version. We log a one-line
 * note and return.
 *
 * On any error: log a single-line stderr warning and return.
 *
 * Never throws.
 */
export async function maybeAutoUpdateOnLaunch(opts: MaybeAutoUpdateOnLaunchOptions = {}): Promise<void> {
	try {
		if (process.env.KIMCHI_NO_UPDATE_CHECK) return
		if (argvHasSkipTrigger(process.argv)) return
		if (isNonInteractiveLaunch(process.argv)) return
		if (isHomebrewInstall()) return
		if (parseCanarySha7(getVersion()) !== null) return
		// Dev/source launches: getVersion() returns "dev" when package.json has
		// the 0.0.0 placeholder. In that case process.execPath is the Bun/Node
		// interpreter, not a packaged kimchi binary — applyUpdate() would try
		// to install the release binary over the interpreter.
		if (getVersion() === "dev") return
		if (getVersion() === "unknown") return
		// Guard against non-packaged binaries (e.g. running via `node src/entry.ts`).
		// The compiled binary is named "kimchi" (or "kimchi.exe" on Windows);
		// if execPath doesn't match, we're not running the real artifact.
		const expectedBinName = process.platform === "win32" ? "kimchi.exe" : "kimchi"
		if (basename(process.execPath) !== expectedBinName) return
		if (!loadAutoUpdateSetting()) return
		if (opts.signal?.aborted) return

		// Race only the *check* phase against the deadline. Once we commit
		// to applyUpdate below, we await it fully — a timeout there would
		// leave the install half-finished with cli.js booting concurrently.
		let check: Awaited<ReturnType<typeof checkForUpdate>>
		try {
			check = await raceWithTimeout(
				checkForUpdate({ currentVersion: getVersion(), skipCache: true, canary: false }),
				AUTO_UPDATE_DEFAULT_TIMEOUT_MS,
			)
		} catch (err) {
			warn(`update check failed: ${(err as Error).message}`)
			return
		}
		if (opts.signal?.aborted) {
			warn("deadline exceeded after update check; skipping auto-update on this launch")
			return
		}
		if (!check.hasUpdate) return

		// Commit point: from here on we await applyUpdate fully. No external
		// Promise.race can abandon it mid-swap — the install must complete
		// before cli.js boots. We do cap with a 30s hard timeout so a hung
		// network or filesystem doesn't stall startup indefinitely; on
		// timeout we log a warning and continue on the current version.
		warn(`applying update ${check.tag} from ${check.releaseUrl || "<no url>"}`)
		try {
			await raceWithTimeout(applyUpdate({ tag: check.tag }), AUTO_UPDATE_APPLY_TIMEOUT_MS)
		} catch (err) {
			if (err instanceof TimeoutError) {
				warn(`update apply timed out after ${AUTO_UPDATE_APPLY_TIMEOUT_MS / 1000}s; skipping this launch`)
				return
			}
			warn(`update apply failed: ${(err as Error).message}`)
			return
		}

		if (process.platform === "win32") {
			// No re-exec on Windows: the swap is in-place via .old rotation.
			warn(`Update installed; restart your terminal to use ${check.latestVersion}.`)
			return
		}

		// Hand off to the freshly-installed binary. We forward only the user
		// args (process.argv.slice(2)); argv[1] is the launcher's own entry
		// (a /$bunfs/… virtual path in the compiled binary) and must not be
		// passed through. performReExec re-prepends process.execPath itself.
		try {
			performReExec(process.argv.slice(2), process.env)
		} catch (err) {
			if (err instanceof ReExecUnavailableError) {
				// Update is on disk but we can't swap into it this launch
				// (no exec primitive). Continue on the current version; the
				// user's next launch picks up the new binary.
				warn(`Update installed; restart your terminal to use ${check.latestVersion}.`)
				return
			}
			throw err
		}
	} catch (err) {
		// Defense in depth — should be unreachable given the inner
		// try/catches, but if any helper throws unexpectedly we still
		// fall through to a normal launch.
		warn(`unexpected: ${(err as Error).message}`)
	}
}

// Re-exported for entry.ts so the timeout stays co-located with the module
// it gates. Not part of the public API.
export const DEFAULT_AUTO_UPDATE_TIMEOUT_MS = AUTO_UPDATE_DEFAULT_TIMEOUT_MS
