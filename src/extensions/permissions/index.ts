import { resolve } from "node:path"
import { Type } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext, SessionManager, ToolCallEvent } from "@earendil-works/pi-coding-agent"
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui"
import { RST_FG, resolvedSemanticFg } from "../../ansi.js"
import { FermentEventStore } from "../../ferment/event-store.js"
import { resolveFermentsDir } from "../../ferment/store.js"
import { isExistingDirectory } from "../../fs-paths.js"
import { getAcpPrompter } from "../../modes/acp/permission-prompter-registry.js"
import * as EntryTriggerRegistry from "../../shared/planning/entry-trigger-registry.js"
import { parseSharedPlan } from "../../shared/planning/plan-decomposition.js"
import { derivePlanTitle, savePlanMarkdown, slugifyPlanName } from "../../shared/planning/plan-markdown.js"
import {
	consumePlanReviewContext,
	emitPlanReviewDecision,
	emitPlanReviewRequest,
	onPlanReviewDecision,
	type PlanReviewDecisionPayload,
} from "../../shared/planning/plan-review-bus.js"
import {
	contentHasToolCall,
	hasPlanSubmitToolCall,
	isNudgeSuppressed,
	PLAN_MODE_STOP_NUDGE,
	shouldNudge,
} from "../../shared/planning/planning-stop-nudge.js"
import * as PromptSupplementRegistry from "../../shared/planning/prompt-supplement-registry.js"
import * as ToolProfileManager from "../../shared/planning/tool-profile-manager.js"
import { isAgentWorker } from "../agent-worker-context.js"
import { createFerment } from "../ferment/create.js"
import { emitFermentCreated } from "../ferment/domain-events-emitter.js"
import { appendRefEntry } from "../ferment/nudge.js"
import { defaultFermentRuntime } from "../ferment/runtime.js"
import { safeSendMessage } from "../ferment/safe-send.js"
import { hasActiveFerment, notifyFermentActive, onActiveFermentChange } from "../ferment/state.js"
import { createApplyAndPersist, formatNextActionHint, formatNoReplanningGuidance } from "../ferment/tool-helpers.js"
import { isFermentToolName, isUserFacingFermentToolName } from "../ferment/tool-names.js"
import { setActiveFermentAndApplyProfile } from "../ferment/tool-scope.js"
import { withBlocked } from "../herdr-events.js"
import { isIdeConnected } from "../ide-adapter/index.js"
import { getMultiModelEnabled } from "../multi-model.js"
import { createSystemPromptBlocks } from "../prompt-construction/index.js"
import type { SystemPromptBlock } from "../prompt-construction/system-prompt-blocks.js"
import { createToolVisibility, type ToolVisibilityAPI } from "../prompt-construction/tool-visibility.js"
import { isRawInputCaptureActive } from "../shared-input.js"
import { markHarnessSteer } from "../steer-marker.js"
import { TODO_TOOL_NAMES } from "../todos/tool.js"
import { classifyToolCall } from "./classifier.js"
import { registerCommands } from "./commands.js"
import { type LoadedConfig, loadConfig } from "./config.js"
import { BUILTIN_DENY, DEFAULT_CONFIG, PERMISSION_MODES_WITH_META as MODES, PERMISSIONS_ENV_KEY } from "./constants.js"
import { resolveMode } from "./mode.js"
import {
	getPermissionMode,
	persistPermissionModeIfChanged,
	resolveInitialPermissionMode,
	setPermissionMode,
} from "./mode-controller.js"
import { getSessionPermissionFlagController } from "./mode-controller-registry.js"
import { type ModeChangeReason, PERMISSION_EVENTS, type PermissionDecision } from "./permissions-events.js"
import type { ToolPermissionPrompter } from "./prompter.js"
import planModeSupplement from "./prompts/plan-mode-supplement.js"
import {
	type ApprovalOutcome,
	buildPermissionChoices,
	type CompoundApprovalOutcome,
	type CompoundSubcommand,
	promptForCompoundApproval,
	terminalPrompter,
	withWorkingHidden,
} from "./prompts.js"
import { evaluateRules, parseRules, stringifyRule } from "./rules.js"
import { SessionMemory } from "./session-memory.js"
import {
	isCompoundCommand,
	isHardBlockedBash,
	isReadOnlyBashCommand,
	isReadOnlyTool,
	splitCompoundCommand,
} from "./taxonomy.js"
import type { PermissionMode, PermissionModeState, RiskScore, Rule, RuleSource } from "./types.js"

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
	"mcp",
	"questionnaire",
	"submit_plan",
	"bash",
	...TODO_TOOL_NAMES,
	// DAP debugger tools — available in plan mode by product decision: the
	// debugger is the fastest way to investigate an issue the user is asking
	// to plan a fix for. NOTE: this is NOT a read-only allowance —
	// debug_launch executes the program (with args/env) and debug_eval runs
	// arbitrary expressions in the debuggee, so plan mode can observe runtime
	// behavior at the cost of executing user code. This mirrors how plan mode
	// already permits read-only bash probing; side effects of the debuggee
	// itself are out of scope for the gate.
	"debug_launch",
	"debug_set_breakpoint",
	"debug_continue",
	"debug_locals",
	"debug_eval",
	"debug_backtrace",
	"debug_terminate",
	"step_in",
	"step_over",
	"step_out",
	"debug_state_at",
	"debug_last_error",
	"debug_trace_calls",
	"debug_watch_change",
	"debug_set_variable",
	"debug_restart",
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

