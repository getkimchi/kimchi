import { resolve } from "node:path"
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent"
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui"
import { RST_FG, resolvedSemanticFg } from "../../ansi.js"
import { getAcpPrompter } from "../../modes/acp/permission-prompter-registry.js"
import { isAgentWorker } from "../agent-worker-context.js"
import { hasActiveFerment, notifyFermentActive, onActiveFermentChange } from "../ferment/state.js"
import { FERMENT_TOOLS, isFermentToolName, isUserFacingFermentToolName } from "../ferment/tool-names.js"
import { createSystemPromptBlocks } from "../prompt-construction/index.js"
import { type ToolVisibilityAPI, createToolVisibility } from "../prompt-construction/tool-visibility.js"
import { isRawInputCaptureActive } from "../shared-input.js"
import { resolveClassifierModel } from "./classifier-model.js"
import { classifyToolCall } from "./classifier.js"
import { registerCommands } from "./commands.js"
import { type LoadedConfig, loadConfig } from "./config.js"
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
import { BUILTIN_DENY, DEFAULT_CONFIG, type PermissionMode, type Rule } from "./types.js"

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
const PLAN_MODE_TOOLS = ["read", "grep", "find", "ls", "web_search", "web_fetch", "questionnaire", "bash"]
const PLAN_MODE_TOOL_SET = new Set<string>(PLAN_MODE_TOOLS)

// Tools that auto-approve in headless/auto modes without LLM classification.
// `set_phase` is a kimchi built-in. `agent`/`get_subagent_result`/`steer_subagent`
// are the agents-extension surface — `agent` is the canonical delegation tool,
// the other two are read-only/control-plane operations on already-approved spawns.
//
// Names are lowercased because the tool_call handler lowercases event.toolName
// before comparing (see `const toolName = event.toolName.toLowerCase()` below).
const BUILTIN_ALLOW_TOOL_NAMES = ["set_phase", "agent", "get_subagent_result", "steer_subagent"]

const MODES: Array<{ mode: PermissionMode; label: string; color: "success" | "warning" | "error" }> = [
	{ mode: "default", label: "default", color: "success" },
	{ mode: "plan", label: "plan", color: "warning" },
	{ mode: "auto", label: "auto", color: "warning" },
	{ mode: "yolo", label: "yolo", color: "error" },
]

let _currentPermissionsMode: PermissionMode = "default"

export function getCurrentPermissionsMode(): PermissionMode {
	return _currentPermissionsMode
}

let _isUserChosenYolo: () => boolean = () => process.env.KIMCHI_PERMISSIONS === "yolo"

export function isUserChosenYolo(): boolean {
	return _isUserChosenYolo()
}

export { notifyFermentActive }

function canPrompt(ctx: ExtensionContext): boolean {
	if (isAgentWorker()) return false
	if (ctx.hasUI) return true
	return getAcpPrompter(ctx.sessionManager.getSessionId()) !== undefined
}

function resolvePrompter(ctx: ExtensionContext): ToolPermissionPrompter | undefined {
	if (isAgentWorker()) return undefined
	if (ctx.hasUI) return terminalPrompter(ctx)
	return getAcpPrompter(ctx.sessionManager.getSessionId())
}

let _modeChangeListener: ((mode: PermissionMode) => void) | undefined

/**
 * Subscribe to permission mode changes (CLI flag init + shift+tab cycling).
 * Used by --remote to forward the client's mode to the server so the
 * server-side permissions instance gates tool calls under the same mode.
 */
