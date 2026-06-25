import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent"
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui"
import { RST_FG, resolvedSemanticFg } from "../../ansi.js"
import { FermentEventStore } from "../../ferment/event-store.js"
import { resolveFermentsDir } from "../../ferment/store.js"
import { getAcpPrompter } from "../../modes/acp/permission-prompter-registry.js"
import * as EntryTriggerRegistry from "../../shared/planning/entry-trigger-registry.js"
import { parseSharedPlan } from "../../shared/planning/plan-decomposition.js"
import {
	PLAN_MODE_STOP_NUDGE,
	contentHasToolCall,
	extractTextFromContent,
	hasPlanCompletionSignal,
	isNudgeSuppressed,
	shouldNudge,
} from "../../shared/planning/planning-stop-nudge.js"
import * as PromptSupplementRegistry from "../../shared/planning/prompt-supplement-registry.js"
import * as ToolProfileManager from "../../shared/planning/tool-profile-manager.js"
import { isAgentWorker } from "../agent-worker-context.js"
import { PARENT_SESSION_ID_ENV_KEY } from "../agents/manager/constants.js"
import { emitFermentCreated } from "../ferment/domain-events-emitter.js"
import { appendRefEntry } from "../ferment/nudge.js"
import { defaultFermentRuntime } from "../ferment/runtime.js"
import { hasActiveFerment, notifyFermentActive, onActiveFermentChange } from "../ferment/state.js"
import { createApplyAndPersist } from "../ferment/tool-helpers.js"
import { isFermentToolName, isUserFacingFermentToolName } from "../ferment/tool-names.js"
import { setActiveFermentAndApplyProfile } from "../ferment/tool-scope.js"
import { createSystemPromptBlocks } from "../prompt-construction/index.js"
import type { SystemPromptBlock } from "../prompt-construction/system-prompt-blocks.js"
import { type ToolVisibilityAPI, createToolVisibility } from "../prompt-construction/tool-visibility.js"
import { isRawInputCaptureActive } from "../shared-input.js"
import { TODO_TOOL_NAMES } from "../todos/tool.js"
import { resolveClassifierModels } from "./classifier-model.js"
import { classifyToolCall } from "./classifier.js"
import { registerCommands } from "./commands.js"
import { type LoadedConfig, loadConfig } from "./config.js"
import { PERMISSIONS_ENV_KEY } from "./constants.js"
import { getSessionPermissionFlagController } from "./mode-controller-registry.js"
import { getPermissionMode, getSessionPermissionsEnvKey, setPermissionMode } from "./mode-controller.js"
import { resolveMode } from "./mode.js"
import { saveApprovedPlan } from "./plan-persistence.js"
import type { ToolPermissionPrompter } from "./prompter.js"
import {
	type CompoundSubcommand,
	buildPermissionChoices,
	promptForCompoundApproval,
	terminalPrompter,
	withWorkingHidden,
} from "./prompts.js"
import planModeSupplement from "./prompts/plan-mode-supplement.js"
import { evaluateRules, parseRules, stringifyRule } from "./rules.js"
import { SessionMemory } from "./session-memory.js"
import {
	isCompoundCommand,
	isHardBlockedBash,
	isReadOnlyBashCommand,
	isReadOnlyTool,
	splitCompoundCommand,
} from "./taxonomy.js"
import {
	BUILTIN_DENY,
	DEFAULT_CONFIG,
	type PermissionMode,
	type PermissionModeRuntimeSource,
	type Rule,
} from "./types.js"

/**
 * Check whether a file path is within .kimchi/plans/ relative to cwd.
 * Accepts both relative paths (starting with .kimchi/plans/) and
 * absolute paths under <cwd>/.kimchi/plans/.
 * Path traversal is prevented by resolving to an absolute path first.
 */
export function isWithinKimchiPlans(filePath: string, cwd: string): boolean {
	const normalizedCwd = cwd.endsWith("/") ? cwd : `${cwd}/`
	const plansDir = `${normalizedCwd}.kimchi/plans/`

	// Resolve to absolute, normalizing any ".." components
	const abs = resolve(cwd, filePath)
	return abs.startsWith(plansDir)
}

/**
 * DANGER: Bypass flag that disables ALL permission checks.
 * WARNING: This skips denylist, rules, classifier, and prompts.
 * For throwaway/sandboxed environments ONLY.
 */
const DANGEROUS_BYPASS_FLAG = "dangerously-skip-permissions"

type RuntimeModeSource = "user" | "ferment"

// Safe default so any event that fires before session_start (and therefore
// before doLoadConfig) doesn't crash reading `loaded.config.*`.
const EMPTY_LOADED_CONFIG: LoadedConfig = {
	config: DEFAULT_CONFIG,
	allowBySource: { user: [], project: [], local: [], cli: [] },
	denyBySource: { user: [], project: [], local: [], cli: [] },
	paths: {},
}

// bash is allowed but gated per-command by isReadOnlyBashCommand.
const PLAN_MODE_TOOLS = [
	"read",
	"grep",
	"find",
	"ls",
	"web_search",
	"web_fetch",
	"questionnaire",
	"bash",
	...TODO_TOOL_NAMES,
]
const PLAN_MODE_TOOL_SET = new Set<string>(PLAN_MODE_TOOLS)

// Tools that auto-approve in headless/auto modes without LLM classification.
// `set_phase` is a kimchi built-in. `agent`/`get_subagent_result`/`steer_subagent`
// are the agents-extension surface — `agent` is the canonical delegation tool,
// the other two are read-only/control-plane operations on already-approved spawns.
//
// Names are lowercased because the tool_call handler lowercases event.toolName
// before comparing (see `const toolName = event.toolName.toLowerCase()` below).
const BUILTIN_ALLOW_TOOL_NAMES = ["set_phase", "agent", "get_subagent_result", "steer_subagent", ...TODO_TOOL_NAMES]

