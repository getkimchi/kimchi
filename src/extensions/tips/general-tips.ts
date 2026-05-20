import type { Tip, TipProvider } from "./types.js"

export const GENERAL_TIPS = [
	{
		id: "permissions-shortcut",
		message: "Press shift+tab to change permissions mode.",
		command: "shift+tab",
	},
	{
		id: "settings-themes",
		message: "Run /settings > Themes to change colors.",
		command: "/settings",
	},
	{
		id: "multi-model-switch",
		message: "Press ctrl+p to choose a model from multi-model mode.",
		command: "ctrl+p",
	},
	{
		id: "add-tags",
		message: "Tag requests with /tags add key:value, e.g. project:myapp team:backend.",
		command: "/tags add",
	},
	{
		id: "auto-tags",
		message: 'Set default tags: export KIMCHI_TAGS="team:backend,project:api".',
		command: "export KIMCHI_TAGS",
	},
	{
		id: "continue-session",
		message: "Resume the latest session with kimchi --continue.",
		command: "kimchi --continue",
	},
	{
		id: "verbose-output",
		message: "Use kimchi --verbose when output looks off.",
		command: "kimchi --verbose",
	},
	{
		id: "export-bug-report",
		message: "Run /export to save HTML for a bug report.",
		command: "/export",
	},
] as const satisfies readonly Tip[]

export function createGeneralTipProvider(): TipProvider {
	return {
		source: "kimchi.general",
		kind: "general",
		getTips: () => GENERAL_TIPS,
	}
}
