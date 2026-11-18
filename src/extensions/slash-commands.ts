// The curated slash-command list behind /help (and the two entries ACP
// advertises, see src/modes/acp/commands.ts). It is NOT derived from
// registerCommand: a command is listed here when a user should discover it
// from /help, so internal and debugging commands (cc-*, pi-mcp, …) stay out.
// help.test.ts checks every listed command is a pi built-in or is actually
// registered somewhere in src/, so this list cannot name a command that no
// longer exists. Keep hints to one short line — they share a row with the key.
export const SLASH_COMMANDS = {
	settings: { hint: "Open settings menu" },
	model: { hint: "Switch to a specific model" },
	"scoped-models": { hint: "Enable or disable models for Ctrl+P cycling" },
	theme: { hint: "Select color theme" },
	"customize-status-line": { hint: "Choose which status line elements are shown" },
	status: { hint: "Show version, login, session, model, and MCP status" },
	ferment: { hint: "Run task in background" },
	todos: { hint: "Open todo overlay / manage short-lived todo items" },
	work: { hint: "Show, start, or continue work and link its PRs" },
	branch: { hint: "Branch this session and print a resume command" },
	processes: { hint: "Inspect running Bash commands and their live output" },
	compact: { hint: "Compact context window" },
	name: { hint: "Rename this session" },
	new: { hint: "Start a new session" },
	btw: { hint: "Side chat branched from this session" },
	agents: { hint: "Manage background agents" },
	permissions: { hint: "View or change permission mode and rules" },
	phase: { hint: "Show or change the current work phase" },
	language: { hint: "Show or pin the language Kimchi replies in" },
	hooks: { hint: "View or change Kimchi hooks" },
	resources: { hint: "View or change Kimchi hooks, tools, extensions, and plugins" },
	mcp: { hint: "Show MCP server status" },
	update: { hint: "Manage kimchi auto-update" },
	teleport: { hint: "Teleport to a remote workspace" },
	sync: { hint: "Sync files between local and sandbox workspace" },
	terminal: { hint: "Open a raw SSH shell into a sandbox workspace" },
	"remote-sessions": { hint: "Browse workspaces and their kimchi sessions" },
	"pr-reporting": { hint: "PR cost reporting: on, off, or status" },
	"pr-watch": { hint: "Watch this PR locally, inspect its monitor, and fix CI or review feedback" },
	tags: { hint: "Manage usage tracking tags" },
	stats: { hint: "View coding analytics and metrics" },
	"session-costs": { hint: "Billed cost of this session and your recent sessions" },
	budget: { hint: "Show current budget and usage" },
	"memory-residency": { hint: "Show how much session content is in RAM vs mirrored to disk" },
	bug: { hint: "Report a bug — opens GitHub issue form" },
	tips: { hint: "Show all tips" },
	help: { hint: "Show this help" },
	exit: { hint: "Exit the application" },
}