const MODES: Array<{
	mode: PermissionMode
	label: string
	color: "success" | "warning" | "error"
}> = [
	{ mode: "default", label: "default", color: "success" },
	{ mode: "plan", label: "plan", color: "warning" },
	{ mode: "auto", label: "auto", color: "warning" },
	{ mode: "yolo", label: "yolo", color: "error" },
]

let _isLaunchedWithYolo: () => boolean = () => process.env[PERMISSIONS_ENV_KEY] === "yolo"

export function isLaunchedWithYolo(): boolean {
	return _isLaunchedWithYolo()
}

let _displayPermissionMode: PermissionMode

/** Returns current permission mode to be displayed in the TUI. */
export function getDisplayPermissionMode(): string {
	return _displayPermissionMode
}

export { notifyFermentActive }

function canPrompt(ctx: ExtensionContext): boolean {
	if (isAgentWorker()) return false

	const acpPrompter = getAcpPrompter(ctx.sessionManager.getSessionId())
	if (ctx.mode === "rpc" && acpPrompter) return true

	if (ctx.hasUI) return true
	return false
}

function resolvePrompter(ctx: ExtensionContext): ToolPermissionPrompter | undefined {
	if (isAgentWorker()) return undefined

	const acpPrompter = getAcpPrompter(ctx.sessionManager.getSessionId())
	if (ctx.mode === "rpc" && acpPrompter) return acpPrompter

	if (ctx.hasUI) return terminalPrompter(ctx)
	return undefined
}

