/**
 * # Tool Profile Manager
 *
 * Centralises calls to `pi.setActiveTools()` that apply a full tool-profile
 * snapshot.  Two layers coexist in the tool-visibility system:
 *
 * 1. **Snapshot layer** (`apply()`) — calls `pi.setActiveTools()` with the
 *    complete tool list derived from the catalog for the given profile.
 *    This is the canonical pi-mono primitive for tool restriction.
 *    After `apply()` runs in a given turn, the cooperative layer becomes a
 *    no-op for that turn (the snapshot wins).  This prevents third-party
 *    extensions from accidentally undoing plan-mode restrictions — the
 *    rationale for the no-op behaviour is third-party extension safety.
 *
 * 2. **Cooperative layer** (`applyCooperativeTweak()`) — a vote-based
 *    mechanism that allows third-party extensions to narrow tool visibility
 *    before the snapshot takes effect.  When `isSnapshotAppliedThisTurn(pi)` is
 *    `true` the cooperative call is silently dropped, preserving the snapshot.
 *    The flag is tracked per session scope, so each session's own turn
 *    boundaries reset its flag and the next turn starts fresh.
 *    The layering design is: snapshot is canonical, cooperative is a hint.
 *
 * The `snapshot-applied-this-turn` flag tracks whether `apply()` ran in the
 * current turn, per session scope.  Each session's own turn boundaries reset
 * its flag (via `installTurnBoundaryReset`), so one session's deferred
 * resnapshot can never suppress another session's cooperative tweaks.
 *
 * ## Consumer contract
 *
 * All callers that need to set the full tool profile MUST go through `apply()`
 * rather than calling `pi.setActiveTools()` directly.  The two initial callers
 * are:
 * - `applyPlanModeTools` (`src/extensions/permissions/index.ts:279-298`)
 * - `FermentToolScope.applyProfile` (`src/extensions/ferment/tool-scope.ts:97-130`)
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"
import { BASH_CONTROL_TOOL_NAME } from "../../extensions/bash-background/bash-control-tool.js"
import { isFermentOnlyToolName } from "../../extensions/ferment/tool-names.js"
import { getDisabledToolNames } from "../../extensions/prompt-construction/tool-visibility.js"
import { isDefaultToolEnabled } from "../../settings-watcher.js"
import { getToolsForProfile, isAdhocOnlyToolName, type ToolProfile } from "./tool-catalog.js"
import { getToolSessionScope } from "./tool-session-scope.js"

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/**
 * Tracks, per session scope, whether `apply()` ran in that session's current
 * turn.  Each session's own turn boundaries reset its entry (see
 * `installTurnBoundaryReset`).
 *
 * This flag is the mechanism by which the snapshot layer outranks the
 * cooperative layer: after `apply()` runs, `applyCooperativeTweak()` callers
 * check this flag and become no-ops for the remainder of the turn. Per-session
 * scoping keeps a deferred resnapshot in one session from suppressing
 * another session's cooperative tweaks.
 */
let snapshotAppliedByScope = new WeakMap<object, boolean>()

/** Guards `installTurnBoundaryReset` so each pi registers its `turn_start` listener at most once. */
let turnListenersByPi = new WeakSet<object>()

/**
 * Tracks the last profile applied per session so extensions that register
 * tools asynchronously (e.g. mcp-adapter after its SSE/OAuth init completes)
 * can ask the profile manager to re-derive the active set without knowing
 * which profile is active. Reapplying ensures late adapter registration cannot
 * widen a restrictive profile while still surfacing those tools in profiles
 * that preserve the full registered toolset.
 */
let lastProfileByScope = new WeakMap<object, ToolProfile>()

/**
 * Providers of read-only-qualified tool names, registered per session scope.
 * Planning profiles union catalog tools with provider-supplied names so
 * read-only MCP direct tools stay visible while planning. Registration is
 * scoped exactly like `lastProfileByScope` — a provider registered under one
 * extension's pi never leaks into another session's snapshot (the DAP→ferment
 * cross-extension case).
 */
const readOnlyProvidersByScope = new WeakMap<object, Set<ReadOnlyToolProvider>>()

export type ReadOnlyToolProvider = () => readonly string[]

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register a provider of read-only-qualified tool names for this session.
 * Planning profiles admit the union of catalog tools and provider names.
 * Returns an unregister function. Provider errors must never break a
 * snapshot: a throwing provider is skipped.
 */
