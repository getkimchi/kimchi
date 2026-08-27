import { resolve } from "node:path"
import type { ExtensionAPI, ExtensionContext, SessionManager, ToolCallEvent } from "@earendil-works/pi-coding-agent"
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui"
import { Type } from "typebox"
import { RST_FG, resolvedSemanticFg } from "../../ansi.js"
import { FermentEventStore } from "../../ferment/event-store.js"
import { resolveFermentsDir } from "../../ferment/store.js"
import { isExistingDirectory } from "../../fs-paths.js"
import { getAcpPrompter } from "../../modes/acp/permission-prompter-registry.js"
import * as EntryTriggerRegistry from "../../shared/planning/entry-trigger-registry.js"
import { parseSharedPlan } from "../../shared/planning/plan-decomposition.js"
import { derivePlanTitle, savePlanMarkdown, slugifyPlanName } from "../../shared/planning/plan-markdown.js"
import {
	contentHasToolCall,
	extractTextFromContent,
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
import { createApplyAndPersist, formatNextActionHint } from "../ferment/tool-helpers.js"
import { isFermentToolName, isUserFacingFermentToolName } from "../ferment/tool-names.js"
import { setActiveFermentAndApplyProfile } from "../ferment/tool-scope.js"
import { withBlocked } from "../herdr-events.js"
import { isIdeConnected } from "../ide-adapter/index.js"
import { getMultiModelEnabled } from "../multi-model.js"
import { createSystemPromptBlocks } from "../prompt-construction/index.js"
import type { SystemPromptBlock } from "../prompt-construction/system-prompt-blocks.js"
import {
	createToolVisibility,
	getDisabledToolNames,
	type ToolVisibilityAPI,
} from "../prompt-construction/tool-visibility.js"
import { isRawInputCaptureActive } from "../shared-input.js"
import { markHarnessSteer } from "../steer-marker.js"
import { TODO_CUSTOM_ENTRY_TYPE } from "../todos/constants.js"
import { applyWriteTodos, syncTodoWidget } from "../todos/index.js"
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
	"bash",
	"exitplanmode",
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
// `agent`/`get_subagent_result`/`steer_subagent`
// are the agents-extension surface — `agent` is the canonical delegation tool,
// the other two are read-only/control-plane operations on already-approved spawns.
//
// Names are lowercased because the tool_call handler lowercases event.toolName
// before comparing (see `const toolName = event.toolName.toLowerCase()` below).
const BUILTIN_ALLOW_TOOL_NAMES = ["agent", "get_subagent_result", "steer_subagent", ...TODO_TOOL_NAMES]

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

	pi.registerTool({
		name: "ExitPlanMode",
		label: "Exit plan mode",
		description:
			"Present the complete plan for approval and leave plan mode only after the user approves it. Pass the full plan in `plan`.",
		promptSnippet: "Present the completed plan for approval",
		promptGuidelines: [
			"Call ExitPlanMode only after the complete plan is written and all open questions are resolved.",
		],
		parameters: Type.Object({
			plan: Type.Optional(
				Type.String({ description: "The complete plan in the shared Goal / Constraints / Chunks structure." }),
			),
		}),
		execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => handlePlanExit(ctx, params.plan),
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
	const activePlanSlugs = new Map<string, string>()
	const planModeHiddenTools = new Map<string, string[]>()
	const planModeSnapshots = new Map<string, { mode: PermissionModeState; activeTools: string[] }>()
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
		return PLAN_MODE_TOOL_SET.has(name.toLowerCase()) || isReadOnlyTool(name)
	}

	function applyPlanModeTools(ctx: ExtensionContext): void {
		const sessionId = ctx.sessionManager.getSessionId()
		try {
			// Track which tools plan mode is removing so `restoreToolsFromPlanMode`
			// can re-enable them. Without this snapshot, restore would be a no-op
			// because `ToolProfileManager.apply` (via `pi.setActiveTools`) does
			// not preserve the prior active-tool set.
			const hiddenTools = pi.getActiveTools().filter((name) => !isPlanModeTool(name))
			const previouslyHiddenTools = planModeHiddenTools.get(sessionId) ?? []
			// Register the disable vote with the cooperative visibility layer so
			// `restoreToolsFromPlanMode`'s `planToolVisibility.enable(...)` call
			// matches the matching disable vote (and so the snapshot below does
			// not re-surface these tools when `getDisabledToolNames` is read by
			// other extensions' `setActiveTools` calls).
			planToolVisibility.disable(hiddenTools)
			ToolProfileManager.apply("planning-adhoc", "adhoc", pi)
			planModeHiddenTools.set(sessionId, [...new Set([...previouslyHiddenTools, ...hiddenTools])])
		} catch {
			// Tool visibility may be unavailable; tool_call handler still enforces the policy.
		}
	}

	function restoreToolsFromPlanMode(ctx: ExtensionContext, restoreActiveTools = false): void {
		const sessionId = ctx.sessionManager.getSessionId()
		const snapshot = sessionId ? planModeSnapshots.get(sessionId) : undefined
		const hiddenTools = planModeHiddenTools.get(sessionId)
		try {
			if (hiddenTools) planToolVisibility.enable(hiddenTools)
			if (restoreActiveTools) {
				if (snapshot) {
					const disabledTools = getDisabledToolNames(pi)
					pi.setActiveTools(snapshot.activeTools.filter((name) => !disabledTools.has(name)))
				} else ToolProfileManager.apply("idle", "adhoc", pi)
			}
		} catch {
			// best-effort restore
		}
		planModeHiddenTools.delete(sessionId)
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
		restorePlanTools = true,
	): void {
		const from = getRuntimePermissionMode()
		const sessionId = ctx.sessionManager.getSessionId()
		if (next.mode === "plan" && current !== "plan" && !planModeSnapshots.has(sessionId)) {
			planModeSnapshots.set(sessionId, { mode: from, activeTools: pi.getActiveTools() })
		}
		setRuntimePermissionMode(ctx, next, skipNotify)
		if (current === "plan" && next.mode !== "plan") {
			restoreToolsFromPlanMode(ctx, restorePlanTools)
			activePlanSlugs.delete(sessionId)
			planModeSnapshots.delete(sessionId)
		}
		if (next.mode === "plan") applyPlanModeTools(ctx)
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

	function currentAssistantText(ctx: ExtensionContext): string {
		const branch = (ctx.sessionManager as SessionManager).getBranch?.() ?? []
		for (const entry of [...branch].reverse()) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue
			return extractTextFromContent(entry.message.content as unknown[]).trim()
		}
		return ""
	}

	function savePlan(ctx: ExtensionContext, planText: string): string | undefined {
		const text = planText.trim()
		if (!text) return undefined
		const sessionId = ctx.sessionManager.getSessionId()
		if (!activePlanSlugs.has(sessionId)) activePlanSlugs.set(sessionId, slugifyPlanName(derivePlanTitle(text)))
		try {
			return savePlanMarkdown({
				cwd: ctx.cwd,
				name: activePlanSlugs.get(sessionId) ?? "untitled-plan",
				planText: `${text}\n`,
			})
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err)
			if (ctx.hasUI) ctx.ui.notify(`permissions: failed to save plan file: ${detail}`, "warning")
			else console.error(`permissions: failed to save plan file: ${detail}`)
			return undefined
		}
	}

	function seedPlanTodos(ctx: ExtensionContext, planText: string): void {
		const parsed = parseSharedPlan(planText)
		if (parsed.chunks.length === 0) return
		const sessionId = ctx.sessionManager.getSessionId()
		const details = applyWriteTodos(
			{
				scope: { kind: "global" },
				todos: parsed.chunks.map((chunk) => ({ content: chunk.title, status: "pending" as const })),
			},
			sessionId,
		)
		pi.appendEntry(TODO_CUSTOM_ENTRY_TYPE, details)
		syncTodoWidget(ctx)
	}

	function compactPlanHandoff(planText: string, planPath: string | undefined): string {
		const parsed = parseSharedPlan(planText)
		const chunks = parsed.chunks.map((chunk, index) => `${index + 1}. ${chunk.title}`).join("\n")
		return [
			"The user approved the plan. Execute it now.",
			parsed.goal ? `Goal: ${parsed.goal}` : undefined,
			parsed.constraints.length > 0 ? `Constraints:\n${parsed.constraints.map((c) => `- ${c}`).join("\n")}` : undefined,
			chunks ? `Chunks:\n${chunks}` : undefined,
			planPath ? `Plan path: ${planPath}` : undefined,
			"Use the approved plan already in the conversation; do not re-plan or resend it.",
		]
			.filter(Boolean)
			.join("\n\n")
	}

	async function promotePlanToFerment(
		ctx: ExtensionContext,
		planText: string,
		planPath: string | undefined,
	): Promise<void> {
		const parsed = parseSharedPlan(planText)
		const fermentDir = resolveFermentsDir(ctx.cwd)
		const storage = new FermentEventStore(fermentDir)
		const runtime = { ...defaultFermentRuntime, getStorage: () => storage }
		const fermentName = parsed.goal.split("\n")[0].slice(0, 80) || "Plan from plan mode"
		const draft = createFerment(runtime, {
			name: fermentName,
			goal: parsed.goal || planText,
			hasUI: ctx.hasUI,
			isOneShot: pi.getFlag("ferment-oneshot") === true,
		})
		defaultFermentRuntime.setActive(draft)
		if (pi.events) emitFermentCreated(pi.events, draft)
		if (parsed.chunks.length === 0) {
			appendRefEntry(pi, draft.id)
			changeMode(ctx, "plan", { mode: "auto", initiatedBy: "user", source: "runtime" }, "plan_approval")
			ctx.ui.notify(`Saved draft ferment "${draft.name}". Add a ## Chunks section before activating it.`)
			return
		}
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
					steps: parsed.chunks.map((chunk) => ({
						description: chunk.body ? `${chunk.title}\n${chunk.body}` : chunk.title,
					})),
				},
			],
		})
		if (!scoped.ok) throw new Error(scoped.error.message)
		const activated = applyAndPersist(draft.id, {
			type: "activate_phase",
			phaseId: scoped.ferment.phases[0]?.id ?? "phase-1",
		})
		if (!activated.ok) throw new Error(activated.error.message)
		defaultFermentRuntime.setActive(activated.ferment)
		setActiveFermentAndApplyProfile(pi, defaultFermentRuntime, activated.ferment)
		appendRefEntry(pi, activated.ferment.id)
		const activePhase = activated.ferment.phases.find((p) => p.status === "active")
		const nextActionHint = formatNextActionHint(activated.ferment, getMultiModelEnabled(ctx.sessionManager))
		await safeSendMessage(
			pi,
			{
				customType: "ferment_handoff",
				content: [
					{
						type: "text",
						text: markHarnessSteer(
							[
								`The plan was approved by the user ("Start as ferment"); it was converted to ferment "${activated.ferment.name}" (${activated.ferment.id}).`,
								planPath ? `Approved plan saved to: ${planPath}` : undefined,
								`The ferment is ALREADY scoped and ${activePhase ? `phase "${activePhase.id}" (${activePhase.steps.length} steps) is ACTIVE.` : "its first phase is ACTIVE."}`,
								nextActionHint,
								"Do not call list_ferments, scope_ferment, or propose_ferment_scoping again. Scope mutations will be rejected after activation; ask_user remains available for genuine execution blockers or recovery.",
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
		changeMode(ctx, "plan", { mode: "auto", initiatedBy: "user", source: "runtime" }, "plan_approval", undefined, false)
	}

	async function handlePlanExit(ctx: ExtensionContext, requestedPlan: string | undefined) {
		if (getRuntimePermissionMode().mode !== "plan") {
			return {
				content: [{ type: "text" as const, text: "ExitPlanMode is only available in plan mode." }],
				details: null,
			}
		}
		const planText = (requestedPlan?.trim() || currentAssistantText(ctx)).trim()
		if (!planText) {
			return {
				content: [
					{ type: "text" as const, text: "Provide the complete plan in the `plan` argument before exiting plan mode." },
				],
				details: null,
			}
		}
		const planPath = savePlan(ctx, planText)

		// Non-interactive callers must never wait on a UI that cannot exist. They
		// receive a deterministic result and remain in read-only plan mode.
		if (!ctx.hasUI || ctx.mode !== "tui" || isAgentWorker() || pi.getFlag("ferment-oneshot") === true) {
			return {
				content: [
					{
						type: "text" as const,
						text: planPath
							? `Plan saved to ${planPath}. Interactive approval is required before execution.`
							: "Plan recorded. Interactive approval is required before execution.",
					},
				],
				details: { planPath, approved: false },
			}
		}

		const EXECUTE = "Execute the plan"
		const DECLINE = "Rework the plan"
		const START_AS_FERMENT = "Start as ferment"
		const choice = await withBlocked(pi.events, "Review plan", () =>
			withWorkingHidden(ctx, () =>
				ctx.ui.select(`Review this plan:\n\n${planText}\n\nHow would you like to proceed?`, [
					EXECUTE,
					DECLINE,
					START_AS_FERMENT,
				]),
			),
		)
		if (choice === EXECUTE) {
			seedPlanTodos(ctx, planText)
			changeMode(
				ctx,
				"plan",
				planModeSnapshots.get(ctx.sessionManager.getSessionId())?.mode ?? {
					mode: "default",
					source: "config",
					initiatedBy: "user",
				},
				"plan_approval",
			)
			pi.events.emit(PERMISSION_EVENTS.PLAN_APPROVED, { planPath })
			await pi.sendUserMessage(compactPlanHandoff(planText, planPath), { deliverAs: "followUp" })
			activePlanSlugs.delete(ctx.sessionManager.getSessionId())
			return {
				content: [{ type: "text" as const, text: "Plan approved; execution has started." }],
				details: { planPath, approved: true },
			}
		}
		if (choice === DECLINE) {
			return {
				content: [{ type: "text" as const, text: "Revise the plan and call ExitPlanMode again when it is ready." }],
				details: { planPath, approved: false },
			}
		}
		if (choice === START_AS_FERMENT) {
			try {
				await promotePlanToFerment(ctx, planText, planPath)
				activePlanSlugs.delete(ctx.sessionManager.getSessionId())
				return {
					content: [{ type: "text" as const, text: "Plan converted to ferment." }],
					details: { planPath, approved: true },
				}
			} catch (err) {
				defaultFermentRuntime.setActive(undefined)
				const message = err instanceof Error ? err.message : String(err)
				ctx.ui.notify(`Could not start this plan as a ferment: ${message}. Staying in plan mode.`, "warning")
				return {
					content: [{ type: "text" as const, text: "Plan promotion failed; remain in plan mode." }],
					details: { planPath, approved: false },
				}
			}
		}
		return {
			content: [{ type: "text" as const, text: "Plan approval was dismissed; remain in plan mode." }],
			details: { planPath, approved: false },
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx
		cliMode = undefined
		activePlanSlugs.delete(ctx.sessionManager.getSessionId())
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

		const sessionId = ctx.sessionManager.getSessionId()
		const current = getInitialPermissionMode(ctx.sessionManager)
		let next = current
		if (current.mode === "plan") {
			// A fresh --plan launch has no preceding runtime transition to capture;
			// use the normal default as its restore target. A resumed plan likewise
			// falls back to default while retaining the exact pre-gating tool set.
			planModeSnapshots.set(sessionId, {
				mode: { mode: "default", source: "config", initiatedBy: "user" },
				activeTools: pi.getActiveTools(),
			})
		}
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
		const sessionId = currentCtx?.sessionManager.getSessionId()
		if (sessionId) {
			planModeSnapshots.delete(sessionId)
			planModeHiddenTools.delete(sessionId)
		}
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
		if (getRuntimePermissionMode().mode === "plan") applyPlanModeTools(ctx)
		maybePersistPermissionMode(ctx)
	})

	// Plan-mode stop nudge: fires when the model made tool calls this turn but
	// ended with stopReason "stop" without calling ExitPlanMode.
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
		const exitedPlan = content.some((item) => {
			const call = item as { type?: string; name?: string }
			return (call.type === "toolCall" || call.type === "tool_use") && call.name?.toLowerCase() === "exitplanmode"
		})
		if (!shouldNudge({ hasToolCall: contentHasToolCall(content) && !exitedPlan, stopReason })) return

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
