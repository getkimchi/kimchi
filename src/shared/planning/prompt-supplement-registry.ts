/**
 * # Prompt Supplement Registry
 *
 * A single, mode-aware registry for `SystemPromptBlock` registrations shared
 * between the two planning modes (adhoc `--plan` and ferment). The registry
 * replaces the previous per-extension `createSystemPromptBlocks(...).register(...)`
 * calls with a single `register(key, block)` entry point and a `compose(mode)`
 * reader.
 *
 * ## Why a registry at all?
 *
 * Two extensions today register a "supplement" block against
 * `createSystemPromptBlocks`:
 *
 * 1. `permissions/index.ts` registers `plan-mode-supplement` (only rendered
 *    when the runtime permission mode is `plan`).
 * 2. `extensions/ferment/index.ts` registers `ferment-supplement` (only rendered
 *    while a ferment is active).
 *
 * Before the registry, the two registrations lived in disjoint code paths and
 * each gated rendering on its own mode predicate. The runtime then had to
 * iterate every registered block and let each one decide for itself whether to
 * emit content. That works, but it leaks the mode predicate into every block.
 *
 * The registry moves that decision up one level: at registration time a block
 * is associated with one or more planning modes; at read time `compose(mode)`
 * returns only the blocks relevant to the requested mode. Blocks can also
 * register as cross-mode (`['adhoc', 'ferment']`) when the same supplement is
 * useful in both contexts.
 *
 * ## API
 *
 * ```ts
 * type PlanningMode = 'adhoc' | 'ferment'
 *
 * interface PromptBlock {
 *   readonly id: string
 *   render(ctx: { mode: PlanningMode }): string | undefined
 *   suppress?(ctx: { mode: PlanningMode }): ReadonlySet<SuppressibleSection> | undefined
 * }
 *
 * function register(
 *   key: string,
 *   block: PromptBlock,
 *   options?: { modes?: readonly PlanningMode[] },
 * ): void
 *
 * function compose(mode: PlanningMode): readonly PromptBlock[]
 *
 * function clear(): void  // test-only reset; not for production callers
 * ```
 *
 * ### `register(key, block, options?)`
 *
 * Registers `block` under `key`. The `options.modes` array (default `['adhoc',
 * 'ferment']`) declares which planning modes the block participates in. A
 * re-registration with the same `key` replaces the previous entry (last-write
 * wins) — this matches the existing `SystemPromptBlocksHandle.register`
 * semantics.
 *
 * If a block is registered under both a mode-specific `key` and a more general
 * `key` for the same mode, both entries are returned by `compose()` and the
 * downstream renderer (`renderSystemPromptBlocks`) deduplicates by `id`.
 *
 * ### `compose(mode)`
 *
 * Returns the ordered list of blocks registered for the given mode. Order is
 * registration order (older blocks first); this preserves the visual layout
 * the extensions relied on before the registry existed. The returned array is
 * a snapshot — mutating it does not affect the registry state. Mutating an
 * individual block's `render`/`suppress` closures also does not affect the
 * registry; blocks should be treated as immutable after registration.
 *
 * ### `clear()`
 *
 * Test-only reset that drops every registered block. Production code MUST NOT
 * call `clear()` — the registry is process-global state. Tests that exercise
 * `register()` should call `clear()` in their `afterEach` to avoid leaking
 * state between cases.
 *
 * ## Consumer contract
 *
 * The registry does NOT call `createSystemPromptBlocks(...)` directly. Instead,
 * each consumer extension (permissions, ferment) constructs its blocks handle
 * once, then inside `render` calls `compose(mode)` to gather the relevant
 * blocks and emits them via its existing `blocks.register(...)` bridge. This
 * keeps the registry session-agnostic — it holds pure data (id + closures),
 * no pi-mono session references — which matches the Phase 4 out-of-scope
 * note that interfaces must be session-agnostic to accommodate the future
 * ACP multi-session event-bus redesign.
 *
 * For interactive ferment sessions the registry is populated by the
 * `extensions/ferment/index.ts` lifecycle wiring. For oneshot ferment sessions
 * the same registry is populated by the `extensions/ferment/oneshot.ts` path
 * (or whatever bootstrap populates the registry before the model sees the
 * first prompt) — both paths call `register()` with identical arguments, so
 * the registry contents are identical across interactive and oneshot.
 *
 * ## Migration status
 *
 * - `permissions/index.ts` will switch from `blocks.register({id: 'plan-mode-supplement',...})`
 *   to `register('plan-mode-supplement', block, {modes: ['adhoc']})` (Phase 4 step 2).
 * - `extensions/ferment/index.ts` will switch from `blocks.register({id: 'ferment-supplement',...})`
 *   to `register('ferment-supplement', block, {modes: ['ferment']})` (Phase 4 step 3).
 *
 * Until both migrations land, the registry coexists with the existing direct
 * registrations — calling both is safe (the downstream renderer dedupes by id).
 */