export function registerReadOnlyToolProvider(pi: ExtensionAPI, provider: ReadOnlyToolProvider): () => void {
	const scope = getToolSessionScope(pi)
	let providers = readOnlyProvidersByScope.get(scope)
	if (!providers) {
		providers = new Set()
		readOnlyProvidersByScope.set(scope, providers)
	}
	providers.add(provider)
	return () => providers?.delete(provider)
}

function collectReadOnlyProviderNames(pi: ExtensionAPI): string[] {
	const providers = readOnlyProvidersByScope.get(getToolSessionScope(pi))
	if (!providers || providers.size === 0) return []
	const names = new Set<string>()
	for (const provider of providers) {
		try {
			for (const name of provider()) names.add(name)
		} catch {
			// provider failure must not break the planning snapshot
		}
	}
	return [...names]
}

/** Use the same session-scoped qualification for visibility and permission checks. */
export function isProviderReadOnlyTool(pi: ExtensionAPI, name: string): boolean {
	return collectReadOnlyProviderNames(pi).includes(name)
}

/**
 * Per-scope restore state for the idle profile. `surfaceBaseline` is the
 * chat-surface the session should return to: captured at the first
 * restrictive (non-idle) profile apply, and normalized to the achieved
 * surface on every idle application. `lastApplied` is exactly what the
 * profile manager last wrote, so a deliberate idle can tell which names the
 * session actively gained or lost since then (upstream auto-activation of
 * late registrations, user/adapter toggles, visibility votes) and honor
 * them — a deactivation outlives every subsequent idle apply.
 */
let surfaceBaselineByScope = new WeakMap<object, string[]>()
let lastAppliedByScope = new WeakMap<object, string[]>()

/** What caused a tool-profile snapshot: a deliberate apply, or a deferred resnapshot. */
export type ProfileApplyTrigger = "apply" | "resnapshot"

/** Active tool names carried over — only on the resnapshot path; a deliberate apply replaces. */
function carryOverNames(trigger: ProfileApplyTrigger, pi: ExtensionAPI): string[] {
	return trigger === "resnapshot" ? pi.getActiveTools() : []
}

/** Whether KIMCHI_DEBUG_TOOL_SURFACE=1 requests active-set transition logging. */
function isToolSurfaceDebugEnabled(): boolean {
	return process.env.KIMCHI_DEBUG_TOOL_SURFACE === "1"
}

/** Log a tool-surface transition when KIMCHI_DEBUG_TOOL_SURFACE=1. The line is built lazily so gated-off runs pay nothing. */
export function debugToolSurface(line: () => string): void {
	if (!isToolSurfaceDebugEnabled()) return
	console.debug(line())
}

/**
 * Core logic for `apply()` — sets the active tool list from the catalog and
 * sets the snapshot-applied flag. Exported separately so `FermentToolScope`
 * can call the tool-setting logic without triggering the cooperative-layer
 * no-op guard in `applyCooperativeTweak()`.
 *
 * Two profiles sample `pi.getAllTools()` in addition to the fixed catalog:
 *
 * - `"idle"` does NOT use the registry as its base. Deliberate applies
 *   restore the captured pre-profile baseline plus names the session gained
 *   since the last snapshot, minus names it lost; resnapshots carry the live
 *   surface. Minus ferment-only tools. Registered is not active — extension
 *   tools such as `codemode` and `tool_search` register `defaultActive:
 *   false`, and an idle snapshot must not activate them merely because the
 *   profile manager ran. Exiting a ferment restores the surface the user had
 *   before the ferment, not the implementation-widened one.
 *
 * - `"implementation-ferment"`: full registered toolset plus the required
 *   ferment lifecycle tools added defensively (so they are always present
 *   even if not in `pi.getAllTools()`). Planning/scoping is constrained by
 *   the catalog; implementation is the phase where the agent needs the full
 *   execution surface including any extensions the user has installed.
 *
 * @internal — not for direct use outside the tool-profile and ferment layers.
 */
