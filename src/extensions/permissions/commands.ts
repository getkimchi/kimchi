import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { type LoadedConfig, appendToConfig, projectConfigPath, userConfigPath } from "./config.js"
import { parseModeString } from "./mode.js"
import { parseRule, stringifyRule } from "./rules.js"
import { numberedChoices, stripChoiceNumber } from "./select-utils.js"
import type { SessionMemory } from "./session-memory.js"
import type { PermissionMode, Rule } from "./types.js"

export interface CommandDeps {
	getSession: () => SessionMemory
	getLoaded: () => LoadedConfig
	getPermissionMode: (ctx: ExtensionContext) => PermissionMode
	setPermissionMode: (ctx: ExtensionContext, mode: PermissionMode) => void
	rebuildConfigRules: () => void
	reloadConfig: (ctx: ExtensionContext) => void
	updateStatus: (ctx: ExtensionContext) => void
}

export function registerCommands(pi: ExtensionAPI, deps: CommandDeps): void {
	pi.registerCommand("permissions", {
		description: "View/change permission mode and rules",
		handler: async (args, ctx) => {
			const [sub, ...rest] = args.trim().split(/\s+/).filter(Boolean)

			if (!sub) {
				return openSelector(ctx, deps)
			}

			if (sub === "list" || sub === "status") {
				return showStatus(ctx, deps)
			}

			if (sub === "mode") {
				if (!rest[0]) return openModePicker(ctx, deps)
				return handleMode(ctx, deps, rest[0])
			}

			if (sub === "allow" || sub === "deny") {
				const rule = rest.join(" ")
				if (!rule) {
					ctx.ui.notify(`usage: /permissions ${sub} <rule>`, "warning")
					return
				}
				return addSessionRule(ctx, deps, rule, sub)
			}

			if (sub === "save") {
				const target = rest[0]
				if (target !== "user" && target !== "project") {
					ctx.ui.notify("usage: /permissions save user|project", "warning")
					return
				}
				return saveSessionRules(ctx, deps, target)
			}

			if (sub === "reload") {
				deps.reloadConfig(ctx)
				ctx.ui.notify("permissions: config reloaded", "info")
				return
			}

			if (sub === "help") {
				ctx.ui.notify(HELP_TEXT, "info")
				return
			}

			ctx.ui.notify(`permissions: unknown subcommand "${sub}". Try /permissions help.`, "warning")
		},
	})
}

async function openSelector(ctx: ExtensionContext, deps: CommandDeps): Promise<void> {
	if (!ctx.hasUI) {
		return showStatus(ctx as ExtensionCommandContext, deps)
	}

	const mode = deps.getPermissionMode(ctx)
	const sessionCount = deps.getSession().all().length

	const CHANGE_MODE = "Change mode"
	const LIST_RULES = "Show rules and config"
	const ADD_ALLOW = "Add session allow rule"
	const ADD_DENY = "Add session deny rule"
	const SAVE_USER = "Save session rules → user config"
	const SAVE_PROJECT = "Save session rules → project config"
	const RELOAD = "Reload config files"
	const CANCEL = "Cancel"

	const options = numberedChoices([
		CHANGE_MODE,
		LIST_RULES,
		ADD_ALLOW,
		ADD_DENY,
		...(sessionCount > 0 ? [SAVE_USER, SAVE_PROJECT] : []),
		RELOAD,
		CANCEL,
	])

	const title = `Permissions — mode: ${mode}${sessionCount ? ` · ${sessionCount} session rule(s)` : ""}`
	const choice = await ctx.ui.select(title, options)
	if (!choice) return
	const selected = stripChoiceNumber(choice)
	if (selected === CANCEL) return

	if (selected === CHANGE_MODE) return openModePicker(ctx, deps)
	if (selected === LIST_RULES) return showStatus(ctx as ExtensionCommandContext, deps)
	if (selected === ADD_ALLOW) return promptForRule(ctx, deps, "allow")
	if (selected === ADD_DENY) return promptForRule(ctx, deps, "deny")
	if (selected === SAVE_USER) return saveSessionRules(ctx, deps, "user")
	if (selected === SAVE_PROJECT) return saveSessionRules(ctx, deps, "project")
	if (selected === RELOAD) {
		deps.reloadConfig(ctx)
		ctx.ui.notify("permissions: config reloaded", "info")
	}
}