export default function permissionsExtension(pi: ExtensionAPI): void {
	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration).",
		type: "boolean",
		default: false,
	})
	pi.registerFlag("yolo", {
		description: "Alias for --auto. Start in autonomous mode (YOLO with classifier).",
		type: "boolean",
		default: false,
	})
	pi.registerFlag("auto", {
		description: "Start in autonomous mode (YOLO with classifier).",
		type: "boolean",
		default: false,
	})
	pi.registerFlag(DANGEROUS_BYPASS_FLAG, {
		description:
			"DANGER: Skip ALL permission checks including denylist (sudo, .env writes), rules, classifier, and prompts. Intended for throwaway/sandbox environments only.",
		type: "boolean",
		default: false,
	})
	pi.registerFlag("permissions-config", {
		description: "Path to a permissions.json file that replaces user/project configs.",
		type: "string",
	})
	pi.registerFlag("allow-tool", {
		description: "Add a session allow rule (may repeat via comma-separated list).",
		type: "string",
	})
	pi.registerFlag("deny-tool", {
		description: "Add a session deny rule (may repeat via comma-separated list).",
		type: "string",
	})

	const session = new SessionMemory()
	const builtinRules: Rule[] = parseRules(BUILTIN_DENY, "deny", "builtin")
	// When a subagent is spawned, the parent stores its per-session mode under
	// KIMCHI_PERMISSIONS_<sessionId> and advertises the session ID via
	// KIMCHI_PARENT_SESSION_ID. If this variable is absent, we fall back to the
	// base key.
	const permissionsEnvFlag = process.env[PARENT_SESSION_ID_ENV_KEY]
		? process.env[getSessionPermissionsEnvKey(process.env[PARENT_SESSION_ID_ENV_KEY])]
		: process.env[PERMISSIONS_ENV_KEY]
	let loaded: LoadedConfig = EMPTY_LOADED_CONFIG
	let configRules: Rule[] = []
	let currentCtx: ExtensionContext | undefined
	let preFermentMode: PermissionMode | undefined
	let cliMode: PermissionMode | undefined
	let planModeApplied = false
	let planModeHiddenTools: string[] = []
	const planToolVisibility: ToolVisibilityAPI = createToolVisibility(pi)
	/** Tracks all active permission prompt abort controllers for concurrent tool calls. */
	const activeAbortControllers = new Set<AbortController>()
	let unsubscribeTerminalInput: (() => void) | null = null
	let unsubscribePermissionFlagController: (() => void) | undefined

	// Plan completion menu state: tracks whether the agent used tools during the
	// current user-input cycle so we can detect text-only turns (plan output).

	function rebuildConfigRules(): void {
		configRules = [
			...parseRules(loaded.allowBySource.local, "allow", "local"),
			...parseRules(loaded.allowBySource.project, "allow", "project"),
			...parseRules(loaded.allowBySource.user, "allow", "user"),
			...parseRules(loaded.denyBySource.local, "deny", "local"),
			...parseRules(loaded.denyBySource.project, "deny", "project"),
			...parseRules(loaded.denyBySource.user, "deny", "user"),
		]
	}

	_isLaunchedWithYolo = () => {
		const runtimeMode = currentCtx && getPermissionMode(currentCtx.sessionManager.getSessionId())
		if (runtimeMode?.mode === "yolo" && runtimeMode.source === "user") {
			return true
		}
		return (
			resolveMode({
				flag: cliMode,
				env: permissionsEnvFlag,
				config: loaded.config.defaultMode,
			}).mode === "yolo"
		)
	}

	/**
	 * Returns the current permission mode flag or falls back to a user default.
	 */
	function getRuntimePermissionMode(): { mode: PermissionMode; source: PermissionModeRuntimeSource } {
		const runtimeMode = currentCtx && getPermissionMode(currentCtx.sessionManager.getSessionId())
		if (runtimeMode) {
			return runtimeMode
		}
		return {
			mode: resolveMode({
				flag: cliMode,
				env: permissionsEnvFlag,
				config: loaded.config.defaultMode,
			}).mode,
			source: "user",
		}
	}

	/**
	 * Set current permission mode, keeps the controller in sync, and
	 * persists the env key for sub-agents.
	 */
	function setRuntimePermissionMode(
		ctx: ExtensionContext,
		mode: PermissionMode,
		source: PermissionModeRuntimeSource,
		skipNotify?: boolean,
	): void {
		_displayPermissionMode = mode
		setPermissionMode(ctx.sessionManager.getSessionId(), mode, source, skipNotify)
	}

	function allRules(): Rule[] {
		return [...session.all(), ...configRules, ...builtinRules]
	}

	function isPlanModeTool(name: string): boolean {
		return PLAN_MODE_TOOL_SET.has(name) || isReadOnlyTool(name)
	}

	function applyPlanModeTools(): void {
		if (planModeApplied) return
		try {
			// Track which tools plan mode is removing so `restoreToolsFromPlanMode`
			// can re-enable them. Without this snapshot, restore would be a no-op
			// because `ToolProfileManager.apply` (via `pi.setActiveTools`) does
			// not preserve the prior active-tool set.
			planModeHiddenTools = pi.getActiveTools().filter((name) => !isPlanModeTool(name))
			// Register the disable vote with the cooperative visibility layer so
			// `restoreToolsFromPlanMode`'s `planToolVisibility.enable(...)` call
			// matches the matching disable vote (and so the snapshot below does
			// not re-surface these tools when `getDisabledToolNames` is read by
			// other extensions' `setActiveTools` calls).
			planToolVisibility.disable(planModeHiddenTools)
			ToolProfileManager.apply("planning-adhoc", "adhoc", pi)
			planModeApplied = true
		} catch {
			// Tool visibility may be unavailable; tool_call handler still enforces the policy.
		}
	}

	function restoreToolsFromPlanMode(): void {
		if (!planModeApplied) return
		try {
			planToolVisibility.enable(planModeHiddenTools)
		} catch {
			// best-effort restore
		}
		planModeHiddenTools = []
		planModeApplied = false
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return
		const { mode } = getRuntimePermissionMode()
		const active = MODES.find((m) => m.mode === mode) ?? MODES[0]
		const name = `${resolvedSemanticFg(ctx.ui.theme, active.color)}${active.label}${RST_FG}`
		const hint = ctx.ui.theme.fg("dim", "→ shift+tab")
		ctx.ui.setStatus("permissions-mode", `${name} ${hint}`)
	}

	function maybeShowYoloWarning(ctx: ExtensionContext) {
		if (!ctx.hasUI) return
		const { mode, source } = getRuntimePermissionMode()
		if (mode === "yolo" && source === "user") {
			ctx.ui.setStatus(
				"permissions-warning",
				"WARNING: all permission checks disabled. Recommended for sandbox environments only.",
			)
		} else {
			ctx.ui.setStatus("permissions-warning", undefined)
		}
	}

	function changeMode(
		ctx: ExtensionContext,
		current: PermissionMode,
		next: PermissionMode,
		source: PermissionModeRuntimeSource,
		skipNotify?: boolean,
	): void {
		setRuntimePermissionMode(ctx, next, source, skipNotify)
		if (current === "plan" && next !== "plan") restoreToolsFromPlanMode()
		if (next === "plan") applyPlanModeTools()
		// Dismiss all active permission prompts so tool_call handlers re-evaluate under the new mode.
		for (const ctrl of activeAbortControllers) ctrl.abort()
		activeAbortControllers.clear()
		updateStatus(ctx)
		maybeShowYoloWarning(ctx)
	}

	function cycleMode(ctx: ExtensionContext): void {
		const { mode: current } = getRuntimePermissionMode()
		const idx = MODES.findIndex((m) => m.mode === current)
		const next = MODES[(idx + 1) % MODES.length].mode
		changeMode(ctx, current, next, "user")
	}

	// Ferment calls notifyFermentActive() when a ferment is activated or cleared,
	// so permissions can switch to/from yolo.
	//
	// FIXME: ferment isn't tracked per session ID, so we assume that active
	// ferment change applies to the current session. This is fine for CLI usage,
	// but incorrect for ACP use where a single process may have multiple sessions (and therefore ferments)
	// running at the same time. Fix this when introducing ferment commands to ACP.
	onActiveFermentChange((hasActive) => {
		if (cliMode) return // explicit CLI flag always wins
		if (!currentCtx) return // No active session
		let { mode: current, source } = getRuntimePermissionMode()
		let next = current
		if (hasActive) {
			if (source === "user") preFermentMode = current
			next = "yolo"
			source = "ferment"
		} else if (preFermentMode) {
			// Clear mode that was set for ferment (not if user changed it manually)
			next = preFermentMode
			preFermentMode = undefined
			source = "user"
		}
		if (next && next !== current) {
			changeMode(currentCtx, current, next, source)
		}
	})

	function doLoadConfig(ctx: ExtensionContext): { errors: string[] } {
		const { loaded: lc, errors } = loadConfig({
			cwd: ctx.cwd,
			cliConfigPath: pi.getFlag("permissions-config") as string | undefined,
			cliAllow: splitFlag(pi.getFlag("allow-tool")),
			cliDeny: splitFlag(pi.getFlag("deny-tool")),
		})
		loaded = lc
		rebuildConfigRules()
		return { errors }
	}

	function executePlan(planPath: string | undefined, planText: string): void {
		// Send the approved plan as the execution trigger. No compaction needed —
		// the plan text is already in context from the planning conversation.
		const planRef = planPath ? `\n\nApproved plan saved to: ${planPath}` : ""
		pi.sendMessage(
			{
				customType: "plan-execute",
				content: `The user approved the plan. Execute it now.${planRef}\n\n---\n\n${planText}`,
				display: false,
			},
			{ triggerTurn: true },
		)
	}

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx
		const { errors } = doLoadConfig(ctx)

		for (const err of errors) {
			if (ctx.hasUI) ctx.ui.notify(`permissions: ${err}`, "warning")
			else console.error(`permissions: ${err}`)
		}

		// Register a global terminal input listener so that the shift+tab shortcut
		// works even when a permission prompt (ExtensionSelectorComponent) has focus.
		if (unsubscribeTerminalInput) unsubscribeTerminalInput()
		if (ctx.hasUI) {
			unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => {
				if (matchesKey(data, "shift+tab")) {
					// Defer to a foreground UI that is forwarding raw terminal input
					// (e.g. the teleport overlay), so its consumer sees Shift+Tab.
					if (isRawInputCaptureActive()) return undefined
					// Kitty keyboard protocol sends both press and release events;
					// ignore the release to avoid cycling the mode twice per keystroke.
					if (!isKeyRelease(data)) {
						cycleMode(ctx)
					}
					return { consume: true }
				}
				return undefined
			})
		}

		// CLI-flag rules live in session memory so /permissions list shows them.
		session.addMany(parseRules(loaded.allowBySource.cli, "allow", "cli"))
		session.addMany(parseRules(loaded.denyBySource.cli, "deny", "cli"))

		if (pi.getFlag("plan")) cliMode = "plan"
		else if (pi.getFlag("auto")) cliMode = "auto"
		// YOLO mode: --yolo and --dangerously-skip-permissions both set yolo mode (no classifier, auto-approve all)
		else if (pi.getFlag("yolo") || pi.getFlag("dangerously-skip-permissions")) cliMode = "yolo"

		let { mode: current, source } = getRuntimePermissionMode()
		let next = current
		// Active ferment → auto-yolo so scoping/lifecycle work can proceed without approval prompts.
		// Permission mode is persisted after the user explicitly approves ferment creation.
		// Only applies when no explicit CLI mode flag was given.
		if (!cliMode && hasActiveFerment()) {
			if (source === "user") preFermentMode = current
			next = "yolo"
			source = "ferment"
		}

		changeMode(ctx, current, next, source)

		const sessionId = currentCtx.sessionManager.getSessionId()
		unsubscribePermissionFlagController = getSessionPermissionFlagController(sessionId)?.subscribe(({ mode: next }) => {
			if (!next) return

			const current = getRuntimePermissionMode()
			if (current.mode === next.mode) return

			// ACP already emitted the config update from controller.setMode().
			// This call is only for local transition side effects.
			changeMode(ctx, current.mode, next.mode, next.source, true)
		})
	})

	pi.on("session_shutdown", () => {
		unsubscribePermissionFlagController?.()
		unsubscribePermissionFlagController = undefined
		currentCtx = undefined
	})

	const blocks = createSystemPromptBlocks(pi, "permissions")
	// Register the plan-mode prompt supplement via the shared registry so that
	// future readers (`compose('adhoc')` from the renderer) can find it without
	// having to walk every extension's blocks handle. The blocks handle is kept
	// alive (it still owns the `pi` binding for session-shutdown cleanup); the
	// registry entry below is the canonical lookup path.
	const planModeSupplementBlock: SystemPromptBlock = {
		id: "plan-mode-supplement",
		render: () => {
			if (getRuntimePermissionMode().mode !== "plan") return undefined
			return planModeSupplement.trim()
		},
	}
	PromptSupplementRegistry.register("plan-mode-supplement", planModeSupplementBlock, {
		modes: ["adhoc"],
	})
	blocks.register(planModeSupplementBlock)

	// ─── Entry triggers (planning mode routing) ───────────────────────────
	// The actual mode-mutating logic lives in the inline handlers below; the
	// registry entries make the routing table explicit and discoverable.
	EntryTriggerRegistry.register("--plan-flag", (event) => {
		if (event.kind !== "cli-flag") return { kind: "noop" }
		if (event.name !== "--plan") return { kind: "noop" }
		return { kind: "enter-mode", mode: "adhoc", reason: "CLI --plan flag" }
	})
	EntryTriggerRegistry.register("shift-tab-cycle", (event) => {
		if (event.kind !== "key-press") return { kind: "noop" }
		if (event.key !== "shift+tab") return { kind: "noop" }
		// Cycling semantics: caller picks next mode from runtime state.
		return { kind: "switch-mode", mode: "adhoc", reason: "shift+tab cycle (caller picks next)" }
	})
	EntryTriggerRegistry.register("questionnaire-auto-promote", (event) => {
		if (event.kind !== "tool-call") return { kind: "noop" }
		if (event.toolName !== "questionnaire") return { kind: "noop" }
		if (event.mode !== "idle") return { kind: "noop" }
		return { kind: "enter-mode", mode: "adhoc", reason: "questionnaire tool call in default mode" }
	})

	// When the agent produces <!-- PLAN_COMPLETE --> in plan mode, show the approval menu.
	pi.on("turn_end", async (event, ctx) => {
		if (getRuntimePermissionMode().mode !== "plan") return
		if (!ctx.hasUI) return

		const message = event.message
		if (message.role !== "assistant") return

		const text = message.content
			.filter((c) => c.type === "text")
			.map((c) => (c as { type: "text"; text: string }).text)
			.join("\n")

		if (!text.includes("<!-- PLAN_COMPLETE -->") && !text.includes("<done>")) return

		// Oneshot sessions bypass the dropdown entirely — the bench path auto-pilots
		// the rest of the lifecycle through scope_ferment and friends, no user prompt needed.
		if (pi.getFlag?.("ferment-oneshot") === true) return

		const EXECUTE = "Execute the plan"
		const DECLINE = "Rework the plan"
		const START_AS_FERMENT = "Start as ferment"

		const choice = await withWorkingHidden(ctx, () =>
			ctx.ui.select("Plan complete. How would you like to proceed?", [EXECUTE, DECLINE, START_AS_FERMENT]),
		)

		if (choice === EXECUTE) {
			let planPath: string | undefined
			try {
				planPath = saveApprovedPlan(ctx.cwd, text)
			} catch {
				// Non-fatal: plan persistence is best-effort.
			}
			changeMode(ctx, "plan", "auto", "user")
			executePlan(planPath, text)
		} else if (choice === START_AS_FERMENT) {
			// ── Tool-swap contract ────────────────────────────────────────────────
			// This is a SNAPSHOT SWAP that takes effect at the next turn boundary —
			// there is no explicit handoff message and no model-visible notification.
			// `ToolProfileManager.apply("implementation-ferment", "ferment", pi)`
			// calls `pi.setActiveTools(...)` with the catalog-derived set for that
			// profile (see `src/shared/planning/tool-catalog.ts`). The model sees the
			// swap on its next invocation; nothing is queued or deferred.
			//
			// Tools REMOVED (adhoc / planning-only, no longer visible):
			//   - questionnaire          (adhoc-only; superseded by ask_user)
			//   - update_todos           (adhoc-only)
			//   - add_todo               (adhoc-only)
			//   - mark_todo              (adhoc-only)
			//   - clear_todos            (adhoc-only)
			//
			// Tools ADDED (ferment-mode, newly visible):
			//   - ask_user               (interactive routing — TUI in interactive mode,
			//                              judge model in oneshot via ferment/ask-user.ts)
			//   - confirm_ferment_completion_criteria (interactive routing, planning)
			//   - set_phase              (planning — phase tracker)
			//   - propose_ferment_scoping / scope_ferment / update_ferment_scope_field
			//                            (planning — scoping surface)
			//   - list_ferments          (always-both discovery)
			//   - activate_ferment_phase (planning → implementation transition)
			//   - refine/complete/skip/fail/start/complete/verify/skip/fail_ferment_step
			//                            (implementation — step lifecycle)
			//   - add_ferment_decision / add_ferment_memory
			//                            (implementation — knowledge capture)
			//   - complete_ferment       (implementation — termination)
			//   - edit / write / Agent / get_subagent_result (implementation write set)
			//
			// Tools UNCHANGED (shared core, visible in both modes):
			//   - read, grep, find, ls, web_fetch, web_search
			//   - bash (read-only gate still applies — same per-call enforcement)
			try {
				// Parse the plan against the shared planning process structure first.
				// Goal / Constraints / Chunks become structured ferment fields;
				// Verification Strategy / Decision Log / Risks are metadata and must
				// not become implementation steps. (PR #683 review nit 3473746281.)
				const parsed = parseSharedPlan(text)
				// Create a storage instance scoped to ctx.cwd so the ferment artifact
				// lands in the project's .kimchi/ferments/ directory, not process.cwd().
				// defaultFermentRuntime.getStorage() always uses process.cwd(); in
				// production these are the same, but tests (and future multi-root setups)
				// need the explicit scoping.
				const fermentDir = resolveFermentsDir(ctx.cwd)
				const storage = new FermentEventStore(fermentDir)
				const runtime = { ...defaultFermentRuntime, getStorage: () => storage }

				// If the plan doesn't follow the shared structure (no `## Chunks`
				// section), fall back to draft-only: persist the ferment but do NOT
				// activate a phase or swap to implementation tools. Lossy section
				// splitting would produce steps named "Goal", "Constraints", "Risks",
				// etc., which silently misrepresent the plan. The user can resume
				// the draft via /ferment list when they want to implement it.
				if (parsed.chunks.length === 0) {
					const draftName = parsed.goal.split("\n")[0] || "Plan from --plan mode"
					const draft = storage.create(draftName, parsed.goal || text.trim())
					defaultFermentRuntime.setActive(draft)
					if (pi.events) emitFermentCreated(pi.events, draft)
					appendRefEntry(pi, draft.id)
					changeMode(ctx, "plan", "auto", "user")
					ctx.ui?.notify?.(
						`Saved draft ferment "${draft.name}". The plan didn't include a "## Chunks" section, so it wasn't auto-scoped. Use /ferment list to resume and scope it interactively.`,
					)
					return
				}

				// Create the ferment through the normal storage API so it gets a
				// proper ID, is visible to runtime.getActive(), the scheduler, and
				// the compaction / resume paths.
				const fermentName = parsed.goal.split("\n")[0].slice(0, 80) || "Plan from --plan mode"
				const draft = storage.create(fermentName, parsed.goal)
				// Scope it using the structured fields from the shared plan.
				const applyAndPersist = createApplyAndPersist(runtime)
				const scoped = applyAndPersist(draft.id, {
					type: "scope",
					goal: parsed.goal,
					successCriteria: parsed.successCriteria,
					constraints: parsed.constraints,
					phases: [
						{
							name: fermentName,
							goal: parsed.goal,
							// Each chunk becomes one implementation step. Title and body
							// are joined so the engineer sees the full chunk context.
							steps: parsed.chunks.map((chunk) => ({
								description: chunk.body ? `${chunk.title}\n${chunk.body}` : chunk.title,
							})),
						},
					],
				})
				if (!scoped.ok) throw new Error(scoped.error.message)
				// Activate the first phase so the ferment enters implementation mode.
				const activated = applyAndPersist(draft.id, {
					type: "activate_phase",
					phaseId: scoped.ferment.phases[0]?.id ?? "phase-1",
				})
				if (!activated.ok) throw new Error(activated.error.message)
				// Register the ferment as active in the runtime, emit the creation
				// event, and append a session ref so resumed sessions can find it.
				defaultFermentRuntime.setActive(activated.ferment)
				setActiveFermentAndApplyProfile(pi, defaultFermentRuntime, activated.ferment)
				// pi.events may be undefined in headless / test contexts; guard before emitting.
				if (pi.events) emitFermentCreated(pi.events, activated.ferment)
				appendRefEntry(pi, activated.ferment.id)
				changeMode(ctx, "plan", "auto", "user")
			} catch (err) {
				// Fail closed: if the runtime path failed (storage write error, FSM
				// rejection, etc.), the session must NOT end up with implementation
				// tools visible but no active ferment, no session ref, no creation
				// event, and no initialized runtime/scheduler state. That was the
				// silent-invalid-state bug from PR #683 review (comment 3473746278).
				// Stay in plan mode, clear any half-set runtime state, and surface
				// the failure so the user knows promotion did not succeed.
				defaultFermentRuntime.setActive(undefined)
				const message = err instanceof Error ? err.message : String(err)
				ctx.ui?.notify?.(`Could not start this plan as a ferment: ${message}. Staying in plan mode.`)
			}
		}
		// Decline or escape: stay in plan mode.
	})

	// Plan-mode stop nudge: fires when the model made tool calls this turn but
	// ended with stopReason "stop" without writing PLAN_COMPLETE.
	// Logic lives in src/shared/planning/planning-stop-nudge.ts.
	const planStopNudgeCounts = new Map<string, number>()

	pi.on("turn_end", (event, ctx) => {
		if (getRuntimePermissionMode().mode !== "plan") {
			planStopNudgeCounts.clear()
			return
		}

		const message = event.message
		if (message.role !== "assistant") return

		const stopReason = (message as { stopReason?: string }).stopReason
		// Reset counter on non-stop turns (model still progressing).
		if (stopReason !== "stop") {
			planStopNudgeCounts.clear()
			return
		}

		const content = message.content as unknown[]
		const text = extractTextFromContent(content)

		if (
			!shouldNudge({
				hasToolCall: contentHasToolCall(content),
				stopReason,
				completionSignalPresent: hasPlanCompletionSignal(text),
			})
		)
			return

		const sessionId = ctx.sessionManager.getSessionId()
		const count = (planStopNudgeCounts.get(sessionId) ?? 0) + 1
		planStopNudgeCounts.set(sessionId, count)

		if (isNudgeSuppressed(count)) return

		void pi.sendMessage(
			{
				customType: "plan_stop_nudge",
				content: [{ type: "text", text: PLAN_MODE_STOP_NUDGE }],
				display: false,
				details: undefined,
			},
			{ triggerTurn: true },
		)
	})

	pi.on("tool_call", async (event, ctx) => {
		const toolName = event.toolName.toLowerCase()
		const input = event.input as Record<string, unknown>

		// Plan persona path-scope enforcement: when KIMCHI_AGENT_PERSONA=plan (case-insensitive),
		// write and edit are only allowed for .kimchi/plans/* paths.
		if (process.env.KIMCHI_AGENT_PERSONA?.toLowerCase() === "plan") {
			if (toolName === "write" || toolName === "edit") {
				const filePath =
					typeof input.file_path === "string" ? input.file_path : typeof input.path === "string" ? input.path : ""
				if (filePath && !isWithinKimchiPlans(filePath, ctx.cwd)) {
					return {
						block: true,
						reason: `Plan persona: ${toolName} is restricted to .kimchi/plans/ files. The path "${filePath}" is outside that scope.`,
					}
				}
				// path is within .kimchi/plans/ — allow without further checks
				return undefined
			}
		}

		// Re-evaluation loop: when a permission prompt is dismissed because the user
		// changed mode via shift+tab, we re-evaluate the tool call under the new mode.
		// Cap iterations at MODES.length to prevent infinite loops.
		for (let attempt = 0; attempt < MODES.length; attempt++) {
			const { mode } = getRuntimePermissionMode()

			// YOLO mode: bypass ALL permission checks including rules, denylist, and classifier
			if (mode === "yolo") {
				return undefined
			}

			if (mode === "plan") {
				if (toolName === "bash") {
					const command = typeof input.command === "string" ? input.command : ""
					if (!isReadOnlyBashCommand(command)) {
						return {
							block: true,
							reason: `Plan mode: bash command "${command}" is not in the read-only allowlist. Use /permissions mode default (or auto) to run writes.`,
						}
					}
					return undefined
				}
				if (!isPlanModeTool(toolName)) {
					return {
						block: true,
						reason: `Plan mode: tool ${toolName} is not available. Use /permissions mode default to enable writes.`,
					}
				}
				return undefined
			}

			if (BUILTIN_ALLOW_TOOL_NAMES.includes(toolName)) return undefined

			// Ferment tools are internal state-management operations; bypass user rules and classifier prompts.
			// User-facing ferment tools (`ask_user`) are listed in USER_FACING_FERMENT_TOOL_NAMES and skip this bypass.
			if (isFermentToolName(toolName) && !isUserFacingFermentToolName(toolName)) return undefined

			// Compound bash commands: early gate for deny/allow only.
			// If the check returns "prompt", fall through to
			// evaluateRules → auto-mode/classifier → prompt site below.
			if (toolName === "bash") {
				const command = typeof input.command === "string" ? input.command : ""
				if (isCompoundCommand(command)) {
					const compoundCheck = checkCompoundCommand(command, allRules())
					if (compoundCheck.decision === "deny") {
						return {
							block: true,
							reason: compoundCheck.deniedReason ?? "Subcommand denied",
						}
					}
					if (compoundCheck.decision === "allow") {
						return undefined
					}
					// "prompt" → fall through to existing flow
				}
			}

			const match = evaluateRules(allRules(), toolName, input)
			if (match.decision === "deny") {
				return {
					block: true,
					reason: `Denied by rule ${formatRule(match.rule)}`,
				}
			}
			if (match.decision === "allow") return undefined

			// In default mode, a questionnaire call means the agent wants to plan —
			// auto-promote the session to plan mode so the rest of the conversation
			// runs under the right tool set instead of silently approving here.
			if (toolName === "questionnaire" && mode === "default") {
				changeMode(ctx, "default", "plan", "user")
				return undefined
			}
			if (isReadOnlyTool(toolName)) return undefined
			if (toolName === "bash") {
				const command = typeof input.command === "string" ? input.command : ""
				if (isReadOnlyBashCommand(command)) return undefined
			}

			// Auto mode + non-promptable default mode (headless/subagents) both go
			// through the classifier; prompts without a frontend fail closed.
			const promptAvailable = canPrompt(ctx)
			if (mode === "auto" || !promptAvailable) {
				const classifierModels = resolveClassifierModels(ctx.modelRegistry)
				if (!classifierModels) return { block: true, reason: "no model available for classifier" }

				const verdict = await classifyToolCall(
					classifierModels.primary,
					classifierModels.fallback,
					ctx.modelRegistry,
					{ toolName, input, cwd: ctx.cwd },
					{ timeoutMs: loaded.config.classifierTimeoutMs },
					ctx.signal,
				)

				if (verdict.verdict === "safe") return undefined
				if (verdict.verdict === "blocked") {
					return {
						block: true,
						reason: `Classifier blocked: ${verdict.reason}`,
					}
				}
				if (!promptAvailable) {
					return {
						block: true,
						reason: `Classifier: ${verdict.reason} (no UI to confirm)`,
					}
				}
				const result = await handleConfirm(event, {
					ctx,
					subtitle: `Classifier: ${verdict.reason}`,
					session,
					activeAborts: activeAbortControllers,
					allRules,
				})
				if (result === "aborted") continue // mode changed, re-evaluate
				return result
			}

			// Prompt site — branch to compound or single-command flow
			if (toolName === "bash") {
				const command = typeof input.command === "string" ? input.command : ""
				if (isCompoundCommand(command)) {
					const subcommands = splitCompoundCommand(command)
					if (subcommands && subcommands.length > 0) {
						const result = await handleCompoundConfirm(event, {
							ctx,
							session,
							activeAborts: activeAbortControllers,
							subcommands,
							allRules,
						})
						if (result === "aborted") continue // mode changed, re-evaluate
						return result
					}
				}
			}
			const result = await handleConfirm(event, {
				ctx,
				session,
				activeAborts: activeAbortControllers,
				allRules,
			})
			if (result === "aborted") continue // mode changed, re-evaluate
			return result
		}

		// Exhausted re-evaluation attempts — fail closed.
		console.warn("permissions: mode changed too many times during prompt, failing closed")
		return {
			block: true,
			reason: "Permission mode changed too many times during prompt",
		}
	})

	registerCommands(pi, {
		getSession: () => session,
		getLoaded: () => loaded,
		getPermissionMode: () => getRuntimePermissionMode().mode,
		setPermissionMode: (ctx, mode) => changeMode(ctx, getRuntimePermissionMode().mode, mode, "user"),
		rebuildConfigRules,
		reloadConfig: (ctx) => {
			const { errors } = doLoadConfig(ctx)
			if (errors.length && ctx.hasUI) {
				for (const err of errors) ctx.ui.notify(`permissions: ${err}`, "warning")
			}
		},
		updateStatus,
	})
}