export function applyCore(profile: ToolProfile, pi: ExtensionAPI, trigger: ProfileApplyTrigger = "apply"): void {
	installTurnBoundaryReset(pi)
	const scope = getToolSessionScope(pi)
	const previousActive = [...new Set(pi.getActiveTools())]
	const disabled = getDisabledToolNames(pi)
	const lastApplied = lastAppliedByScope.get(scope) ?? []

	// Capture the pre-profile chat surface exactly once per scope, at the
	// session's first restrictive profile apply. Later idle restores re-derive
	// from it, so a widening profile (implementation's full-registry union)
	// can never reshape what chat returns to.
	if (trigger === "apply" && profile !== "idle" && !surfaceBaselineByScope.has(scope)) {
		surfaceBaselineByScope.set(scope, previousActive)
	}

	// Fold external activations into the baseline regardless of the profile
	// in force: a tool registered and auto-activated mid-restrictive-profile
	// (MCP server connecting during plan mode or a running ferment) is part
	// of the session's surface, not of the profile's widening, and must
	// survive the profile's exit. Only REGISTERED names fold — profile
	// utilities the manager itself applied are already in lastApplied, and
	// ephemeral admissions (planning read-only providers) are unregistered.
	const baseline = surfaceBaselineByScope.get(scope)
	if (baseline) {
		const registeredNames = new Set(pi.getAllTools().map((t) => t.name))
		const externallyActivated = previousActive.filter(
			(name) => registeredNames.has(name) && !lastApplied.includes(name) && !baseline.includes(name),
		)
		if (externallyActivated.length > 0) {
			surfaceBaselineByScope.set(scope, [...baseline, ...externallyActivated])
		}
	}

	// Registry-derived profiles rebuild additively on resnapshot, mirroring
	// upstream's `_refreshToolRegistry` (previous active set + newly registered
	// tools): sampling `getAllTools()` alone can persist a partial registry
	// during an async registration wave. Only the resnapshot trigger unions;
	// a deliberate profile apply replaces. Filters (ferment-only, adhoc-only,
	// visibility votes) still win. Planning profiles never sample the registry.
	let allowedNames: string[]
	if (profile === "idle") {
		// Idle = no active ferment, no plan mode. The restore surface is
		// baseline + admissions − removals, never the raw registry: registered
		// is not active, and extension tools like `codemode` / `tool_search`
		// register `defaultActive: false`, so a registry union would activate
		// them without any user opt-in. Minus ferment-only tools so exiting a
		// ferment never leaks its lifecycle surface.
		if (trigger === "resnapshot") {
			// Stale-registry guard: carry the mid-turn surface exactly, without
			// sampling the registry, so a mid-rebuild can't shrink it.
			allowedNames = previousActive.filter((name) => !isFermentOnlyToolName(name) && !disabled.has(name))
		} else {
			// Deliberate restore (exiting a profile or the per-turn idle
			// re-assert): baseline ∪ gained − lost, still registered, never
			// ferment-only, never vote-disabled. Ephemeral profile-admitted
			// names (planning read-only providers) are not registry entries and
			// leave with the profile that admitted them. Names the session lost
			// since the last snapshot stay lost — a user/adapter deactivation
			// outlives every idle apply. Two carve-outs: an empty previousActive
			// (pending-plan-review suppression wipes the surface on purpose)
			// carries no loss signal, and a restrictive profile whose apply
			// overwrote a deactivation during its lifetime is the profile's
			// documented widening, not a user toggle.
			const gained = previousActive.filter((n) => !lastApplied.includes(n))
			const lost =
				previousActive.length === 0
					? new Set<string>()
					: new Set(lastApplied.filter((n) => !previousActive.includes(n)))
			const registered = new Set(pi.getAllTools().map((t) => t.name))
			const restorable = [...new Set([...(surfaceBaselineByScope.get(scope) ?? previousActive), ...gained])]
			allowedNames = restorable.filter(
				(name) => !lost.has(name) && registered.has(name) && !isFermentOnlyToolName(name) && !disabled.has(name),
			)
		}
	} else if (profile === "implementation-ferment") {
		// Implementation phase: keep the previously active and full registered
		// toolset so MCP/custom/third-party tools are preserved, then merge in
		// the required ferment catalog tools defensively (they may not be
		// registered in the mock/test environment, but must always be present).
		// First-party adhoc-only tools (e.g. `questionnaire`) are excluded — the
		// ferment interactive-question surface is `ask_user`.
		const carriedNames = carryOverNames(trigger, pi)
		const registeredNames = pi.getAllTools().map((t) => t.name)
		const catalogTools = getToolsForProfile(profile).map((t) => t.name)
		allowedNames = [...new Set([...carriedNames, ...registeredNames, ...catalogTools])].filter(
			(name) => !isAdhocOnlyToolName(name) && !disabled.has(name),
		)
	} else {
		const tools = getToolsForProfile(profile)
		allowedNames = tools.map((t) => t.name)

		// Read-only MCP direct tools registered with a planning provider stay
		// visible while planning (see src/extensions/mcp/read-only.ts); the
		// gateway and all write-capable tools remain catalog-excluded.
		const catalogNames = new Set(allowedNames)
		for (const name of collectReadOnlyProviderNames(pi)) {
			if (!catalogNames.has(name)) allowedNames.push(name)
		}

		// Filter out tools that the cooperative visibility layer has voted to
		// hide.  Without this, a snapshot apply would re-surface tools that
		// another extension disabled (e.g. ask_user / confirm_ferment_completion_
		// criteria hidden when no UI is attached), undoing the cooperative vote.
		allowedNames = allowedNames.filter((name) => !disabled.has(name))
	}

	// The `defaultTools` setting (`-name` modifiers) deactivates builtins at
	// session construction (initialActiveToolNames); every snapshot must
	// respect it, otherwise unioning `pi.getAllTools()` or the catalog
	// re-surfaces tools (e.g. `write`) the user deactivated. `bash_control` is
	// not a separately-configured builtin — it exists to manage `bash`'s
	// background processes, so it is kept exactly when `bash` is kept: a
	// `defaultTools` list that does not name it (it never can — it is not a
	// builtin) cannot split the pair.
	allowedNames = allowedNames.filter(
		(name) =>
			isDefaultToolEnabled(name) ||
			(name === BASH_CONTROL_TOOL_NAME && allowedNames.includes("bash") && isDefaultToolEnabled("bash")),
	)

	debugToolSurface(() => {
		// Diff sampled only when logging is on, so gated-off runs pay nothing.
		const previous = new Set(pi.getActiveTools())
		const added = allowedNames.filter((name) => !previous.has(name))
		const removed = [...previous].filter((name) => !allowedNames.includes(name))
		return (
			`[tool-surface] apply profile=${profile} trigger=${trigger} count=${allowedNames.length}` +
			(added.length ? ` added=[${added.join(",")}]` : "") +
			(removed.length ? ` removed=[${removed.join(",")}]` : "")
		)
	})

	pi.setActiveTools(allowedNames)
	snapshotAppliedByScope.set(scope, true)
	lastProfileByScope.set(scope, profile)
	lastAppliedByScope.set(scope, allowedNames)
	if (profile === "idle") {
		// The achieved surface becomes the restore surface: names a widening
		// profile dragged in are forgotten here, and idle resnapshots fold
		// late admissions (e.g. freshly registered MCP tools) into it.
		surfaceBaselineByScope.set(scope, allowedNames)
	}
}

