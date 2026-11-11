import type { Tip, TipProvider } from "./types.js"

// Every tip must describe a feature that ships today: a tip that names a
// command, flag or key the harness no longer has sends users to a dead end.
// general-tips.test.ts pins the wording and checks the referenced slash
// commands exist; retire a tip here when its feature is deprecated (the
// multi-model tips went with #1357's Auto default).
export const GENERAL_TIPS = [
	{
		id: "permissions-shortcut",
		scope: "general",
		message: "Press `shift+tab` to change permissions mode.",
	},
	{
		id: "settings-themes",
		scope: "general",
		message: "Run `/theme` to change colors.",
	},
	{
		id: "single-model-mode",
		scope: "general",
		message: "Auto picks a model per request; use `/model` to pin one for the session.",
	},
	{
		id: "agents",
		scope: "general",
		message: "Use `/agents` to manage agents or see running agent sessions.",
	},
	{
		id: "todos-overlay",
		scope: "general",
		message: "Todos: `/todos` or `F7`; expand tools with `ctrl+o`.",
	},
	{
		id: "bash-processes",
		scope: "general",
		message: "Use `/processes` to inspect running Bash scripts and output.",
	},
	{
		id: "add-tags",
		scope: "general",
		message: "Tag requests in Analytics: `/tags add key:value` (e.g. project:myapp).",
	},
	{
		id: "work-costs",
		scope: "general",
		message: "Run `/work` to see your work and its PRs.",
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
		message: "Run `/bug` to create GitHub issue with a bug report (PII-scrubbed).",
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
