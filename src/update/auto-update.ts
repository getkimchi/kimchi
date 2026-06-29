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
// `kimchi update --force` etc. Compared case-insensitively at argv[2] or as
// the value of a `--flag=value` argument.
const SKIP_SUBCOMMANDS = new Set(["update", "setup", "mcp", "login", "install"])

// Pure flags that suppress auto-update. Checked anywhere in argv.
const SKIP_FLAGS = new Set(["--no-auto-update", "--version", "-v", "--help", "-h"])

function warn(message: string): void {
	process.stderr.write(`${LOG_PREFIX} ${message}\n`)
}

/**
 * Replace the running process with the same binary at `process.execPath`
 * using the supplied argv and env. Linux/macOS only.
 *
 * `process.execve` is a Node.js extension not in @types/node — we cast
 * through `unknown` to keep the call typed without an ambient declaration.
 *
 * Exported so tests can spy on it. Production callers should invoke
 * `maybeAutoUpdateOnLaunch`, which gates platform + applies the update
 * first.
 */
export function performReExec(argv: readonly string[], env: NodeJS.ProcessEnv): never {
	const execve = (
		process as unknown as {
			execve?: (file: string, args: readonly string[], env: NodeJS.ProcessEnv) => never
		}
	).execve
	if (typeof execve !== "function") {
		// Unreachable in production: maybeAutoUpdateOnLaunch short-circuits
		// on win32 before reaching here. Tests that stub execve via this
		// helper will replace it with a spy and never fall through.
		throw new Error("process.execve is not available on this platform")
	}
	execve(process.execPath, argv, env)
	// execve does not return on success.
	throw new Error("process.execve returned unexpectedly")
}

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
	// `--flag=<subcommand>` form — e.g. `--command=update`.
	for (const arg of argv) {
		if (!arg.startsWith("--")) continue
		const eq = arg.indexOf("=")
		if (eq <= 0) continue
		const value = arg.slice(eq + 1).toLowerCase()
		if (SKIP_SUBCOMMANDS.has(value)) return true
	}
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
 *   - isHomebrewInstall() returns true
 *   - running on a canary build (canary users stay on the canary track;
 *     currency is checked via `kimchi update --canary`)
 *   - loadAutoUpdateSetting() returns false
 *   - argv contains a subcommand (`update`/`setup`/`mcp`/`login`/`install`)
 *   - argv contains `--no-auto-update`, `--version`, `-v`, `--help`, `-h`
 *   - checkForUpdate throws or reports no update
 *   - applyUpdate throws (network, checksum, smoke-test failure)
 *   - opts.signal is already aborted (caller's deadline has passed)
 *
 * On success (Linux/macOS): re-exec into the new binary.
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
		if (isHomebrewInstall()) return
		if (parseCanarySha7(getVersion()) !== null) return
		if (!loadAutoUpdateSetting()) return
		if (argvHasSkipTrigger(process.argv)) return
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

		// argv[0] is the same script entry the current process was launched
		// with. process.argv.slice(1) gives us exactly that — drop the
		// leading "node" or "/path/to/kimchi" and keep the user args.
		performReExec([process.execPath, ...process.argv.slice(1)], process.env)
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