export function onPermissionsModeChange(listener: (mode: PermissionMode) => void): () => void {
	_modeChangeListener = listener
	return () => {
		if (_modeChangeListener === listener) _modeChangeListener = undefined
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
	// Snapshot env before propagateModeToEnv overwrites it; otherwise
	// currentMode() would read its own writes and ignore flag/runtime precedence.
	const envBaseline = process.env.KIMCHI_PERMISSIONS
	let loaded: LoadedConfig = EMPTY_LOADED_CONFIG
	let configRules: Rule[] = []
	let runtimeMode: PermissionMode | undefined
	let cliMode: PermissionMode | undefined
	let planModeApplied = false
	let planModeHiddenTools: string[] = []
	const planToolVisibility: ToolVisibilityAPI = createToolVisibility(pi)
	/** Tracks all active permission prompt abort controllers for concurrent tool calls. */
	const activeAbortControllers = new Set<AbortController>()
	let unsubscribeTerminalInput: (() => void) | null = null
	let _lastCtx: ExtensionContext | undefined

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

	/** Propagate permission mode to spawned subagents. */
	function propagateModeToEnv(): void {
		process.env.KIMCHI_PERMISSIONS = currentMode()
	}

	function currentMode(): PermissionMode {
		return resolveMode({
			runtime: runtimeMode,
			flag: cliMode,
			env: envBaseline,
			config: loaded.config.defaultMode,
		}).mode
	}

	_isUserChosenYolo = () =>
		resolveMode({ runtime: undefined, flag: cliMode, env: envBaseline, config: loaded.config.defaultMode }).mode ===
		"yolo"

	function allRules(): Rule[] {
		return [...session.all(), ...configRules, ...builtinRules]
	}

	function isPlanModeTool(name: string): boolean {
		if (name === FERMENT_TOOLS.REQUEST_WORKFLOW) return cliMode !== "plan"
		return PLAN_MODE_TOOL_SET.has(name) || isReadOnlyTool(name)
	}

	function applyPlanModeTools(): void {
		if (planModeApplied) return
		try {
			planModeHiddenTools = pi.getActiveTools().filter((name) => !isPlanModeTool(name))
			planToolVisibility.disable(planModeHiddenTools)
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
		const mode = currentMode()
		_currentPermissionsMode = mode
		const active = MODES.find((m) => m.mode === mode) ?? MODES[0]
		// Filled dot + active label hardcode kimchi palette so the cue stays legible
		// under kimchi-minimal; unfilled dots + hint use the "text" token to match
		// editor input/cwd chrome.
		const text = (s: string): string => ctx.ui.theme.fg("text", s)
		const dots = MODES.map((m) =>
			m.mode === mode ? `${resolvedSemanticFg(ctx.ui.theme, m.color)}●${RST_FG}` : text("○"),
		).join(" ")
		const name = `${resolvedSemanticFg(ctx.ui.theme, active.color)}${active.label}${RST_FG}`
		const hint = text("→ shift+tab")
		ctx.ui.setStatus("permissions-mode", `${dots} ${name} ${hint}`)
	}

	function cycleMode(ctx: ExtensionContext): void {
		const current = currentMode()
		const idx = MODES.findIndex((m) => m.mode === current)
		const next = MODES[(idx + 1) % MODES.length].mode
		runtimeMode = next
		if (current === "plan" && next !== "plan") restoreToolsFromPlanMode()
		if (next === "plan") applyPlanModeTools()
		propagateModeToEnv()
		updateStatus(ctx)
		// Dismiss all active permission prompts so tool_call handlers re-evaluate under the new mode.
		for (const ctrl of activeAbortControllers) ctrl.abort()
		activeAbortControllers.clear()
		maybeShowYoloWarning(ctx, next)
		_modeChangeListener?.(next)
	}

	// Ferment calls notifyFermentActive() when a ferment is activated or cleared,
	// so permissions can switch to/from yolo.
	onActiveFermentChange((hasActive: boolean) => {
		if (cliMode) return // explicit CLI flag always wins
		const previousMode = currentMode()
		if (hasActive) {
			runtimeMode = "yolo"
		} else {
			// Only clear runtimeMode if we set it for ferment (not if user changed it manually)
			if (runtimeMode === "yolo") runtimeMode = undefined
		}
		const nextMode = currentMode()
		if (previousMode === "plan" && nextMode !== "plan") restoreToolsFromPlanMode()
		if (nextMode === "plan") applyPlanModeTools()
		propagateModeToEnv()
		if (_lastCtx) {
			updateStatus(_lastCtx)
			maybeShowYoloWarning(_lastCtx, currentMode())
		}
		_modeChangeListener?.(nextMode)
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

	function maybeShowYoloWarning(ctx: ExtensionContext, mode: PermissionMode) {
		if (!ctx.hasUI) return
		if (mode === "yolo") {
			ctx.ui.setStatus(
				"permissions-warning",
				"WARNING: all permission checks disabled. Recommended for sandbox environments only.",
			)
		} else {
			ctx.ui.setStatus("permissions-warning", undefined)
		}
	}

	function switchToPlanModeRuntime(ctx: ExtensionContext): void {
		runtimeMode = "plan"
		applyPlanModeTools()
		propagateModeToEnv()
		updateStatus(ctx)
		// Other concurrent prompts are stale under the new mode — let them re-evaluate.
		for (const ctrl of activeAbortControllers) ctrl.abort()
		activeAbortControllers.clear()
		maybeShowYoloWarning(ctx, "plan")
	}

	function switchFromPlanAndExecute(
		ctx: ExtensionContext,
		targetMode: PermissionMode,
		planPath: string | undefined,
		planText: string,
	): void {
		runtimeMode = targetMode
		restoreToolsFromPlanMode()
		propagateModeToEnv()
		updateStatus(ctx)
		maybeShowYoloWarning(ctx, targetMode)

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
		_lastCtx = ctx
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

		// Active ferment → auto-yolo so scoping/lifecycle work can proceed without approval prompts.
		// No env var is set before the user explicitly approves ferment creation.
		// Only applies when no explicit CLI mode flag was given.
		if (!cliMode && hasActiveFerment()) {
			runtimeMode = "yolo"
		}

		if (currentMode() === "plan") applyPlanModeTools()
		propagateModeToEnv()
		updateStatus(ctx)

		maybeShowYoloWarning(ctx, currentMode())
		_modeChangeListener?.(currentMode())
	})

	const blocks = createSystemPromptBlocks(pi, "permissions")
	blocks.register({
		id: "plan-mode-supplement",
		render: () => {
			if (currentMode() !== "plan") return undefined
			return planModeSupplement.trim()
		},
	})

	// When the agent produces <!-- PLAN_COMPLETE --> in plan mode, show the approval menu.
	pi.on("turn_end", async (event, ctx) => {
		if (currentMode() !== "plan") return
		if (!ctx.hasUI) return

		const message = event.message as AssistantMessage
		if (message.role !== "assistant") return

		const text = message.content
			.filter((c) => c.type === "text")
			.map((c) => (c as { type: "text"; text: string }).text)
			.join("\n")

		if (!text.includes("<!-- PLAN_COMPLETE -->") && !text.includes("<done>")) return

		const EXECUTE = "Execute the plan"
		const FERMENT = "Convert to ferment workflow"
		const DECLINE = "Rework the plan"

		const choice = await withWorkingHidden(ctx, () =>
			ctx.ui.select("Plan complete. How would you like to proceed?", [EXECUTE, FERMENT, DECLINE]),
		)

		if (choice === EXECUTE) {
			let planPath: string | undefined
			try {
				planPath = saveApprovedPlan(ctx.cwd, text)
			} catch {
				// Non-fatal: plan persistence is best-effort.
			}
			switchFromPlanAndExecute(ctx, "auto", planPath, text)
		} else if (choice === FERMENT) {
			// Switch to default mode so ferment tools become available, then ask
			// the agent to call request_ferment_workflow with the plan as intent.
			runtimeMode = "default"
			restoreToolsFromPlanMode()
			propagateModeToEnv()
			updateStatus(ctx)
			maybeShowYoloWarning(ctx, "default")

			// Extract a title from the plan text: first non-empty line after a Goal heading,
			// or failing that the first heading text.
			const lines = text.split(/\r?\n/)
			const goalIdx = lines.findIndex((l) => /^#+\s*Goal\b/i.test(l))
			let title = ""
			if (goalIdx >= 0) {
				for (let i = goalIdx + 1; i < lines.length; i++) {
					const trimmed = lines[i].trim()
					if (trimmed.length > 0 && !/^#/.test(trimmed)) {
						title = trimmed.slice(0, 80).trim()
						break
					}
				}
			}
			if (!title) {
				title =
					lines[0]
						?.replace(/^#+\s*/, "")
						.trim()
						.slice(0, 80) ?? "Plan"
			}
			pi.sendMessage(
				{
					customType: "plan-execute",
					content: `The user approved the plan and wants to run it as a ferment workflow. You MUST call \`request_ferment_workflow\` now — do not describe it, do not ask for confirmation, just call it immediately.

Use these exact values:
- title: "${title}"
- intent: the full plan text below (copy it verbatim as the intent)

The plan text:
\`\`\`
${text}
\`\`\``,
					display: false,
				},
				{ triggerTurn: true },
			)
		}
		// Decline or escape: stay in plan mode.
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
			const mode = currentMode()

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
						return { block: true, reason: compoundCheck.deniedReason ?? "Subcommand denied" }
					}
					if (compoundCheck.decision === "allow") {
						return undefined
					}
					// "prompt" → fall through to existing flow
				}
			}

			const match = evaluateRules(allRules(), toolName, input)
			if (match.decision === "deny") {
				return { block: true, reason: `Denied by rule ${formatRule(match.rule)}` }
			}
			if (match.decision === "allow") return undefined

			// In default mode, a questionnaire call means the agent wants to plan —
			// auto-promote the session to plan mode so the rest of the conversation
			// runs under the right tool set instead of silently approving here.
			if (toolName === "questionnaire" && mode === "default") {
				switchToPlanModeRuntime(ctx)
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
				const classifierModel = resolveClassifierModel(ctx.model, ctx.modelRegistry)
				if (!classifierModel) return { block: true, reason: "no model available for classifier" }

				const verdict = await classifyToolCall(
					classifierModel,
					ctx.modelRegistry,
					{ toolName, input, cwd: ctx.cwd },
					{ timeoutMs: loaded.config.classifierTimeoutMs },
					ctx.signal,
				)

				if (verdict.verdict === "safe") return undefined
				if (verdict.verdict === "blocked") {
					return { block: true, reason: `Classifier blocked: ${verdict.reason}` }
				}
				if (!promptAvailable) {
					return { block: true, reason: `Classifier: ${verdict.reason} (no UI to confirm)` }
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
		return { block: true, reason: "Permission mode changed too many times during prompt" }
	})

	registerCommands(pi, {
		getSession: () => session,
		getLoaded: () => loaded,
		getMode: () => currentMode(),
		setRuntimeMode: (m) => {
			runtimeMode = m
			propagateModeToEnv()
		},
		applyPlanMode: () => applyPlanModeTools(),
		restorePlanMode: () => restoreToolsFromPlanMode(),
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

		const input = event.input as Record<string, unknown>
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

		if (!opts.ctx.hasUI) {
			// ACP v1 presents compound commands as one permission card. It does
			// not offer TUI's per-subcommand picker, so remembered rules are scoped
			// to the compound call's suggested scope rather than each segment.
			const input = event.input as Record<string, unknown>
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
					return { block: true, reason: `Subcommand blocked by rule: ${subcommand}` }
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
			return { block: true, reason: outcome.feedback }
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
		return { block: true, reason: outcome.feedback }
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
		return { decision: "deny", deniedReason: `Hard-blocked program in command: ${command}` }
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
			return { decision: "deny", deniedReason: `Hard-blocked program in command: ${subcommand}` }
		}
		const match = evaluateRules(rules, "bash", { command: subcommand })
		if (match.decision === "deny") {
			return { decision: "deny", deniedReason: `Subcommand blocked by rule: ${subcommand}` }
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
