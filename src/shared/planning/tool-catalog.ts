/**
 * # Unified Tool Catalog
 *
 * This module consolidates three previously inline tool catalogs:
 * - `PLAN_MODE_TOOLS` — {@link https://github.com/castai/kimchi-dev/blob/master/src/extensions/permissions/index.ts | src/extensions/permissions/index.ts:82–93}
 * - `PLANNING_TOOL_NAMES` — {@link https://github.com/castai/kimchi-dev/blob/master/src/extensions/ferment/tool-scope.ts | src/extensions/ferment/tool-scope.ts:18–48}
 * - `IMPLEMENTATION_TOOL_NAMES` — {@link https://github.com/castai/kimchi-dev/blob/master/src/extensions/ferment/tool-scope.ts | src/extensions/ferment/tool-scope.ts:50–84}
 *
 * ## Mode flavours
 *
 * The catalog uses two orthogonal axes:
 * - **Mode** (`'adhoc'` | `'ferment'`): controls which mode-specific tools are visible.
 * - **Profile** (`'idle'` | `'worker'` | `'planning-adhoc'` | `'planning-ferment'` |
 *   `'implementation-ferment'`): controls which phase / activation context applies.
 *
 * `modes: ['ferment']` on a tool means the tool is usable in BOTH interactive
 * ferment (TUI-driven) and oneshot ferment (judge-model-driven).  The runtime
 * differentiates routing — `ask_user` and `confirm_ferment_completion_criteria`
 * use interactive routing when a TUI is attached; the judge layer overrides to
 * non-interactive routing in the oneshot path (see
 * `src/extensions/ferment/ask-user.ts`).  The catalog records the default;
 * runtime wiring performs the override.
 *
 * ## `routing` field
 *
 * `routing?: 'interactive' | 'judge' | 'n/a'` on a `ToolEntry` encodes the
 * default routing for that tool in the flavour where it appears.
 * - `routing: 'interactive'` — model calls the tool; host executes it and
 *   streams results back through the TUI (or equivalent UI attachment).
 * - `routing: 'judge'` — model calls the tool; judge model evaluates the call
 *   and injects a synthetic result before the host sees it.
 * - `routing: 'n/a'` — tool does not use the cooperative visibility / routing
 *   layer (no default routing needed).
 *
 * The three tools annotated with `routing: 'interactive'` are:
 * - `questionnaire` (adhoc mode, planning phase)
 * - `ask_user` (ferment mode, planning phase)
 * - `confirm_ferment_completion_criteria` (ferment mode, planning phase)
 *
 * ## `phases` field
 *
 * `phases?: ('planning' | 'implementation')[]` on a ferment-mode `ToolEntry`
 * restricts visibility of the tool to a subset of the ferment lifecycle.
 * Omitting the field means the tool is available in both phases.
 *
 * ## Consumer contract
 *
 * This catalog is the **authoritative reference** for tool visibility.  Consumers
 * — `applyPlanModeTools` (permissions), `FermentToolScope.applyProfile`
 * (ferment) — MUST read from it via `getToolsForProfile(profile)` rather than
 * duplicating the set logic inline.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Discriminating label baked into the profile name (mode + phase). */
export type ToolProfile = "idle" | "worker" | "planning-adhoc" | "planning-ferment" | "implementation-ferment"

/** Which execution mode gates this tool's availability. */
export type ToolMode = "shared" | "adhoc" | "ferment"

/**
 * Cooperative routing layer target for this tool.
 * - `'interactive'`: TUI / UI attachment — model calls, host executes, result streams back.
 * - `'judge'`: judge model intercepts the call and injects a synthetic result.
 * - `'n/a'`: does not use the routing layer (no default routing applied).
 */
export type ToolRouting = "interactive" | "judge" | "n/a"

/**
 * Entry in the unified tool catalog.
 * `modes` is required; `phases` is optional and only meaningful for ferment-mode tools.
 */