/**
 * Apply a full tool-profile snapshot via `pi.setActiveTools()`.
 *
 * @param profile - Which tool profile to activate (e.g. `"planning-adhoc"`,
 *                  `"implementation-ferment"`).
 * @param mode    - Execution mode: `"adhoc"` or `"ferment"`.  Passed here for
 *                  forward-compatibility, but currently has no runtime effect:
 *                  `getToolsForProfile` does not yet accept a `mode` argument,
 *                  and the catalog encodes mode into the profile name instead
 *                  (e.g. `"planning-adhoc"` vs `"planning-ferment"`).
 * @param pi      - The pi-mono `ExtensionAPI` instance.  Imported from the
 *                  same path as all other extensions:
 *                  `"@earendil-works/pi-coding-agent"`.
 */
export function apply(profile: ToolProfile, mode: "adhoc" | "ferment", pi: ExtensionAPI): void {
	// Deferred: `getToolsForProfile` currently accepts only `profile`.  Once
	// it grows a `mode` parameter, pass `mode` here to take advantage of it.
	void mode
	applyCore(profile, pi)
}

/**
 * Returns `true` if `apply()` has already run in the current turn for the
 * session `pi` belongs to. Used by the cooperative layer (`tweakTools` /
 * `createToolVisibility`) to detect that the snapshot has taken effect and
 * must not be overwritten.
 *
 * The flag is tracked per session scope and reset at that session's own turn
 * boundaries (see `installTurnBoundaryReset`).
 *
 * @param pi - The pi-mono `ExtensionAPI` instance whose session to check.
 */
export function isSnapshotAppliedThisTurn(pi: ExtensionAPI): boolean {
	return snapshotAppliedByScope.get(getToolSessionScope(pi)) === true
}

/**
 * Reset ALL module-level state.
 *
 * Exported for test isolation: vitest re-evaluates the ESM module once per
 * VM context, so the per-scope snapshot flag, the per-pi turn listeners, and
 * the per-scope profile memory must all be recreated between tests.
 *
 * @internal — test-only; not used in production code.
 */