interface ConfirmOptions {
	ctx: ExtensionContext
	session: SessionMemory
	subtitle?: string
	activeAborts: Set<AbortController>
	allRules?: () => Rule[]
}

async function handleConfirm(
	event: ToolCallEvent,
	opts: ConfirmOptions,
): Promise<{ block: true; reason: string } | "aborted" | undefined> {
	const abort = new AbortController()
	const unlinkAbort = linkAbortSignal(opts.ctx.signal, abort)
	opts.activeAborts.add(abort)
	try {
		const prompter = resolvePrompter(opts.ctx)
		if (!prompter) return { block: true, reason: "No UI to confirm permission" }

		const input = event.input
		const outcome = await prompter.request({
			toolCallId: event.toolCallId ?? `${event.toolName}-permission`,
			toolName: event.toolName,
			input,
			subtitle: opts.subtitle,
			choices: buildPermissionChoices(event.toolName, input),
			signal: abort.signal,
		})

		return applyApprovalOutcome(outcome, opts.session)
	} finally {
		unlinkAbort()
		opts.activeAborts.delete(abort)
	}
}

export async function handleCompoundConfirm(
	event: ToolCallEvent,
	opts: ConfirmOptions & { subcommands: string[] },
): Promise<{ block: true; reason: string } | "aborted" | undefined> {
	const abort = new AbortController()
	const unlinkAbort = linkAbortSignal(opts.ctx.signal, abort)
	opts.activeAborts.add(abort)
	try {
		const prompter = resolvePrompter(opts.ctx)
		if (!prompter) return { block: true, reason: "No UI to confirm permission" }

		if (opts.ctx.mode !== "tui") {
			// Non-TUI transports (chiefly ACP) present compound commands as one
			// permission card. They do not offer TUI's per-subcommand picker, so
			// remembered rules are scoped to the compound call's suggested scope
			// rather than each segment.
			const input = event.input
			const outcome = await prompter.request({
				toolCallId: event.toolCallId ?? `${event.toolName}-permission`,
				toolName: event.toolName,
				input,
				subtitle: opts.subtitle,
				choices: buildPermissionChoices(event.toolName, input),
				signal: abort.signal,
			})
			return applyApprovalOutcome(outcome, opts.session)
		}

		const compoundSubs: CompoundSubcommand[] = opts.subcommands.map((cmd) => ({
			command: cmd,
			description: `bash(${truncate(cmd, 100)})`,
		}))

		const outcome = await promptForCompoundApproval({
			toolName: event.toolName,
			commands: compoundSubs,
			ctx: opts.ctx,
			signal: abort.signal,
		})

		if (outcome.kind === "aborted") return "aborted"
		if (outcome.kind === "allow-all-once") return undefined

		if (outcome.kind === "allow-all-remember") {
			for (const rule of outcome.rules) {
				opts.session.add(rule)
			}
			return undefined
		}

		if (outcome.kind === "pick-per-subcommand") {
			// For each subcommand, evaluate rules and prompt if needed
			for (const subcommand of opts.subcommands) {
				// Re-evaluate rules (user may have added rules during the prompt)
				const match = evaluateRules(opts.allRules ? opts.allRules() : opts.session.all(), "bash", {
					command: subcommand,
				})
				if (match.decision === "allow") {
					continue
				}
				if (match.decision === "deny") {
					return {
						block: true,
						reason: `Subcommand blocked by rule: ${subcommand}`,
					}
				}

				// Create a fake bash event for this subcommand
				const subEvent: ToolCallEvent = {
					...event,
					input: { command: subcommand },
				}
				const result = await handleConfirm(subEvent, opts)
				if (result === "aborted") return "aborted"
				if (result !== undefined) {
					// Blocked
					return { block: true, reason: result.reason }
				}
			}
			return undefined
		}

		if (outcome.kind === "deny-with-feedback") {
			return {
				block: true,
				reason: `The user declined this action before execution and said: ${outcome.feedback}`,
			}
		}

		return { block: true, reason: "Declined by user" }
	} finally {
		unlinkAbort()
		opts.activeAborts.delete(abort)
	}
}