export interface ToolEntry {
	/** Stable tool name as registered with the agent runtime. */
	name: string
	/** Modes in which this tool appears. `'shared'` means all modes. */
	modes: ToolMode[]
	/** Which ferment lifecycle phases this tool is active in. Ferment-mode tools only. */
	phases?: ("planning" | "implementation")[]
	/** Default routing target when this tool is available. Optional; omit to leave routing to the runtime. */
	routing?: ToolRouting
}

// ---------------------------------------------------------------------------
// Catalog arrays
// ---------------------------------------------------------------------------

/** Read-only discovery tools available in every mode. */
export const SHARED_CORE_TOOLS: ToolEntry[] = [
	{ name: "read", modes: ["shared"] },
	{ name: "grep", modes: ["shared"] },
	{ name: "find", modes: ["shared"] },
	{ name: "ls", modes: ["shared"] },
	{ name: "web_fetch", modes: ["shared"] },
	{ name: "web_search", modes: ["shared"] },
]

/** Tools gated behind `--plan` (adhoc planning mode). */
export const ADHOC_MODE_TOOLS: ToolEntry[] = [
	// interactive — model collects structured input from the user
	{ name: "questionnaire", modes: ["adhoc"], routing: "interactive" },
	// Todo lifecycle tools — must mirror TODO_TOOL_NAMES in src/extensions/todos/tool.ts
	{ name: "create_todos", modes: ["adhoc"] },
	{ name: "update_todos", modes: ["adhoc"] },
	{ name: "add_todo", modes: ["adhoc"] },
	{ name: "mark_todo", modes: ["adhoc"] },
	{ name: "clear_todos", modes: ["adhoc"] },
]

/**
 * Tools gated behind the ferment lifecycle.
 *
 * `phases: ['planning']` — only visible before the first phase is activated.
 * `phases: ['implementation']` — only visible after at least one phase is activated.
 * `phases` omitted — visible in both phases.
 *
 * `routing: 'interactive'` marks the two user-facing tools; the judge model
 * overrides this in the oneshot path via the cooperative visibility layer
 * (`src/extensions/ferment/ask-user.ts`).
 */
export const FERMENT_MODE_TOOLS: ToolEntry[] = [
	// -- planning phase (before any phase is activated) --

	// Phase tracker injected by the ferment planner supplement
	{ name: "set_phase", modes: ["ferment"], phases: ["planning"] },

	// Draft scoping surface
	{ name: "propose_ferment_scoping", modes: ["ferment"], phases: ["planning"] },
	{ name: "scope_ferment", modes: ["ferment"], phases: ["planning"] },
	{ name: "update_ferment_scope_field", modes: ["ferment"], phases: ["planning"] },

	// User-facing: TUI confirmation of completion criteria
	{
		name: "confirm_ferment_completion_criteria",
		modes: ["ferment"],
		phases: ["planning"],
		routing: "interactive",
	},

	// Always-both: discovery — visible in both phases and also in idle
	{ name: "list_ferments", modes: ["ferment"] },

	// User-facing: inline clarification question
	// Included in planning phase because the planner may need to ask the user
	// for clarification before activating.  Also available in implementation
	// (phases omitted) so the implementer can ask follow-up questions.
	{
		name: "ask_user",
		modes: ["ferment"],
		phases: ["planning", "implementation"],
		routing: "interactive",
	},

	// Fires the planning → implementation transition.
	// Listed in planning even though it activates a phase; without it the
	// planner has no way to signal "start implementing".
	{ name: "activate_ferment_phase", modes: ["ferment"], phases: ["planning"] },

	// -- implementation phase (after at least one phase is activated) --

	{ name: "refine_ferment_phase", modes: ["ferment"], phases: ["implementation"] },
	{ name: "complete_ferment_phase", modes: ["ferment"], phases: ["implementation"] },
	{ name: "skip_ferment_phase", modes: ["ferment"], phases: ["implementation"] },
	{ name: "fail_ferment_phase", modes: ["ferment"], phases: ["implementation"] },
	{ name: "start_ferment_step", modes: ["ferment"], phases: ["implementation"] },
	{ name: "complete_ferment_step", modes: ["ferment"], phases: ["implementation"] },
	{ name: "verify_ferment_step", modes: ["ferment"], phases: ["implementation"] },
	{ name: "skip_ferment_step", modes: ["ferment"], phases: ["implementation"] },
	{ name: "fail_ferment_step", modes: ["ferment"], phases: ["implementation"] },
	{ name: "add_ferment_decision", modes: ["ferment"], phases: ["implementation"] },
	{ name: "add_ferment_memory", modes: ["ferment"], phases: ["implementation"] },
	{ name: "complete_ferment", modes: ["ferment"], phases: ["implementation"] },
]