export function resetAll(): void {
	snapshotAppliedByScope = new WeakMap()
	turnListenersByPi = new WeakSet()
	lastProfileByScope = new WeakMap()
	surfaceBaselineByScope = new WeakMap()
	lastAppliedByScope = new WeakMap()
}

/**
 * Cooperative-layer no-op wrapper.
 *
 * Wraps `pi.setActiveTools()` with a guard: if the snapshot layer has already
 * been applied this turn (`isSnapshotAppliedThisTurn(pi) === true`), the call is
 * silently dropped and `false` is returned.  This preserves plan-mode
 * restrictions — third-party extensions that call `applyCooperativeTweak()`
 * after the snapshot has taken effect cannot accidentally override it.
 * When the flag is not set, delegates to `pi.setActiveTools()` and returns
 * `true`.
 *
 * The flag resets at turn boundaries (see `installTurnBoundaryReset`), so
 * cooperative tweaks are honoured again in the next turn.
 *
 * @param pi    - The pi-mono `ExtensionAPI` instance.
 * @param tools - Tool names to pass to `pi.setActiveTools()`.  Accepts either
 *                an array of `{ name: string }` objects or a flat string array.
 * @returns `true` if the tweak was applied; `false` if dropped because the
 *          snapshot layer already ran this turn.
 */
export function applyCooperativeTweak(pi: ExtensionAPI, tools: Array<{ name: string }> | string[]): boolean {
	if (isSnapshotAppliedThisTurn(pi)) {
		return false
	}

	const isStringArray = Array.isArray(tools) && tools.length > 0 && typeof tools[0] === "string"
	const toolNames: string[] = isStringArray
		? (tools as string[])
		: (tools as Array<{ name: string }>).map((t) => t.name)
	pi.setActiveTools(toolNames)
	return true
}

/**
 * Register a `turn_start` listener that resets the snapshot-applied flag.
 * Per pi: each pi registers the listener at most once, so every session's
 * turn boundaries reset that session's flag (not just the first caller's).
 *
 * @param pi - The pi-mono `ExtensionAPI` instance.
 */
export function installTurnBoundaryReset(pi: ExtensionAPI): void {
	if (turnListenersByPi.has(pi)) return
	pi.on("turn_start", () => {
		snapshotAppliedByScope.delete(getToolSessionScope(pi))
	})
	turnListenersByPi.add(pi)
}

/**
 * Re-apply the last profile that was applied via `apply()`/`applyCore()`.
 *
 * Extensions that register tools asynchronously (notably mcp-adapter, whose
 * direct tools are registered after SSE/OAuth init completes) need a way to
 * surface those tools into the active set without calling `apply()` themselves
 * (they don't know which profile is active). This function re-runs `applyCore`
 * with the stored profile against the now-populated registered toolset.
 *
 * Safe to call at any time. Returns `false` (no-op) when no profile has been
 * applied yet for this session.
 *
 * @param pi - The pi-mono `ExtensionAPI` instance.
 * @returns `true` if the profile was re-applied; `false` if no profile was
 *          stored for this session.
 */
export function reapplyCurrentProfile(pi: ExtensionAPI): boolean {
	const profile = lastProfileByScope.get(getToolSessionScope(pi))
	if (!profile) return false
	applyCore(profile, pi, "resnapshot")
	return true
}

/** Return the active snapshot profile for extension-level policy checks. */
export function getCurrentProfile(pi: ExtensionAPI): ToolProfile | undefined {
	return lastProfileByScope.get(getToolSessionScope(pi))
}

/** Forget the recorded profile-snapshot state for this session's scope.
 *
 *  Used when a mode transition abandons the profile machinery in favor of a
 *  cooperative-vote restore — notably leaving plan mode, which re-enables the
 *  pre-plan surface via votes. Without this, the recorded profile stays stale
 *  ("planning-adhoc"), and any later `reapplyCurrentProfile` — the MCP
 *  adapter's keep-alive/tool-metadata resyncs fire within a minute — would
 *  re-impose the abandoned profile on the live session, stripping tools the
 *  restore just brought back. After a clear, those resyncs degrade to
 *  surface-preserving cooperative tweaks instead. */
export function clearCurrentProfile(pi: ExtensionAPI): void {
	const scope = getToolSessionScope(pi)
	lastProfileByScope.delete(scope)
	snapshotAppliedByScope.delete(scope)
}