async function openModePicker(ctx: ExtensionContext, deps: CommandDeps): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(`current mode: ${deps.getPermissionMode(ctx)}`, "info")
		return
	}
	const current = deps.getPermissionMode(ctx)
	const marker = (m: PermissionMode) => (m === current ? "●" : "○")

	const OPT_DEFAULT = `${marker("default")}  default — ask before each tool call`
	const OPT_PLAN = `${marker("plan")}  plan — read-only exploration`
	const OPT_AUTO = `${marker("auto")}  auto — run freely, classifier guards the rest`
	const OPT_YOLO = `${marker("yolo")}  yolo — run freely, no classifier (DANGER)`
	const CANCEL = "Cancel"

	const choice = await ctx.ui.select(
		"Select permission mode",
		numberedChoices([OPT_DEFAULT, OPT_PLAN, OPT_AUTO, OPT_YOLO, CANCEL]),
	)
	if (!choice) return
	const selected = stripChoiceNumber(choice)
	if (selected === CANCEL) return

	let picked: PermissionMode
	switch (selected) {
		case OPT_PLAN:
			picked = "plan"
			break
		case OPT_AUTO:
			picked = "auto"
			break
		case OPT_YOLO:
			picked = "yolo"
			break
		default:
			picked = "default"
	}
	handleMode(ctx, deps, picked)
}

async function promptForRule(ctx: ExtensionContext, deps: CommandDeps, behavior: "allow" | "deny"): Promise<void> {
	const input = await ctx.ui.input(`Add ${behavior} rule`, "e.g. bash(git:*) or write(src/**)")
	const text = input?.trim()
	if (!text) return
	addSessionRule(ctx, deps, text, behavior)
}

const HELP_TEXT = `/permissions — show current mode and rules
/permissions mode <default|plan|auto|yolo> — switch mode
/permissions allow <rule> — add a session allow rule
/permissions deny <rule> — add a session deny rule
/permissions save user|project — persist session rules to config
/permissions reload — re-read config files
/permissions help — show this help`

function showStatus(ctx: ExtensionCommandContext, deps: CommandDeps): void {
	const mode = deps.getPermissionMode(ctx)
	const loaded = deps.getLoaded()
	const session = deps.getSession()

	const lines: string[] = []
	lines.push(`Mode: ${mode}`)
	const paths = loaded.paths
	lines.push("Config:")
	if (paths.cliOverride) lines.push(`  cli-override: ${paths.cliOverride}`)
	if (paths.user) lines.push(`  user: ${paths.user}`)
	if (paths.project) lines.push(`  project: ${paths.project}`)
	if (paths.local) lines.push(`  local: ${paths.local}`)

	const sessionRules = session.all()
	if (sessionRules.length) {
		lines.push("Session rules:")
		for (const r of sessionRules) lines.push(`  ${formatRule(r)}`)
	}

	const file = loaded.config
	if (file.allow.length) {
		lines.push("File allow rules:")
		for (const s of file.allow) lines.push(`  ${s}`)
	}
	if (file.deny.length) {
		lines.push("File deny rules:")
		for (const s of file.deny) lines.push(`  ${s}`)
	}

	ctx.ui.notify(lines.join("\n"), "info")
}

function handleMode(ctx: ExtensionContext, deps: CommandDeps, arg: string): void {
	const mode = parseModeString(arg)
	if (!mode) {
		ctx.ui.notify(`unknown mode "${arg}". Valid: default, plan, auto, yolo`, "warning")
		return
	}
	deps.setPermissionMode(ctx, mode)
}

function addSessionRule(
	ctx: ExtensionContext,
	deps: CommandDeps,
	ruleString: string,
	behavior: "allow" | "deny",
): void {
	const rule = parseRule(ruleString, behavior, "session")
	if (!rule) {
		ctx.ui.notify(`invalid rule: "${ruleString}"`, "warning")
		return
	}
	deps.getSession().add(rule)
	if (ctx.hasUI) ctx.ui.notify(`permissions: added ${behavior} ${formatRule(rule)}`, "info")
}

function saveSessionRules(ctx: ExtensionContext, deps: CommandDeps, target: "user" | "project"): void {
	const rules = deps.getSession().all()
	if (rules.length === 0) {
		ctx.ui.notify("no session rules to save", "info")
		return
	}
	const path = target === "user" ? userConfigPath() : projectConfigPath(ctx.cwd)
	const allow = rules.filter((r) => r.behavior === "allow").map((r) => stringifyRule(r))
	const deny = rules.filter((r) => r.behavior === "deny").map((r) => stringifyRule(r))
	appendToConfig(path, { allow, deny })
	deps.reloadConfig(ctx)
	if (ctx.hasUI) ctx.ui.notify(`permissions: saved ${rules.length} rule(s) to ${path}`, "info")
}

function formatRule(rule: Rule): string {
	return `${rule.behavior} ${stringifyRule(rule)} [${rule.source}]`
}