import type {
	SuppressibleSection,
	SystemPromptBlock,
} from "../../extensions/prompt-construction/system-prompt-blocks.js"

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The two planning modes that this registry discriminates between.
 *
 * - `adhoc` — the `--plan` permission mode. The model emits a plan, the user
 *   reviews it via the 3-option dropdown, and execution proceeds either as
 *   a normal session or (via START_AS_FERMENT) transitions into a ferment.
 * - `ferment` — the ferment lifecycle (interactive or oneshot). The model
 *   works through phases/steps with the ferment runtime supervising.
 */
export type PlanningMode = "adhoc" | "ferment"

/**
 * The block shape registered with this registry. The registry accepts the
 * upstream `SystemPromptBlock` shape verbatim — consumers can pass any
 * pi-mono-compatible block without a separate type. The narrower
 * `PromptBlockRenderContext` (planning-modes-only) is structurally a
 * supertype of the upstream `SystemPromptBlockContext`, so a block written
 * against the upstream `SystemPromptBlock` shape works here unchanged.
 *
 * `render()` may return `undefined` to indicate "no content for this mode" —
 * the registry passes this through unchanged. `suppress()` may return a set
 * of suppressible sections to hide in the rendered prompt.
 */
export type PromptBlock = SystemPromptBlock

/**
 * Re-export the `SuppressibleSection` taxonomy from the upstream
 * system-prompt-blocks module so registry consumers can type their `suppress`
 * return values without importing the upstream path directly.
 */
export type { SuppressibleSection }

/**
 * Render context passed to a block's `render`/`suppress` callbacks. The
 * `mode` field identifies which planning mode is currently active, so a
 * block can adapt its content even when registered for multiple modes.
 *
 * Structurally a supertype of the upstream `SystemPromptBlockContext`: the
 * upstream `mode` field is the broader `PromptMode = "orchestrator" |
 * "subagent" | "single"`, while this context narrows it to the two planning
 * modes the registry cares about. Blocks written against either context
 * type work in this registry.
 */
export interface PromptBlockRenderContext {
	readonly mode: PlanningMode
}

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

interface RegisteredBlock {
	readonly key: string
	readonly block: PromptBlock
	readonly modes: ReadonlySet<PlanningMode>
}

/**
 * Process-global registry. The map preserves insertion order so `compose()`
 * returns blocks in registration order (matches the existing per-extension
 * registration order, preserving the visual layout).
 */
const registry = new Map<string, RegisteredBlock>()

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register `block` under `key`. By default the block participates in both
 * planning modes; pass `options.modes` to restrict it.
 *
 * Re-registering the same `key` replaces the previous entry (last-write wins).
 */
export function register(key: string, block: PromptBlock, options?: { modes?: readonly PlanningMode[] }): void {
	const modes = new Set<PlanningMode>(options?.modes ?? (["adhoc", "ferment"] as const))
	for (const mode of modes) {
		if (mode !== "adhoc" && mode !== "ferment") {
			throw new Error(`prompt-supplement-registry: invalid mode '${mode}' for key '${key}'`)
		}
	}
	registry.set(key, { key, block, modes })
}

/**
 * Return the ordered list of blocks registered for the given planning mode.
 * The returned array is a fresh array snapshot — callers may iterate freely
 * without affecting registry state.
 */
export function compose(mode: PlanningMode): readonly PromptBlock[] {
	if (mode !== "adhoc" && mode !== "ferment") {
		throw new Error(`prompt-supplement-registry: invalid mode '${mode}'`)
	}
	const out: PromptBlock[] = []
	for (const entry of registry.values()) {
		if (entry.modes.has(mode)) {
			out.push(entry.block)
		}
	}
	return out
}

/**
 * Test-only reset. Drops every registered block. Production code MUST NOT
 * call this — the registry is process-global state.
 */
export function clear(): void {
	registry.clear()
}

/**
 * Diagnostic helper. Returns the number of registered entries. Useful for
 * tests that want to assert "registry is empty after clear" or "registry
 * grew by N after a register call" without depending on the internal Map.
 */
export function size(): number {
	return registry.size
}

/**
 * Diagnostic helper. Returns true if `key` is currently registered. Useful
 * for tests asserting that a particular consumer wired itself up.
 */
export function has(key: string): boolean {
	return registry.has(key)
}

// Re-export the upstream block type so consumers who want to accept *any*
// pi-mono-compatible block can do so without a second import. The shape is
// structurally compatible — `PromptBlock` is a narrower subtype of
// `SystemPromptBlock` (same fields, narrower `mode` type).
export type { SystemPromptBlock }
