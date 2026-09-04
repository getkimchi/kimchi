/**
 * Makes broken-pipe errors (EPIPE / ECONNRESET) from the process's uncaught
 * exception path non-fatal.
 *
 * A child process that ignores its stdin and exits can make a write to its pipe
 * fail asynchronously with EPIPE. When such an error reaches the SDK's uncaught
 * exception handler it would otherwise call `uncaughtCrash`, which restores the
 * terminal and exits the process. A broken pipe is benign and must not take the
 * CLI down, so we drop it here and let every other error crash as before.
 *
 * This module is imported for side effects. It must be loaded **before** any
 * `InteractiveMode` instance is constructed so the prototype patch takes effect.
 * The SDK registers its handler as `(error) => this.uncaughtCrash(error)`, so
 * wrapping the prototype method takes effect regardless of registration order.
 */

import { InteractiveMode } from "@earendil-works/pi-coding-agent"

type UncaughtCrash = (this: unknown, error: unknown) => void

interface PatchableInteractiveMode {
	prototype: {
		uncaughtCrash?: UncaughtCrash
		_kimchiUncaughtEpipePatch?: boolean
	}
}

function isBrokenPipeError(error: unknown): boolean {
	// A broken pipe surfaces as EPIPE for a regular pipe, and as ECONNRESET when the
	// child's stdio is backed by a socket pair. Both mean the reader went away, so we
	// treat them as the same benign case. This is deliberately broad: keeping the CLI
	// alive on a stray reset is better than crashing it, and the error cannot be
	// reliably attributed to a specific writer at the uncaught-exception layer.
	const code = (error as NodeJS.ErrnoException | undefined)?.code
	return code === "EPIPE" || code === "ECONNRESET"
}

/** Exported for testing: applies the prototype patch (idempotent re-apply is safe). */
export function installUncaughtEpipePatch(
	modeClass: PatchableInteractiveMode = InteractiveMode as unknown as PatchableInteractiveMode,
): void {
	const proto = modeClass.prototype
	if (proto._kimchiUncaughtEpipePatch) return
	const original = proto.uncaughtCrash
	if (!original) {
		// Surface a renamed/moved upstream method instead of silently leaving the
		// broken-pipe guard inactive after an SDK upgrade.
		console.warn("uncaught-epipe patch: InteractiveMode.uncaughtCrash not found, EPIPE guard inactive")
		return
	}

	proto.uncaughtCrash = function patchedUncaughtCrash(this: unknown, error: unknown): void {
		// A broken pipe from a child process that ignored its stdin is benign;
		// return without crashing so the CLI keeps running.
		if (isBrokenPipeError(error)) return
		original.call(this, error)
	}
	proto._kimchiUncaughtEpipePatch = true
}

// Apply patch on module load
installUncaughtEpipePatch()