function applyApprovalOutcome(
	outcome: Awaited<ReturnType<ToolPermissionPrompter["request"]>>,
	session: SessionMemory,
): { block: true; reason: string } | "aborted" | undefined {
	if (outcome.kind === "aborted") return "aborted"
	if (outcome.kind === "allow-once") return undefined
	if (outcome.kind === "allow-remember") {
		session.add(outcome.rule)
		return undefined
	}
	if (outcome.kind === "allow-remember-wildcard") {
		session.add(outcome.rule)
		return undefined
	}
	if (outcome.kind === "deny-with-feedback") {
		return {
			block: true,
			reason: `The user declined this action before execution and said: ${outcome.feedback}`,
		}
	}
	return { block: true, reason: "Declined by user" }
}

function linkAbortSignal(signal: AbortSignal | undefined, controller: AbortController): () => void {
	if (!signal) return () => {}
	if (signal.aborted) {
		controller.abort()
		return () => {}
	}
	const abort = () => controller.abort()
	signal.addEventListener("abort", abort, { once: true })
	return () => signal.removeEventListener("abort", abort)
}

function splitFlag(raw: boolean | string | undefined): string[] {
	if (typeof raw !== "string" || !raw) return []
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
}

function truncate(s: string, max: number): string {
	if (s.length <= max) return s
	return `${s.slice(0, max - 1)}…`
}