/**
 * Build the plan-mode prompt supplement system-prompt block. The mode
 * resolver is injected so tests can drive the block deterministically
 * without booting the full extension — the block's ONLY declared input
 * is the runtime permission mode (see system-prompt-stability tests).
 */
export function buildPlanModeSupplementBlock(getMode: () => PermissionModeState): SystemPromptBlock {
	return {
		id: "plan-mode-supplement",
		render: () => {
			if (getMode().mode !== "plan") return undefined
			return planModeSupplement.trim()
		},
	}
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
	// Base KIMCHI_PERMISSIONS env var used as a launch-time default. Subagent
	// inheritance is handled separately in session_start via the parent session's
	// per-session env key.
	const permissionsEnvFlag = process.env[PERMISSIONS_ENV_KEY]
	let loaded: LoadedConfig = EMPTY_LOADED_CONFIG
	let configRules: Rule[] = []
	let currentCtx: ExtensionContext | undefined
	let preFermentMode: PermissionModeState | undefined
	let cliMode: PermissionMode | undefined
	// Session-held slug of the plan currently being drafted. Kept across rework
	// turns so rewrites overwrite the same file even if the plan title changes;
	// released when the plan is approved (execute / start-as-ferment) or the
	// session restarts.
	let activePlanSlug: string | undefined
	// Per-session count of plan-mode stall nudges (model stopped after tool
	// calls without calling submit_plan). Keyed by session ID so concurrent
	// sessions don't share a budget. Reset when submit_plan is called, when
	// the mode leaves plan, and on session restart.
	const planStopNudgeCounts = new Map<string, number>()
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

	function getInitialPermissionMode(
		sessionManager: Pick<SessionManager, "getSessionId" | "getEntries">,
	): PermissionModeState {
		return resolveInitialPermissionMode(sessionManager, permissionsEnvFlag, cliMode, loaded)
	}

	/**
	 * Returns the current permission mode flag or falls back to a user default.
	 */
	function getRuntimePermissionMode(): PermissionModeState {
		const runtimeMode = currentCtx && getPermissionMode(currentCtx.sessionManager.getSessionId())
		return resolveMode({
			runtime: runtimeMode,
			flag: cliMode,
			env: permissionsEnvFlag,
			config: loaded.config.defaultMode,
		})
	}

	/**
	 * Set current permission mode, keeps the controller in sync, and
	 * persists the env key for sub-agents.
	 */
	function setRuntimePermissionMode(ctx: ExtensionContext, mode: PermissionModeState, skipNotify?: boolean): void {
		setPermissionMode(ctx.sessionManager.getSessionId(), mode, skipNotify)
	}

	/**
	 * Persist the current permission mode to the session log if it diverges from
	 * the last logged value, or if there is no logged value yet.
	 */
	function maybePersistPermissionMode(ctx: ExtensionContext): void {
		persistPermissionModeIfChanged(ctx.sessionManager, pi.appendEntry, getRuntimePermissionMode())
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
		const name = `${resolvedSemanticFg(ctx.ui.theme, active.color)}${active.tuiLabel}${RST_FG}`
		const hint = ctx.ui.theme.fg("dim", "→ shift+tab")
		ctx.ui.setStatus("permissions-mode", `${name} ${hint}`)
	}

	function maybeShowYoloWarning(ctx: ExtensionContext) {
		if (!ctx.hasUI) return
		const { mode, initiatedBy } = getRuntimePermissionMode()
		if (mode === "yolo" && initiatedBy === "user") {
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
		next: PermissionModeState,
		reason: ModeChangeReason,
		skipNotify?: boolean,
	): void {
		const from = getRuntimePermissionMode()
		setRuntimePermissionMode(ctx, next, skipNotify)
		if (current === "plan" && next.mode !== "plan") {
			restoreToolsFromPlanMode()
			activePlanSlug = undefined
			planStopNudgeCounts.delete(ctx.sessionManager.getSessionId())
		}
		if (next.mode === "plan") applyPlanModeTools()
		// Dismiss all active permission prompts so tool_call handlers re-evaluate under the new mode.
		for (const ctrl of activeAbortControllers) ctrl.abort()
		activeAbortControllers.clear()
		updateStatus(ctx)
		maybeShowYoloWarning(ctx)
		pi.events.emit(PERMISSION_EVENTS.MODE_CHANGED, { from, to: next, reason })
	}

	function cycleMode(ctx: ExtensionContext): void {
		const { mode: current } = getRuntimePermissionMode()
		const idx = MODES.findIndex((m) => m.mode === current)
		const next = MODES[(idx + 1) % MODES.length].mode
		changeMode(ctx, current, { mode: next, initiatedBy: "user", source: "runtime" }, "user_shift_tab")
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
		const current = getRuntimePermissionMode()
		if (hasActive) {
			if (current.initiatedBy === "user") preFermentMode = current
			changeMode(
				currentCtx,
				current.mode,
				{
					mode: "yolo",
					source: "runtime",
					initiatedBy: "ferment",
				},
				"ferment_elevation",
			)
		} else if (preFermentMode) {
			const saved = preFermentMode
			preFermentMode = undefined
			// Only restore the pre-ferment mode while the session is still on the
			// ferment elevation. If the user changed mode manually mid-ferment,
			// their choice wins over the restore.
			if (current.initiatedBy === "ferment") {
				changeMode(currentCtx, current.mode, saved, "ferment_restore")
			}
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
		pi.events.emit(PERMISSION_EVENTS.CONFIG_LOADED, {
			cwd: ctx.cwd,
			ruleCount: configRules.length + builtinRules.length,
			errors,
		})
		return { errors }
	}

	function executePlan(planPath: string | undefined, planText: string): void {
		// Notify subscribers (e.g. the ACP plan tracker) that planning ended and
		// the approved plan is now executing — pre-approval planning todos must
		// not be reported as plan progress.
		pi.events.emit(PERMISSION_EVENTS.PLAN_APPROVED, { planPath })
		// Send the approved plan as the execution trigger. No compaction needed —
		// the plan text is already in context from the planning conversation.
		const planRef = planPath ? `\n\nApproved plan saved to: ${planPath}` : ""
		pi.sendMessage(
			{
				customType: "plan-execute",
				content: markHarnessSteer(`The user approved the plan. Execute it now.${planRef}\n\n---\n\n${planText}`),
				display: false,
			},
			{ triggerTurn: true },
		)
	}

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx
		cliMode = undefined
		activePlanSlug = undefined
		planStopNudgeCounts.delete(ctx.sessionManager.getSessionId())
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

		const current = getInitialPermissionMode(ctx.sessionManager)
		let next = current
		// Active ferment → auto-yolo so scoping/lifecycle work can proceed without approval prompts.
		// The elevation is persisted at the next before_agent_start as a ferment-owned entry;
		// resume skips ferment-owned entries, so the session restores the previous user mode.
		// Only applies when no explicit CLI mode flag was given.
		if (!cliMode && hasActiveFerment()) {
			if (current.initiatedBy === "user") preFermentMode = current
			next = {
				mode: "yolo",
				initiatedBy: "ferment",
				source: "runtime",
			}
		}

		changeMode(ctx, current.mode, next, "session_start")

		const sessionId = ctx.sessionManager.getSessionId()
		unsubscribePermissionFlagController = getSessionPermissionFlagController(sessionId)?.subscribe(({ mode: next }) => {
			if (!next) return

			const current = getRuntimePermissionMode()
			if (current.mode === next.mode) return

			// ACP already emitted the config update from controller.setMode().
			// This call is only for local transition side effects.
			changeMode(ctx, current.mode, next, "controller", true)
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
	const planModeSupplementBlock = buildPlanModeSupplementBlock(getRuntimePermissionMode)
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

	// Persist user-sourced mode changes at turn boundaries. This satisfies the
	// spec requirement that shift+tab cycling updates the UI immediately but is
	// only written to the session log when the next agent run starts.
	pi.on("before_agent_start", (_event, ctx) => {
		maybePersistPermissionMode(ctx)
	})

	// Plan-mode stall recovery: when the model made tool calls in plan mode and
	// then ended the turn with stopReason "stop" without calling submit_plan,
	// the session would stall silently — nudge it to resolve open questions and
	// submit the plan. Capped per session; agent workers are excluded (they
	// submit via submit_plan in their own terminate-on-tool-return flow).
	pi.on("turn_end", (event, ctx) => {
		if (isAgentWorker()) return
		if (getRuntimePermissionMode().mode !== "plan") return
		if (event.message.role !== "assistant") return
		const content = Array.isArray(event.message.content) ? event.message.content : []
		const toolNames = content
			.filter((c) => (c as { type: string }).type === "toolCall" || (c as { type: string }).type === "tool_use")
			.map((c) => (c as { name?: unknown }).name)
			.filter((name): name is string => typeof name === "string")
		if (hasPlanSubmitToolCall(toolNames)) {
			// The review flow owns the turn now. Reset the stall budget so a
			// rework round starts fresh.
			planStopNudgeCounts.delete(ctx.sessionManager.getSessionId())
			return
		}
		const stopReason = (event.message as { stopReason?: string }).stopReason
		if (!shouldNudge({ hasToolCall: contentHasToolCall(content), stopReason, completionSignalPresent: false })) {
			return
		}
		const sessionId = ctx.sessionManager.getSessionId()
		const count = (planStopNudgeCounts.get(sessionId) ?? 0) + 1
		planStopNudgeCounts.set(sessionId, count)
		if (isNudgeSuppressed(count)) return
		safeSendMessage(
			pi,
			{
				customType: "plan-mode-stop-nudge",
				content: PLAN_MODE_STOP_NUDGE,
				display: false,
			},
			{ triggerTurn: true, deliverAs: "steer" },
		)
	})

	// submit_plan tool — the adhoc plan-mode completion signal.
	// Visible in both adhoc plan mode and ferment planning phase (via the
	// tool catalog). The model calls it when the plan is ready for review.
	// For ferment, the model should call propose_ferment_scoping first (to
	// populate the structured scope), then submit_plan to trigger the review.
	pi.registerTool({
		name: "submit_plan",
		label: "Submit Plan",
		description:
			"Submit your completed plan for user review. Call this only after the plan " +
			"is fully written and all open questions are resolved. The plan will be " +
			"saved to disk and the user will review it in a visual UI before execution. " +
			"If the plan is denied with feedback, revise and call this again.",
		parameters: Type.Object({
			plan: Type.String({
				description:
					"The complete plan as markdown. Must follow the required structure: " +
					"Goal, Constraints, Chunks (with Files Changed, Depends On, Accept When, " +
					"Test Coverage, Open Questions), Verification Strategy, Decision Log, Risks.",
			}),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const planText = (params as { plan?: string })?.plan
			if (!planText?.trim()) {
				return {
					content: [{ type: "text", text: "Error: plan text is empty." }],
					details: { submitted: false },
				}
			}

			// Allowed contexts:
			// 1. Adhoc plan mode (mode === "plan") — full review flow.
			// 2. Agent workers (e.g. Plan persona subagents) — saves + terminates
			//    with no review emit; the parent orchestrator is the plan's
			//    evaluator.
			const mode = getRuntimePermissionMode().mode
			if (mode !== "plan" && !isAgentWorker()) {
				return {
					content: [
						{
							type: "text",
							text: "Error: submit_plan is only available during plan mode or in a Plan agent worker.",
						},
					],
					details: { submitted: false },
				}
			}

			// Save plan to disk
			if (!activePlanSlug) activePlanSlug = slugifyPlanName(derivePlanTitle(planText))
			let planPath: string | undefined
			try {
				planPath = savePlanMarkdown({ cwd: ctx.cwd, name: activePlanSlug, planText })
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err)
				if (ctx.hasUI) ctx.ui.notify(`permissions: failed to save plan file: ${detail}`, "warning")
				else console.error(`permissions: failed to save plan file: ${detail}`)
			}

			// Agent worker: silent submit. Saves the plan and terminates the turn
			// with no review emit — workers have no review surface, the parent
			// orchestrator evaluates the plan, and the plannotator adapter skips
			// worker sessions. agent-runner surfaces planPath back to the parent
			// from this tool result.
			if (isAgentWorker()) {
				return {
					content: [
						{
							type: "text",
							text: planPath ? `Plan submitted and saved to ${planPath}.` : "Plan submitted.",
						},
					],
					details: { submitted: true, source: "worker", planPath },
					terminate: true,
				}
			}

			// Emit plan-review request once — TUI popup, plannotator browser, and
			// future integrations all listen on the same channel. Subscribers
			// self-select: the plannotator adapter skips non-interactive sessions.
			emitPlanReviewRequest(
				pi,
				{ planContent: planText, planFilePath: planPath, source: "adhoc" },
				{ ctx, planPath, planText, rawText: planText, activePlanSlug },
			)

			// Non-TUI / oneshot: no popup to show — end the turn. The emit above
			// is a no-op today (adapter skips subscribing), but future integrations
			// (logging, CI reviewers, alternative UIs) can hook in without changes.
			if (!ctx.hasUI || pi.getFlag?.("ferment-oneshot") === true) {
				return {
					content: [{ type: "text", text: "Plan submitted." }],
					details: { submitted: true },
					terminate: true,
				}
			}

			// AbortSignal lets the decision handler dismiss the menu when
			// plannotator decides first (select returns undefined on abort).
			// The listener is unsubscribed when the menu resolves — it is
			// per-review and must not accumulate on the shared event bus.
			const planMenuAbort = new AbortController()
			const unsubscribeAbortListener = onPlanReviewDecision(pi, (payload: PlanReviewDecisionPayload) => {
				if (payload.planReviewSource !== "adhoc") return
				if (payload.source !== "plannotator") return
				planMenuAbort.abort()
			})

			const EXECUTE = "Execute the plan"
			const DECLINE = "Rework the plan"
			const START_AS_FERMENT = "Start as ferment"

			void withBlocked(pi.events, "Plan complete", () =>
				withWorkingHidden(ctx, () =>
					ctx.ui.select("Plan complete. How would you like to proceed?", [EXECUTE, DECLINE, START_AS_FERMENT], {
						signal: planMenuAbort.signal,
					}),
				),
			)
				.then((choice) => {
					unsubscribeAbortListener()
					// select returns undefined when aborted — plannotator already decided.
					if (choice === undefined) return
					if (choice === EXECUTE) {
						emitPlanReviewDecision(pi, {
							decision: "execute",
							source: "kimchi-tui",
							planReviewSource: "adhoc",
						})
					} else if (choice === START_AS_FERMENT) {
						emitPlanReviewDecision(pi, {
							decision: "start_ferment",
							source: "kimchi-tui",
							planReviewSource: "adhoc",
						})
					} else {
						emitPlanReviewDecision(pi, {
							decision: "rework",
							source: "kimchi-tui",
							planReviewSource: "adhoc",
						})
					}
				})
				.catch(() => {
					// select rejects when the AbortSignal fires (plannotator decided
					// first) or on unexpected UI errors. Either way, ensure the
					// abort-listener is cleaned up so it doesn't leak on the bus.
					unsubscribeAbortListener()
				})

			return {
				content: [{ type: "text", text: "Plan submitted for review. Waiting for user decision." }],
				details: { submitted: true },
				terminate: true,
			}
		},
	})

	// Decision handler for adhoc plan reviews — handles decisions from both
	// the TUI menu and plannotator's browser UI (first decision wins).
	onPlanReviewDecision(pi, (payload: PlanReviewDecisionPayload) => {
		if (payload.planReviewSource !== "adhoc") return
		const reviewCtx = consumePlanReviewContext()
		if (!reviewCtx) return
		const { ctx, planPath, planText, rawText } = reviewCtx

		if (payload.decision === "execute") {
			changeMode(ctx, "plan", { mode: "auto", initiatedBy: "user", source: "runtime" }, "plan_approval")
			executePlan(planPath, planText)
			activePlanSlug = undefined
		} else if (payload.decision === "start_ferment") {
			// Converted into a ferment — same release as the execute path.
			activePlanSlug = undefined
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
			//
			// Note: todo lifecycle tools (create_todos, update_todos, add_todo,
			// mark_todo, clear_todos) are shared core — they remain visible in
			// all modes including ferment.
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
				const parsed = parseSharedPlan(rawText ?? planText)
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
					const draft = createFerment(runtime, {
						name: draftName,
						goal: parsed.goal || (rawText ?? planText).trim(),
						hasUI: ctx.hasUI,
						isOneShot: pi.getFlag("ferment-oneshot") === true,
					})
					defaultFermentRuntime.setActive(draft)
					if (pi.events) emitFermentCreated(pi.events, draft)
					appendRefEntry(pi, draft.id)
					changeMode(ctx, "plan", { mode: "auto", initiatedBy: "user", source: "runtime" }, "plan_approval")
					ctx.ui?.notify?.(
						`Saved draft ferment "${draft.name}". The plan didn't include a "## Chunks" section, so it wasn't auto-scoped. Use /ferment list to resume and scope it interactively.`,
					)
					return
				}

				// Create the ferment through the normal storage API so it gets a
				// proper ID, is visible to runtime.getActive(), the scheduler, and
				// the compaction / resume paths.
				const fermentName = parsed.goal.split("\n")[0].slice(0, 80) || "Plan from --plan mode"
				const draft = createFerment(runtime, {
					name: fermentName,
					goal: parsed.goal,
					hasUI: ctx.hasUI,
					isOneShot: pi.getFlag("ferment-oneshot") === true,
				})
				// Set the draft active before emitting STARTED so telemetry can capture
				// the scoping baseline. Keep planning tools until activation succeeds.
				defaultFermentRuntime.setActive(draft)
				if (pi.events) emitFermentCreated(pi.events, draft)
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
				defaultFermentRuntime.setActive(activated.ferment)
				setActiveFermentAndApplyProfile(pi, defaultFermentRuntime, activated.ferment)
				appendRefEntry(pi, activated.ferment.id)
				// Explicit model-visible handoff. Without this, the only post-approval
				// signal was the hidden `ferment_reference` entry above, and the model
				// started "from scratch": it re-ran discovery (`list_ferments`) and
				// re-drafted the whole scope via `scope_ferment`, which the FSM then
				// rejected (already PHASE_ACTIVE). Tell the model the ferment is
				// already scoped/active and what the immediate next action is, so "Start
				// as ferment" goes straight to execution.
				const activePhase = activated.ferment.phases.find((p) => p.status === "active")
				const nextActionHint = formatNextActionHint(activated.ferment, getMultiModelEnabled(ctx.sessionManager))
				safeSendMessage(
					pi,
					{
						customType: "ferment_handoff",
						content: [
							{
								type: "text",
								text: markHarnessSteer(
									[
										`Handoff from plan mode: the plan you just presented was approved by the user ("Start as ferment") and converted into ferment "${activated.ferment.name}" (${activated.ferment.id}).`,
										planPath ? `Approved plan saved to: ${planPath}` : undefined,
										`The ferment is ALREADY scoped — goal, success criteria, and constraints are set — and ${activePhase ? `phase "${activePhase.id}" (${activePhase.steps.length} steps) is ACTIVE` : "its first phase is ACTIVE"}.`,
										`${formatNoReplanningGuidance()} Scope mutations will be rejected in this lifecycle state. Do not re-run any orient, interview, or planning steps.`,
										nextActionHint,
										"Go straight to execution.",
									]
										.filter(Boolean)
										.join("\n"),
								),
							},
						],
						display: false,
						details: { fermentId: activated.ferment.id, origin: "plan_mode_start_as_ferment" },
					},
					{ triggerTurn: true },
				)
				changeMode(ctx, "plan", { mode: "auto", initiatedBy: "user", source: "runtime" }, "plan_approval")
			} catch (err) {
				// Promotion failed before activation. Keep the planning profile, clear
				// the half-set runtime state, and tell the user that they can retry.
				defaultFermentRuntime.setActive(undefined)
				const message = err instanceof Error ? err.message : String(err)
				ctx.ui?.notify?.(`Could not start this plan as a ferment: ${message}. Staying in plan mode.`)
			}
		} else if (payload.decision === "feedback") {
			safeSendMessage(
				pi,
				{
					customType: "plannotator-feedback",
					content: [{ type: "text", text: payload.feedback ?? "" }],
					display: false,
				},
				{ triggerTurn: true },
			)
		}
		// "rework" = stay in plan mode, no action needed
	})

	pi.on("tool_call", async (event, ctx) => {
		const toolName = event.toolName.toLowerCase()
		const input = event.input as Record<string, unknown>

		if (toolName === "read") {
			const filePath =
				typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : ""
			if (filePath && isExistingDirectory(filePath, ctx.cwd)) {
				return {
					block: true,
					reason: "Path is a directory; read only accepts files. List or search the directory instead.",
				}
			}
		}

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

			// IDE approval deferral: when the ide-adapter extension has an active
			// IDE connection AND we're in default mode, write/edit approvals are
			// handled via the IDE diff viewer. In auto/yolo the user has opted out
			// of per-file approval, so don't defer.
			if ((toolName === "write" || toolName === "edit") && mode === "default" && isIdeConnected()) {
				// Skip the terminal prompt so the user isn't asked twice.
				return undefined
			}

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
				changeMode(ctx, "default", { mode: "plan", initiatedBy: "user", source: "runtime" }, "questionnaire_promotion")
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
				const verdict = await classifyToolCall(
					ctx.modelRegistry,
					{ toolName, input, cwd: ctx.cwd },
					{ timeoutMs: loaded.config.classifierTimeoutMs },
					ctx.signal,
				)

				if (verdict.verdict === "safe") return undefined
				if (!promptAvailable) {
					return {
						block: true,
						reason: `Classifier: ${verdict.reason} (no UI to confirm)`,
					}
				}
				const result = await handleConfirm(event, {
					ctx,
					pi,
					subtitle: verdict.reason,
					riskScore: verdict.riskScore,
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
							pi,
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
				pi,
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
		setPermissionMode: (ctx, mode) =>
			changeMode(ctx, getRuntimePermissionMode().mode, { mode, initiatedBy: "user", source: "runtime" }, "command"),
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
	/** Risk score from the classifier LLM, for display in the prompt. */
	riskScore?: RiskScore
	activeAborts: Set<AbortController>
	allRules?: () => Rule[]
	pi: ExtensionAPI
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

		opts.pi.events.emit("notification", {
			notification_type: "permission_prompt",
			tool_name: event.toolName,
			tool_use_id: event.toolCallId,
		})

		return await withBlocked(opts.pi.events, `Permission: ${event.toolName}`, async () => {
			opts.pi.events.emit(PERMISSION_EVENTS.BEFORE_PROMPT, {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				compound: false,
				riskScore: opts.riskScore,
				classifierReason: opts.subtitle,
			})

			const input = event.input
			const outcome = await prompter.request({
				toolCallId: event.toolCallId ?? `${event.toolName}-permission`,
				toolName: event.toolName,
				input,
				subtitle: opts.subtitle,
				riskScore: opts.riskScore,
				choices: buildPermissionChoices(event.toolName, input),
				signal: abort.signal,
			})

			opts.pi.events.emit(PERMISSION_EVENTS.AFTER_DECISION, {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				decision: approvalOutcomeToDecision(outcome),
				ruleAdded:
					outcome.kind === "allow-remember" || outcome.kind === "allow-remember-wildcard"
						? { toolName: event.toolName, behavior: "allow" as const, source: "session" as RuleSource }
						: undefined,
			})

			return applyApprovalOutcome(outcome, opts.session)
		})
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

		opts.pi.events.emit("notification", {
			notification_type: "permission_prompt",
			tool_name: event.toolName,
			tool_use_id: event.toolCallId,
		})

		return await withBlocked(opts.pi.events, `Permission: ${event.toolName} (compound)`, async () => {
			opts.pi.events.emit(PERMISSION_EVENTS.BEFORE_PROMPT, {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				compound: true,
				riskScore: opts.riskScore,
				classifierReason: opts.subtitle,
			})

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
				opts.pi.events.emit(PERMISSION_EVENTS.AFTER_DECISION, {
					toolCallId: event.toolCallId,
					toolName: event.toolName,
					decision: approvalOutcomeToDecision(outcome),
					ruleAdded:
						outcome.kind === "allow-remember" || outcome.kind === "allow-remember-wildcard"
							? { toolName: event.toolName, behavior: "allow" as const, source: "session" as RuleSource }
							: undefined,
				})
				return applyApprovalOutcome(outcome, opts.session)
			}

			const compoundSubs: CompoundSubcommand[] = opts.subcommands.map((cmd) => ({
				command: cmd,
			}))

			const outcome = await promptForCompoundApproval({
				toolName: event.toolName,
				commands: compoundSubs,
				ctx: opts.ctx,
				signal: abort.signal,
			})

			opts.pi.events.emit(PERMISSION_EVENTS.AFTER_DECISION, {
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				decision: compoundOutcomeToDecision(outcome),
				ruleAdded:
					outcome.kind === "allow-all-remember" && outcome.rules.length > 0
						? { toolName: event.toolName, behavior: "allow" as const, source: "session" as RuleSource }
						: undefined,
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
		})
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

function approvalOutcomeToDecision(outcome: ApprovalOutcome): PermissionDecision {
	switch (outcome.kind) {
		case "allow-once":
			return "allow_once"
		case "allow-remember":
			return "allow_remember"
		case "allow-remember-wildcard":
			return "allow_remember_wildcard"
		case "deny-with-feedback":
			return "deny_with_feedback"
		case "deny":
			return "deny"
		case "aborted":
			return "aborted"
		default: {
			const _exhaustive: never = outcome
			throw new Error(`Unhandled approval outcome: ${(_exhaustive as ApprovalOutcome).kind}`)
		}
	}
}

function compoundOutcomeToDecision(outcome: CompoundApprovalOutcome): PermissionDecision {
	switch (outcome.kind) {
		case "allow-all-once":
			return "allow_once"
		case "allow-all-remember":
			return "allow_remember"
		case "pick-per-subcommand":
			return "pick_per_subcommand"
		case "deny-with-feedback":
			return "deny_with_feedback"
		case "deny":
			return "deny"
		case "aborted":
			return "aborted"
		default: {
			const _exhaustive: never = outcome
			throw new Error(`Unhandled compound approval outcome: ${(_exhaustive as CompoundApprovalOutcome).kind}`)
		}
	}
}

function splitFlag(raw: boolean | string | undefined): string[] {
	if (typeof raw !== "string" || !raw) return []
	return raw
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean)
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
