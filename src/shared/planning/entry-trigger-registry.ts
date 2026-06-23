/**
 * # Entry Trigger Registry
 *
 * A single, dispatch-style registry for the entry points that bootstrap or
 * cycle the planning modes. Each entry trigger is a small function that
 * inspects an incoming `EntryEvent` and returns a `ModeState` describing what
 * the consumer should do — enter a mode, switch modes, no-op, or reject the
 * event as not-applicable.
 *
 * ## Why a registry at all?
 *
 * The two planning modes (adhoc `--plan`, ferment) currently detect their
 * entry conditions via scattered inline conditionals:
 *
 * | Entry trigger | Current call site |
 * |---|---|
 * | `--plan` CLI flag | parsed in `cli-args.ts`, applied in `permissions/index.ts` |
 * | `shift+tab` cycling | `permissions/index.ts:429` (terminal input listener) |
 * | `questionnaire` auto-promote | `permissions/index.ts:706` (tool-call hook) |
 * | `/ferment new` command | `extensions/ferment/commands.ts` (slash command) |
 * | `KIMCHI_ACTIVE_FERMENT=<id>` | `extensions/ferment/state.ts:32-35` (`getActiveFermentId`) |
 *
 * Scattered conditionals make it hard to see which triggers map to which
 * modes, and impossible to add a new trigger without editing every consumer.
 * This registry centralizes the trigger → mode mapping so that:
 *
 * - The mapping table is visible in one file.
 * - A new trigger only requires a new `EntryTrigger` registration.
 * - The dispatch order is deterministic (first non-`noop` trigger wins).
 *
 * ## Why a dispatch registry instead of a single function?
 *
 * Each entry trigger is owned by the extension that knows about it
 * (permissions owns `--plan`/`shift+tab`/`questionnaire`; ferment owns
 * `/ferment new`/`KIMCHI_ACTIVE_FERMENT`). The registry lets each extension
 * register its triggers at extension setup time without the others needing
 * to know about them. The dispatch loop invokes each registered trigger in
 * insertion order; the first one that returns a non-`noop` state wins.
 *
 * ## Consumer contract
 *
 * The registry does NOT mutate pi-mono session state directly. Each consumer
 * extension (permissions, ferment) calls `dispatch(event)` and applies the
 * returned `ModeState` via its existing state-mutation functions. This keeps
 * the registry session-agnostic — it holds pure data (triggers), no pi-mono
 * session references — which matches the Phase 4 out-of-scope note that
 * interfaces must be session-agnostic to accommodate the future ACP
 * multi-session event-bus redesign.
 *
 * ## Mode FSM ownership
 *
 * The registry does NOT own the mode FSMs (the plan-mode FSM in
 * `permissions/mode-controller.ts` and the ferment FSM in
 * `extensions/ferment/runtime.ts`). It only routes entry events to consumers;
 * the consumers own their respective FSMs and apply the resulting state.
 *
 * ## Test-only reset
 *
 * `clear()` is for tests only. Production code MUST NOT call it.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The two planning modes that this registry routes to. Same vocabulary as
 * `prompt-supplement-registry.ts` — the two are kept in sync intentionally
 * because entry routing and prompt supplements are both mode-aware.
 */
export type PlanningMode = "adhoc" | "ferment"

/**
 * The three possible states a consumer can be in, with respect to a
 * planning mode. `idle` means "no planning mode active" — neither `--plan`
 * nor a ferment is running.
 */
export type ActiveMode = PlanningMode | "idle"

/**
 * Discriminated union describing all entry events that the registry knows
 * how to route. Each variant carries the minimal data needed for triggers
 * to decide what to do.
 *
 * - `cli-flag` — a CLI flag at startup (e.g. `--plan=true` or
 *   `--ferment-oneshot=true`). Fired once during extension setup.
 * - `key-press` — a terminal input keypress (e.g. `shift+tab`). Fired by
 *   the permissions terminal input listener.
 * - `tool-call` — a tool invocation that implies a mode (e.g. `questionnaire`
 *   in default mode). Fired by the tool-call hook.
 * - `slash-command` — a slash command typed by the user (e.g.
 *   `/ferment new`). Fired by the slash-command handler.
 * - `env-var` — an environment variable at startup (e.g.
 *   `KIMCHI_ACTIVE_FERMENT=<id>`). Fired once during extension setup.
 */