function formatRule(rule: Rule): string {
	return `${stringifyRule(rule)} [${rule.source}]`
}

interface CompoundCheckResult {
	decision: "allow" | "deny" | "prompt"
	deniedReason?: string
	subcommands?: string[]
}

/**
 * Check if a compound bash command can be allowed, denied, or needs prompting.
 * Exported for testing.
 */
export function checkCompoundCommand(command: string, rules: Rule[]): CompoundCheckResult {
	// First check for hard-blocked programs
	if (isHardBlockedBash(command)) {
		return {
			decision: "deny",
			deniedReason: `Hard-blocked program in command: ${command}`,
		}
	}

	// If not compound, fall through to normal flow
	if (!isCompoundCommand(command)) {
		return { decision: "prompt" }
	}

	// Split into subcommands
	const subcommands = splitCompoundCommand(command)
	if (!subcommands || subcommands.length === 0) {
		return { decision: "prompt" }
	}

	// Check each subcommand — track if all are allowed or any denied
	let allAllowed = true
	for (const subcommand of subcommands) {
		// Check for hard-blocked programs in subcommand
		if (isHardBlockedBash(subcommand)) {
			return {
				decision: "deny",
				deniedReason: `Hard-blocked program in command: ${subcommand}`,
			}
		}
		const match = evaluateRules(rules, "bash", { command: subcommand })
		if (match.decision === "deny") {
			return {
				decision: "deny",
				deniedReason: `Subcommand blocked by rule: ${subcommand}`,
			}
		}
		if (match.decision !== "allow") {
			allAllowed = false
		}
	}

	// If all subcommands explicitly allowed by rules, allow the compound
	if (allAllowed) {
		return { decision: "allow" }
	}

	return { decision: "prompt", subcommands }
}
