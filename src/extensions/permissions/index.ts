import type { Api, Model } from "@earendil-works/pi-ai"
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent"
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui"
import { RST_FG, resolvedSemanticFg } from "../../ansi.js"
import { resolveClassifierModel } from "./classifier-model.js"
import { classifyToolCall } from "./classifier.js"
import { registerCommands } from "./commands.js"
import { type LoadedConfig, loadConfig } from "./config.js"
import { resolveMode } from "./mode.js"
import { promptForApproval } from "./prompts.js"
import planModeSupplement from "./prompts/plan-mode-supplement.js"
import { evaluateRules, parseRules, stringifyRule } from "./rules.js"
import { SessionMemory } from "./session-memory.js"
import { isReadOnlyBashCommand, isReadOnlyTool } from "./taxonomy.js"
import { BUILTIN_DENY, DEFAULT_CONFIG, type PermissionMode, type Rule } from "./types.js"

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

// subagent delegates to a sub-session that enforces permissions on its own calls.
// ferment tools are internal state-management operations, never write user files or run shell commands.
const BUILTIN_ALLOW_TOOL_NAMES = [
	"subagent",
	"set_phase",
	"create_ferment",
	"list_ferments",
	"scope_ferment",
	"update_scope_field",
	"activate_phase",
	"refine_phase",
	"start_step",
	"complete_step",
	"verify_step",
	"skip_step",
	"complete_phase",
	"skip_phase",
	"complete_ferment",
	"fail_step",
	"fail_phase",
	"add_decision",
	"add_memory",
	"set_ferment_mode",
]

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

/** Called by the ferment extension whenever a ferment becomes active or is cleared. */
let _onFermentActiveChange: ((hasActiveFerment: boolean) => void) | undefined

export function notifyFermentActive(hasActiveFerment: boolean): void {
	_onFermentActiveChange?.(hasActiveFerment)
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
	let originalActiveTools: string[] | null = null
	let planModeApplied = false
	/** Tracks all active permission prompt abort controllers for concurrent tool calls. */
	const activeAbortControllers = new Set<AbortController>()
	let unsubscribeTerminalInput: (() => void) | null = null
	let _lastCtx: ExtensionContext | undefined

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

	function allRules(): Rule[] {
		return [...session.all(), ...configRules, ...builtinRules]
	}

	function applyPlanModeTools(): void {
		if (planModeApplied) return
		try {
			if (originalActiveTools === null) {
				originalActiveTools = pi.getActiveTools()
			}
			const allTools = pi.getAllTools()
			const planTools = new Set<string>()
			for (const tool of allTools) {
				if (PLAN_MODE_TOOLS.includes(tool.name) || isReadOnlyTool(tool.name)) {
					planTools.add(tool.name)
				}
			}
			pi.setActiveTools([...planTools])
			planModeApplied = true
		} catch {
			// setActiveTools may be unavailable; tool_call handler still enforces the policy.
		}
	}

	function restoreToolsFromPlanMode(): void {
		if (!planModeApplied) return
		if (originalActiveTools) {
			try {
				pi.setActiveTools(originalActiveTools)
			} catch {
				// best-effort restore
			}
		}
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
	}

	// Wire the cross-extension callback: ferment calls notifyFermentActive() when
	// a ferment is activated or cleared, so permissions can switch to/from yolo.
	_onFermentActiveChange = (hasActiveFerment: boolean) => {
		if (cliMode) return // explicit CLI flag always wins
		if (hasActiveFerment) {
			runtimeMode = "yolo"
		} else {
			// Only clear runtimeMode if we set it for ferment (not if user changed it manually)
			if (runtimeMode === "yolo") runtimeMode = undefined
		}
		propagateModeToEnv()
		if (_lastCtx) {
			updateStatus(_lastCtx)
			maybeShowYoloWarning(_lastCtx, currentMode())
		}
	}

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

		// Active ferment → auto-yolo so all ferment tools execute without approval prompts.
		// Only applies when no explicit CLI mode flag was given.
		if (!cliMode && process.env.KIMCHI_ACTIVE_FERMENT) {
			runtimeMode = "yolo"
		}

		if (currentMode() === "plan") applyPlanModeTools()
		propagateModeToEnv()
		updateStatus(ctx)

		maybeShowYoloWarning(ctx, currentMode())
	})

	pi.on("before_agent_start", async (event): Promise<{ systemPrompt?: string }> => {
		if (currentMode() !== "plan") return {}
		return { systemPrompt: `${event.systemPrompt}\n\n${planModeSupplement.trim()}` }
	})

	pi.on("tool_call", async (event, ctx) => {
		const toolName = event.toolName.toLowerCase()
		const input = event.input as Record<string, unknown>

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
				if (!isReadOnlyTool(toolName) && !PLAN_MODE_TOOLS.includes(toolName)) {
					return {
						block: true,
						reason: `Plan mode: tool ${toolName} is not available. Use /permissions mode default to enable writes.`,
					}
				}
				return undefined
			}

			const match = evaluateRules(allRules(), toolName, input)
			if (match.decision === "deny") {
				return { block: true, reason: `Denied by rule ${formatRule(match.rule)}` }
			}
			if (match.decision === "allow") return undefined

			if (BUILTIN_ALLOW_TOOL_NAMES.includes(toolName)) return undefined

			// Auto mode + headless default mode (subagents) both go through the
			// classifier; prompts without a UI fail closed.
			if (mode === "auto" || !ctx.hasUI) {
				if (isReadOnlyTool(toolName)) return undefined
				if (toolName === "bash") {
					const command = typeof input.command === "string" ? input.command : ""
					if (isReadOnlyBashCommand(command)) return undefined
				}

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
				if (!ctx.hasUI) {
					return { block: true, reason: `Classifier: ${verdict.reason} (no UI to confirm)` }
				}
				const result = await handleConfirm(event, {
					ctx,
					subtitle: `Classifier: ${verdict.reason}`,
					session,
					activeAborts: activeAbortControllers,
				})
				if (result === "aborted") continue // mode changed, re-evaluate
				return result
			}

			const result = await handleConfirm(event, { ctx, session, activeAborts: activeAbortControllers })
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
}

async function handleConfirm(
	event: ToolCallEvent,
	opts: ConfirmOptions,
): Promise<{ block: true; reason: string } | "aborted" | undefined> {
	const abort = new AbortController()
	opts.activeAborts.add(abort)
	try {
		const outcome = await promptForApproval({
			toolName: event.toolName,
			input: event.input as Record<string, unknown>,
			ctx: opts.ctx,
			subtitle: opts.subtitle,
			signal: abort.signal,
		})

		if (outcome.kind === "aborted") return "aborted"
		if (outcome.kind === "allow-once") return undefined
		if (outcome.kind === "allow-remember") {
			opts.session.add(outcome.rule)
			return undefined
		}
		if (outcome.kind === "deny-with-feedback") {
			return { block: true, reason: outcome.feedback }
		}
		return { block: true, reason: "Declined by user" }
	} finally {
		opts.activeAborts.delete(abort)
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
