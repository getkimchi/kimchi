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
 * Two profiles use `pi.getAllTools()` as their base rather than the fixed
 * catalog, so that MCP/custom/third-party tools registered by other
 * extensions are preserved:
 *
 * - `"idle"`: full registered toolset minus ferment-only tools. Restores the
 *   pre-unification behaviour where exiting a ferment returned the user to
 *   their normal chat toolset — including `bash`, `edit`, `write`, and any
 *   third-party tools.
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
	const disabled = getDisabledToolNames(pi)

	// Registry-derived profiles rebuild additively on resnapshot, mirroring
	// upstream's `_refreshToolRegistry` (previous active set + newly registered
	// tools): sampling `getAllTools()` alone can persist a partial registry
	// during an async registration wave. Only the resnapshot trigger unions;
	// a deliberate profile apply replaces. Filters (ferment-only, adhoc-only,
	// visibility votes) still win. Planning profiles never sample the registry.
	let allowedNames: string[]
	if (profile === "idle") {
		// Idle = no active ferment, no plan mode. Restore the full registered
		// toolset minus ferment-only tools so users keep access to bash, edit,
		// write, third-party tools, etc. in normal chat.
		const carriedNames = carryOverNames(trigger, pi)
		const registeredNames = pi.getAllTools().map((t) => t.name)
		allowedNames = [...new Set([...carriedNames, ...registeredNames])].filter(
			(name) => !isFermentOnlyToolName(name) && !disabled.has(name),
		)
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
	// re-surfaces tools (e.g. `write`) the user deactivated.
	allowedNames = allowedNames.filter((name) => isDefaultToolEnabled(name))

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
	snapshotAppliedByScope.set(getToolSessionScope(pi), true)
	lastProfileByScope.set(getToolSessionScope(pi), profile)
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
