import type { Tip, TipProvider } from "./types.js"

export const GENERAL_TIPS = [
	{
		id: "permissions-shortcut",
		scope: "general",
		message: "Press `shift+tab` to change permissions mode.",
	},
	{
		id: "settings-themes",
		scope: "general",
		message: "Run `/settings > Themes` to change colors.",
	},
	{
		id: "multi-model-switch",
		scope: "general",
		message: "Use `ctrl+p` or `/model` to select multi-model for auto routing.",
	},
	{
		id: "single-model-mode",
		scope: "general",
		message: "Use `/model` to select single model for entire session",
	},
	{
		id: "agents",
		scope: "general",
		message: "Use `/agents` to manage agents or display running agents sessions",
	},
	{
		id: "todos-overlay",
		scope: "general",
		message: "Todos: `/todos` or `F7`; expand tools with `ctrl+o`.",
	},
	{
		id: "add-tags",
		scope: "general",
		message: "Tag requests in Analytics: `/tags add key:value` (e.g. project:myapp).",
	},
	{
		id: "continue-session",
		scope: "general",
		message: "Resume the latest session with `kimchi --continue`.",
	},
	{
		id: "named-branch",
		scope: "general",
		message: "Name a branch with `/branch <name>`; resume it with `-r <id>`.",
	},
	{
		id: "verbose-output",
		scope: "general",
		message: "Use `kimchi --verbose` when output looks off.",
	},
	{
		id: "export-bug-report",
		scope: "general",
		message: "Run `/bug` to create GitHub issue with a bug report.",
	},
	{
		id: "multi-model-roles",
		scope: "general",
		message: "Run `/multi-model` to assign models to each role.",
	},
	{
		id: "help-command",
		scope: "general",
		message: "Type `/help` to see all keyboard shortcuts and slash commands.",
	},
	{
		id: "show-all-tips",
		scope: "general",
		message: "Run `/tips` to see all tips. Use `/tips disable` or `/tips enable` to show/hide.",
	},
] as const satisfies readonly Tip[]

export function createGeneralTipProvider(): TipProvider {
	return {
		source: "kimchi.general",
		getTips: () => GENERAL_TIPS,
	}
}
