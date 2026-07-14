// On-launch auto-update: decide whether to swap the binary in the background
// and re-exec into the new version before any UI loads. See Phase 2 of
// .kimchi/docs/auto-update-plan.md for the full decision matrix.
//
// Failure philosophy: any error path falls through to normal launch on the
// current version. We never throw out of this module — entry.ts wraps the
// call in its own try/catch but we also catch internally as defense-in-depth.

import { getVersion } from "../utils.js"
import { isHomebrewInstall } from "./paths.js"
import { loadAutoUpdateSetting } from "./settings.js"
import { applyUpdate, checkForUpdate, parseCanarySha7 } from "./workflow.js"

const LOG_PREFIX = "[kimchi-auto-update]"

// Subcommands that suppress auto-update so we never recurse into
// `kimchi update --force` etc. Compared case-insensitively only at the
// positional argv[2] slot. Scanning arbitrary `--flag=value` arguments
// would suppress auto-update for unrelated user flags that happen to
// contain these strings (e.g. `--tag=update`); no real CLI flag takes a
// skip-subcommand value today.
const SKIP_SUBCOMMANDS = new Set(["update", "setup", "mcp", "login", "install"])

// Pure flags that suppress auto-update. Checked anywhere in argv.
const SKIP_FLAGS = new Set(["--no-auto-update", "--version", "-v", "--help", "-h"])

// Non-interactive CLI modes where an update/re-exec before startup would
// corrupt the protocol stream or surprise external clients. Mirrors the
// logic in cli-args.ts:isProtocolOrPrintMode but stays self-contained so
// auto-update.ts doesn't pull pi-coding-agent into the early import chain
// (entry.ts dynamically imports this module before cli.js).
const NON_INTERACTIVE_MODES = new Set(["json", "rpc", "acp"])

/** Return true when argv selects a non-interactive mode (ACP/JSON/RPC/print/
 *  export). In those modes stdout/stderr belong to the caller and a re-exec
 *  mid-startup would corrupt the protocol stream or break scripts. */
export function isNonInteractiveLaunch(argv: readonly string[]): boolean {
	// --mode=<value> or --mode <value>
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i]
		if (arg === "--mode" && i + 1 < argv.length) {
			if (NON_INTERACTIVE_MODES.has(argv[i + 1])) return true
		}
		if (arg.startsWith("--mode=")) {
			if (NON_INTERACTIVE_MODES.has(arg.slice("--mode=".length))) return true
		}
	}
	// --print / -p: piped output mode
	if (argv.includes("--print") || argv.includes("-p")) return true
	// --export: writes to a file and exits
	if (argv.includes("--export") || argv.some((a) => a.startsWith("--export="))) return true
	return false
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
		process.exit(result.exitCode ?? 0)
	}

	throw new ReExecUnavailableError()
}

/** Minimal structural type for the slice of `Bun.spawnSync` we use — avoids a
 *  hard dependency on @types/bun in a file that also builds under Node. */
type BunSpawnSync = (
	cmd: readonly string[],
	opts: { stdio: [string, string, string]; env: NodeJS.ProcessEnv },
) => { exitCode: number | null }

/** Return true when any argv token should suppress auto-update. Exported so
 *  tests can drive it without mutating the worker's `process.argv` (vitest's
 *  worker harness reads it at startup and corrupts state if it's replaced). */
export function argvHasSkipTrigger(argv: readonly string[]): boolean {
	// Pure flags anywhere in argv.
	for (const arg of argv) {
		if (SKIP_FLAGS.has(arg)) return true
	}
	// Positional subcommand at argv[2] (case-insensitive).
	const first = argv[2]
	if (first !== undefined && SKIP_SUBCOMMANDS.has(first.toLowerCase())) return true
	return false
}

/** Default startup budget for the auto-update check. The caller (entry.ts)
 *  races the call against this deadline via `AbortSignal`; we check it
 *  after each await and skip the re-exec swap if the deadline has passed,
 *  so a slow network never blocks the user past the budget. */
const AUTO_UPDATE_DEFAULT_TIMEOUT_MS = 5_000

export interface MaybeAutoUpdateOnLaunchOptions {
	/** When the signal aborts, the function bails out at the next checkpoint
	 *  without performing the re-exec swap. Used by entry.ts to cap startup
	 *  time even when the network is slow. */
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
		if (!loadAutoUpdateSetting()) return
		if (opts.signal?.aborted) return

		let check: Awaited<ReturnType<typeof checkForUpdate>>
		try {
			check = await checkForUpdate({ currentVersion: getVersion(), skipCache: true, canary: false })
		} catch (err) {
			warn(`update check failed: ${(err as Error).message}`)
			return
		}
		if (opts.signal?.aborted) {
			warn("deadline exceeded after update check; skipping auto-update on this launch")
			return
		}
		if (!check.hasUpdate) return

		// Audit log: every auto-update attempt is recorded with the tag and
		// release URL before the binary is downloaded. Checksum verification
		// happens inside applyUpdate; this line is the operator-visible trail.
		warn(`applying update ${check.tag} from ${check.releaseUrl || "<no url>"}`)
		try {
			await applyUpdate({ tag: check.tag })
		} catch (err) {
			warn(`update apply failed: ${(err as Error).message}`)
			return
		}
		if (opts.signal?.aborted) {
			// Update is already on disk via atomicInstall's .old rotation on
			// Windows, or staged for next launch on Linux/macOS (no rename
			// happens until the user runs `kimchi update`). Bail without
			// re-exec — the user's UI must not be torn down after they've
			// already seen it.
			warn(`update ${check.tag} applied but deadline exceeded; restart to use the new version`)
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
