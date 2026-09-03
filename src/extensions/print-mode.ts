/**
 * Shared mode gates for interactive-only and ferment-mode-only tools.
 *
 *
 * `--print` / `-p` runs (headless benchmarks, scripted automations) have no
 * TUI, so TUI-only and ferment-mode-only tools are dead surface. Upstream
 * pi-mono owns `--print` parsing; this module is the bridge: `cli.ts` calls
 * `setPrintGate(hasPrintFlag(originalArgs), hasFermentOneshotArg(originalArgs))`
 * once at startup — same position and pattern as
 * `setExperimentalFeaturesEnabled` — and extensions read the composed gates
 * at their tool-registration seams.
 *
 * Two gates, deliberately distinct:
 * - `shouldSuppressInteractiveTools()` — TUI-only tools (questionnaire): dead
 *   in EVERY print run, ferment one-shot included (the one-shot judge answers
 *   via ask_user, never the TUI form).
 * - `shouldSuppressFermentModeTools()` — analytics/mode tools (set_phase,
 *   list_ferments + ferment suite): dead in plain print runs, but a
 *   `ferment-oneshot=true` run composes — that session IS a ferment planner
 *   (its toolset includes set_phase + scope_ferment), so suppression lifts.
 *
 * Scope: print mode only. `--mode acp|json|rpc` are protocol modes with real
 * clients (ACP needs ferment, so it is deliberately NOT covered) and
 * `--export` is orthogonal — neither is gated here.
 *
 * Module-level singleton by design — the flags are process-launch decisions,
 * not session state. Subagent (worker) sessions share the process, so they
 * inherit the same values: a headless `--print` run's workers are headless
 * too. For the agent-kwargs composition note: the argv scan in cli.ts is the
 * load-bearing composition; the
 * ferment extension additionally re-checks its own `ferment-oneshot` pi flag
 * at the registration seam so kwargs-driven worker sessions keep the suite.
 */
let printMode = false
let fermentOneshotRequested = false

export function setPrintGate(print: boolean, fermentOneshot: boolean): void {
	printMode = print
	fermentOneshotRequested = fermentOneshot
}

/** Raw `--print` / `-p` detection result. */
export function isPrintModeEnabled(): boolean {
	return printMode
}

/** True when the launch args carried a `ferment-oneshot` request. */
export function isFermentOneshotRequested(): boolean {
	return fermentOneshotRequested
}

/** Suppress TUI-only tools? (questionnaire) */
export function shouldSuppressInteractiveTools(): boolean {
	return printMode
}

/** Suppress ferment-mode tools? (set_phase, list_ferments, ferment suite) */
export function shouldSuppressFermentModeTools(): boolean {
	return printMode && !fermentOneshotRequested
}

/**
 * TEST-ONLY helper: run `fn` with the gate flags set, then restore the
 * previous values — even when `fn` throws. Prefer this over bare
 * `setPrintGate` in tests; a failed assertion mid-test otherwise leaks flag
 * state into the next test in the file (module-level singleton + vitest's
 * in-process module graph). Mirrors `withExperimentalFeatures`.
 */
export async function withPrintGate<T>(
	flags: { print: boolean; fermentOneshot?: boolean },
	fn: () => T | Promise<T>,
): Promise<T> {
	const previousPrint = printMode
	const previousOneshot = fermentOneshotRequested
	printMode = flags.print
	fermentOneshotRequested = flags.fermentOneshot ?? false
	try {
		return await fn()
	} finally {
		printMode = previousPrint
		fermentOneshotRequested = previousOneshot
	}
}