/**
 * Execution / write tools.
 * `bash` is shared between adhoc and ferment; the remaining tools are ferment-only.
 *
 * In `--plan` mode (`planning-adhoc`), `bash` is gated per-command by the
 * read-only gate at `permissions/index.ts:549–558` — not by the catalog.
 */
export const WRITE_TOOLS: ToolEntry[] = [
	// Shared: available in both adhoc and ferment.
	// In adhoc planning mode the runtime enforces read-only on a per-call basis.
	{ name: "bash", modes: ["adhoc", "ferment"] },
	// Ferment implementation only
	{ name: "edit", modes: ["ferment"] },
	{ name: "write", modes: ["ferment"] },
	{ name: "Agent", modes: ["ferment"] },
	{ name: "get_subagent_result", modes: ["ferment"] },
]

// ---------------------------------------------------------------------------
// Derivation
// ---------------------------------------------------------------------------

/**
 * Returns the tool entries active for the given profile.
 *
 * Profile encoding:
 * - `'idle'`                     → SHARED_CORE_TOOLS only (no write; no ferment tools)
 * - `'worker'`                   → [] (managed externally by the agents manager)
 * - `'planning-adhoc'`           → SHARED_CORE_TOOLS + ADHOC_MODE_TOOLS + bash
 * - `'planning-ferment'`         → SHARED_CORE_TOOLS + ferment tools visible in planning
 * - `'implementation-ferment'`   → SHARED_CORE_TOOLS + all ferment tools + all write tools
 *
 * TODO: Consider accepting a predicate/context (e.g.
 * `(entry: ToolEntry, ctx: { phase, routing, interactionMode }) => boolean`)
 * instead of only a static profile string. That would let the same tool be
 * available in interactive ferment but hidden in one-shot ferment without
 * forcing every case into static catalog buckets. For now, the combination
 * of static profiles + cooperative `disableToolName` (tool-visibility.ts)
 * handles the interactive vs. one-shot distinction adequately.
 */
export function getToolsForProfile(profile: ToolProfile): ToolEntry[] {
	switch (profile) {
		case "idle":
			return [...SHARED_CORE_TOOLS]

		case "worker":
			return []

		case "planning-adhoc":
			return [
				...SHARED_CORE_TOOLS,
				...ADHOC_MODE_TOOLS,
				// bash is the only write tool in adhoc planning mode
				...WRITE_TOOLS.filter((t) => t.modes.includes("adhoc")),
			]

		case "planning-ferment": {
			const ferment = FERMENT_MODE_TOOLS.filter((t) => t.phases === undefined || t.phases.includes("planning"))
			return [...SHARED_CORE_TOOLS, ...ferment]
		}

		case "implementation-ferment":
			return [
				...SHARED_CORE_TOOLS,
				...FERMENT_MODE_TOOLS,
				// All write tools in ferment implementation mode
				...WRITE_TOOLS.filter((t) => t.modes.includes("ferment")),
			]
	}
}
