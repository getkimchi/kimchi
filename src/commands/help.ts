import { ANSI, fg } from "../ansi.js"
import { COMMANDS } from "./registry.js"

const SECTION_HEADER = "\x1b[1m"
const RESET = "\x1b[0m"

function bold(text: string): string {
	return `${SECTION_HEADER}${text}${RESET}`
}

function dim(text: string): string {
	return fg(ANSI.dim, text)
}

interface FlagDoc {
	name: string
	description: string
}

const KIMCHI_FLAGS: FlagDoc[] = [
	{ name: "--provider <name>", description: "Provider (default: kimchi-dev)" },
	{ name: "--model <pattern>", description: "Model id or pattern, optionally `provider/id` and/or `:<thinking>`" },
	{ name: "--thinking <level>", description: "Thinking level: off, minimal, low, medium, high, xhigh" },
	{ name: "--mode <mode>", description: "Output mode: text (default), json, rpc, acp" },
	{ name: "--print, -p", description: "Non-interactive mode: process prompt and exit" },
	{ name: "--continue, -c", description: "Resume the most recent session" },
	{ name: "--resume, -r [id]", description: "Resume by id, or pick a previous session interactively when omitted" },
	{ name: "--session <path>", description: "Resume a specific session file (full path or partial UUID)" },
	{ name: "--no-session", description: "Run ephemerally — don't write a session file" },
	{ name: "--export <file>", description: "Export a session to HTML and exit" },
	{ name: "--list-models [search]", description: "Print available models (optionally fuzzy-filtered)" },
	{ name: "--allow-tool <rule>", description: "Add session permission allow rules (comma-separated)" },
	{ name: "--deny-tool <rule>", description: "Add session permission deny rules (comma-separated)" },
	{ name: "--plan", description: "Start in plan mode (read-only)" },
	{ name: "--auto", description: "Start in auto mode (run freely, classifier guards)" },
	{ name: "--yolo", description: "Start in yolo mode (run freely, no classifier - DANGER)" },
	{ name: "--permissions-config <path>", description: "Replace the merged permissions config with this file" },
	{ name: "--verbose", description: "Force verbose startup (overrides quietStartup)" },
	{ name: "--help, -h", description: "Show this help" },
	{ name: "--version, -v", description: "Show the kimchi version" },
]

const KIMCHI_ENV: FlagDoc[] = [
	{ name: "KIMCHI_API_KEY", description: "Kimchi API key (overrides config.json apiKey)" },
	{ name: "KIMCHI_PERMISSIONS", description: "Initial permissions mode: default | plan | auto | yolo" },
	{
		name: "KIMCHI_TELEMETRY_ENABLED",
		description: "Override telemetry (1/true to enable, 0/false to disable). On by default.",
	},
	{ name: "KIMCHI_TAGS", description: "Comma-separated `key:value` tags applied to every LLM request" },
	{ name: "KIMCHI_NO_UPDATE_CHECK", description: "Disable the background self-update probe" },
]

function printSection(rows: FlagDoc[], pad: number): void {
	for (const row of rows) {
		console.log(`  ${row.name.padEnd(pad)}${row.description}`)
	}
}

function maxNameWidth(rows: FlagDoc[]): number {
	return Math.max(...rows.map((r) => r.name.length))
}

/**
 * Print a self-contained help screen: kimchi-specific subcommands, flags, and
 * env vars only. We deliberately don't delegate to pi-coding-agent's printer —
 * that would surface options and env vars (e.g. ANTHROPIC_API_KEY) and
 * extension-management commands that are not exposed by kimchi.
 *
 * Flags listed here are forwarded verbatim to pi-coding-agent's parser when
 * the user runs the harness (no subcommand). Keep the list curated: only flags
 * that meaningfully affect kimchi behaviour and that we expect to support
 * indefinitely.
 */
export async function printMergedHelp(): Promise<void> {
	console.log(`${bold("kimchi")} — code with powerful open-source LLMs`)
	console.log()
	console.log(`${bold("Usage:")} kimchi [subcommand] [options] [@files…] [messages…]`)
	console.log()

	console.log(bold("Subcommands:"))
	const cmdPad = Math.max(...COMMANDS.map((c) => c.name.length)) + 4
	for (const cmd of COMMANDS) {
		console.log(`  kimchi ${cmd.name.padEnd(cmdPad)}${cmd.summary}`)
	}
	console.log(`  kimchi ${"".padEnd(cmdPad)}${dim("(no subcommand)")} Launch the coding harness`)
	console.log()

	console.log(`${bold("Harness flags")} ${dim("(no subcommand)")}:`)
	printSection(KIMCHI_FLAGS, maxNameWidth(KIMCHI_FLAGS) + 2)
	console.log()

	console.log(bold("Environment variables:"))
	printSection(KIMCHI_ENV, maxNameWidth(KIMCHI_ENV) + 2)
	console.log()

	console.log(bold("Examples:"))
	console.log(`  kimchi setup                                ${dim("# first-time interactive setup")}`)
	console.log(`  kimchi setup-tools                          ${dim("# configure coding tools")}`)
	console.log(`  kimchi                                      ${dim("# launch the interactive harness")}`)
	console.log(`  kimchi -p "explain src/cli.ts"              ${dim("# one-shot prompt, no session")}`)
	console.log(`  kimchi --continue                           ${dim("# resume the most recent session")}`)
	console.log(`  kimchi claude -p "review this PR"           ${dim("# run Claude Code via Kimchi")}`)
}
