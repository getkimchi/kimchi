import { DefaultResourceLoader, type ResourceDiagnostic } from "@earendil-works/pi-coding-agent"
import { getParsedCliArgs } from "./cli-args.js"

/**
 * Startup diagnostics come in two flavours. A `collision` says two resources
 * shared a name and precedence already picked a winner — a valid resource
 * loaded, so there is nothing for the user to do. Everything else reports a
 * resource that is actually broken, e.g. a skill whose description exceeds the
 * 1024-character limit.
 *
 * Pi renders both unconditionally at startup (its `showDiagnosticsWhenQuiet`
 * bypasses the `quietStartup` setting), which buries the actionable reports
 * under collision noise. We drop only the collisions, and only when startup
 * is actually quiet: the `quietStartup` setting is on and the user has not
 * forced a verbose startup with `--verbose`.
 *
 * Because the filter mutates the stored diagnostics (there is no render-time
 * hook — see below), keeping this gate in sync with Pi's render condition
 * matters: users who disabled `quietStartup` opted into the full report and
 * must keep their collision diagnostics.
 */
function filterCollisionDiagnostics(
	diagnostics: readonly ResourceDiagnostic[],
	options: { verbose: boolean; quietStartup: boolean },
): ResourceDiagnostic[] {
	if (options.verbose || !options.quietStartup) return [...diagnostics]
	return diagnostics.filter((diagnostic) => diagnostic.type !== "collision")
}

/**
 * The loader methods that resolve a resource kind, paired with the field each
 * one writes its diagnostics to.
 */
const DIAGNOSTIC_SINKS = [
	["updateSkillsFromPaths", "skillDiagnostics"],
	["updatePromptsFromPaths", "promptDiagnostics"],
	["updateThemesFromPaths", "themeDiagnostics"],
] as const

/**
 * Drop non-actionable collision diagnostics from Pi's startup report when
 * startup is quiet (`quietStartup` on, no `--verbose`).
 *
 * Pi exposes `skillsOverride` / `promptsOverride` / `themesOverride` for
 * post-processing, but upstream `main()` builds the loader itself and accepts
 * only `extensionFactories`, so the interactive path cannot thread them.
 * Prototype accessors do not work because these hooks are class fields and
 * every instance gets an own property that shadows the prototype.
 *
 * We therefore wrap the methods that publish diagnostics and filter what they
 * stored. This runs after any caller-supplied `*Override`, so an explicit
 * override (e.g. ACP's) still applies first.
 *
 * This adapter intentionally depends on private upstream names and assumes the
 * update methods remain synchronous and keep assigning the fields listed
 * above. The co-located tests guard both assumptions when Pi is upgraded.
 */
export function installCollisionDiagnosticsPatch(): void {
	// biome-ignore lint/suspicious/noExplicitAny: private upstream prototype adapter
	const prototype = DefaultResourceLoader.prototype as any
	if (prototype.__kimchiCollisionDiagnosticsPatchApplied) return
	prototype.__kimchiCollisionDiagnosticsPatchApplied = true

	for (const [method, field] of DIAGNOSTIC_SINKS) {
		const original = prototype[method]
		if (typeof original !== "function") continue

		// biome-ignore lint/suspicious/noExplicitAny: private upstream prototype adapter
		prototype[method] = function patchedUpdate(this: any, ...args: unknown[]) {
			const result = original.apply(this, args)
			const verbose = getParsedCliArgs().options.verbose === true
			const quietStartup = this.settingsManager.getQuietStartup()
			this[field] = filterCollisionDiagnostics(this[field] ?? [], { verbose, quietStartup })
			return result
		}
	}
}
