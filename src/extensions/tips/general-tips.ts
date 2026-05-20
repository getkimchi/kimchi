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
		message: "Press `ctrl+p` to choose a model from multi-model mode.",
	},
	{
		id: "add-tags",
		scope: "general",
		message: "Tag requests with `/tags add key:value`, e.g. `project:myapp` `team:backend`.",
	},
	{
		id: "auto-tags",
		scope: "general",
		message: 'Set default tags: `export KIMCHI_TAGS="team:backend,project:api"`.',
	},
	{
		id: "continue-session",
		scope: "general",
		message: "Resume the latest session with `kimchi --continue`.",
	},
	{
		id: "verbose-output",
		scope: "general",
		message: "Use `kimchi --verbose` when output looks off.",
	},
	{
		id: "export-bug-report",
		scope: "general",
		message: "Run `/export` to save HTML for a bug report.",
	},
] as const satisfies readonly Tip[]

export function createGeneralTipProvider(): TipProvider {
	return {
		source: "kimchi.general",
		getTips: () => GENERAL_TIPS,
	}
}