export type EntryEvent =
	| { readonly kind: "cli-flag"; readonly name: string; readonly value: string | boolean }
	| { readonly kind: "key-press"; readonly key: string }
	| { readonly kind: "tool-call"; readonly toolName: string; readonly mode: ActiveMode }
	| { readonly kind: "slash-command"; readonly command: string; readonly args: string }
	| { readonly kind: "env-var"; readonly name: string; readonly value: string | undefined }

/**
 * The state the consumer should transition to in response to a trigger.
 *
 * - `enter-mode` — enter the named mode (only valid if no mode is active).
 * - `switch-mode` — switch from the current mode to the named mode.
 * - `noop` — the trigger doesn't apply; the registry continues to the next.
 * - `reject` — the trigger explicitly rejects the event (e.g. `--plan` while
 *   a ferment is active). The dispatch loop stops and returns `reject`.
 */
export type ModeState =
	| { readonly kind: "enter-mode"; readonly mode: PlanningMode; readonly reason: string }
	| { readonly kind: "switch-mode"; readonly mode: PlanningMode; readonly reason: string }
	| { readonly kind: "noop" }
	| { readonly kind: "reject"; readonly reason: string }

/**
 * A trigger function. Takes an `EntryEvent` and returns a `ModeState`.
 * Returns `noop` if the trigger doesn't apply to this event; returns
 * `reject` to short-circuit the dispatch loop with an explicit rejection.
 */
export type EntryTrigger = (event: EntryEvent) => ModeState

// ---------------------------------------------------------------------------
// Internal state
// ---------------------------------------------------------------------------

const triggers = new Map<string, EntryTrigger>()

/**
 * Register a trigger under a stable key. Re-registering the same key is
 * last-write-wins — useful for tests that swap triggers between cases.
 *
 * The key is opaque to the registry but should be human-readable for
 * debugging (`--plan-flag`, `shift-tab-cycle`, `questionnaire-auto-promote`,
 * `/ferment-new`, `KIMCHI_ACTIVE_FERMENT`).
 */
export function register(key: string, trigger: EntryTrigger): void {
	if (!key || typeof key !== "string") {
		throw new Error("entry-trigger-registry: key must be a non-empty string")
	}
	if (typeof trigger !== "function") {
		throw new Error(`entry-trigger-registry: trigger for '${key}' must be a function`)
	}
	triggers.set(key, trigger)
}

/**
 * Dispatch an event to every registered trigger in insertion order. The
 * first trigger that returns a non-`noop` state wins. If every trigger
 * returns `noop`, dispatch returns `{ kind: 'noop' }` itself.
 *
 * `reject` short-circuits: even if a later trigger would have accepted the
 * event, the rejection wins. This matches the existing inline behavior
 * (e.g. `--plan` while a ferment is active is silently dropped today).
 */
export function dispatch(event: EntryEvent): ModeState {
	for (const [key, trigger] of triggers) {
		const state = trigger(event)
		if (state.kind === "noop") continue
		// For debugging: state already carries a reason. We don't log here
		// to keep the registry a pure function — consumers log as needed.
		void key
		return state
	}
	return { kind: "noop" }
}

/**
 * Test-only reset that drops every registered trigger. Production code MUST
 * NOT call `clear()` — the registry is process-global state. Tests that
 * exercise `register()` should call `clear()` in their `afterEach` to avoid
 * leaking state between cases.
 */
export function clear(): void {
	triggers.clear()
}

/** Number of registered triggers. Diagnostic helper for tests. */
export function size(): number {
	return triggers.size
}

/** Whether a trigger is registered under the given key. Diagnostic helper. */
export function has(key: string): boolean {
	return triggers.has(key)
}
