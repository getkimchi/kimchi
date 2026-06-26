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
 *    before the snapshot takes effect.  When `isSnapshotAppliedThisTurn()` is
 *    `true` the cooperative call is silently dropped, preserving the snapshot.
 *    The flag resets at turn boundaries so the next turn starts fresh.
 *    The layering design is: snapshot is canonical, cooperative is a hint.
 *
 * The `snapshot-applied-this-turn` flag tracks whether `apply()` ran in the
 * current turn.  It is reset at turn boundaries (via `installTurnBoundaryReset`).
 * When the flag is set, the cooperative layer must not overwrite the snapshot.
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
import { getToolsForProfile } from "./tool-catalog.js"
import type { ToolProfile } from "./tool-catalog.js"

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/**
 * Set to `true` whenever `apply()` runs in the current turn.
 * Reset at turn boundaries (see `installTurnBoundaryReset`).
 *
 * This flag is the mechanism by which the snapshot layer outranks the
 * cooperative layer: after `apply()` runs, `applyCooperativeTweak()` callers
 * check this flag and become no-ops for the remainder of the turn.
 */
let snapshotAppliedThisTurn = false

/** Guards `installTurnBoundaryReset` so the `turn_start` listener is registered at most once. */
let turnListenerInstalled = false

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
export function applyCore(profile: ToolProfile, pi: ExtensionAPI): void {
	installTurnBoundaryReset(pi)
	const disabled = getDisabledToolNames(pi)

	let allowedNames: string[]
	if (profile === "idle") {
		// Idle = no active ferment, no plan mode. Restore the full registered
		// toolset minus ferment-only tools so users keep access to bash, edit,
		// write, third-party tools, etc. in normal chat.
		allowedNames = pi
			.getAllTools()
			.map((t) => t.name)
			.filter((name) => !isFermentOnlyToolName(name) && !disabled.has(name))
	} else if (profile === "implementation-ferment") {
		// Implementation phase: start from the full registered toolset so
		// MCP/custom/third-party tools are preserved, then merge in the
		// required ferment catalog tools defensively (they may not be
		// registered in the mock/test environment, but must always be present).
		const registeredNames = new Set(pi.getAllTools().map((t) => t.name))
		const catalogTools = getToolsForProfile(profile).map((t) => t.name)
		// Union: registered tools first (preserves order), then any catalog
		// tools not already present.
		const merged = [...registeredNames, ...catalogTools.filter((name) => !registeredNames.has(name))]
		allowedNames = merged.filter((name) => !disabled.has(name))
	} else {
		const tools = getToolsForProfile(profile)
		// Filter out tools that the cooperative visibility layer has voted to
		// hide.  Without this, a snapshot apply would re-surface tools that
		// another extension disabled (e.g. ask_user / confirm_ferment_completion_
		// criteria hidden when no UI is attached), undoing the cooperative vote.
		allowedNames = tools.map((t) => t.name).filter((name) => !disabled.has(name))
	}

	pi.setActiveTools(allowedNames)
	snapshotAppliedThisTurn = true
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
 * Returns `true` if `apply()` has already run in the current turn.
 * Used by the cooperative layer (`tweakTools` / `createToolVisibility`) to
 * detect that the snapshot has taken effect and must not be overwritten.
 *
 * The flag is reset at turn boundaries (see `installTurnBoundaryReset`).
 */
export function isSnapshotAppliedThisTurn(): boolean {
	return snapshotAppliedThisTurn
}

/**
 * Reset the snapshot-applied flag at turn boundaries.
 *
 * @internal — exported only for the `turn_start` wiring in
 *             `installTurnBoundaryReset`.
 */
export function resetSnapshotFlag(): void {
	snapshotAppliedThisTurn = false
}

/**
 * Reset ALL module-level state.
 *
 * Exported for test isolation: vitest re-evaluates the ESM module once per
 * VM context, so both `snapshotAppliedThisTurn` and `turnListenerInstalled`
 * must be reset between tests.
 *
 * @internal — test-only; not used in production code.
 */
export function resetAll(): void {
	snapshotAppliedThisTurn = false
	turnListenerInstalled = false
}

/**
 * Cooperative-layer no-op wrapper.
 *
 * Wraps `pi.setActiveTools()` with a guard: if the snapshot layer has already
 * been applied this turn (`isSnapshotAppliedThisTurn() === true`), the call is
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
	if (isSnapshotAppliedThisTurn()) {
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
 * Idempotent — the listener is installed at most once regardless of how many
 * times `apply()` is called.
 *
 * @param pi - The pi-mono `ExtensionAPI` instance.
 */
export function installTurnBoundaryReset(pi: ExtensionAPI): void {
	if (turnListenerInstalled) return

	pi.on("turn_start", () => resetSnapshotFlag())
	turnListenerInstalled = true
}
