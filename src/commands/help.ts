import { ANSI, fg } from "../ansi.js"
import { CLI_OPTIONS, type CliOptionDef } from "../cli-args.js"
import { listPackageCommands } from "./package-commands.js"
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

function flagDocFromCliOption(name: string, def: CliOptionDef): FlagDoc {
	const long = `--${name}`
	const short = def.short ? `, -${def.short}` : ""
	let value = ""
	if (def.type === "string") {
		value = ` ${def.optional ? (def.placeholder ?? "[value]") : (def.placeholder ?? "<value>")}`
	}
	return { name: `${long}${short}${value}`, description: def.description }
}

const KIMCHI_FLAGS: FlagDoc[] = Object.entries(CLI_OPTIONS).map(([name, def]) => flagDocFromCliOption(name, def))

function printSection(rows: FlagDoc[], pad: number): void {
	for (const row of rows) {
		console.log(`  ${row.name.padEnd(pad)}${row.description}`)
	}
}

function maxNameWidth(rows: FlagDoc[]): number {
	return Math.max(...rows.map((r) => r.name.length))
}

/**
 * Print a self-contained help screen: kimchi-specific subcommands and flags
 * only (env vars are delegated to `kimchi env`). We deliberately don't
 * delegate to pi-coding-agent's printer — that would surface options and env
 * vars (e.g. ANTHROPIC_API_KEY) and extension-management commands that are
 * not exposed by kimchi.
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

	const packageCommands = listPackageCommands()
	if (packageCommands.length > 0) {
		console.log(`${bold("Package commands:")} ${dim("(installed via kimchi install)")}`)
		const pkgPad = Math.max(...packageCommands.map((c) => c.name.length)) + 4
		for (const cmd of packageCommands) {
			console.log(`  kimchi ${cmd.name.padEnd(pkgPad)}${dim(`(from ${cmd.packageName})`)}`)
		}
		console.log()
	}

	console.log(`${bold("Harness flags")} ${dim("(no subcommand)")}:`)
	printSection(KIMCHI_FLAGS, maxNameWidth(KIMCHI_FLAGS) + 2)
	console.log()

	console.log(
		`${bold("Environment variables:")} run ${bold("kimchi env")} to list supported variables with their current values.`,
	)
	console.log()

	console.log(bold("Examples:"))
	console.log(`  kimchi setup                                ${dim("# first-time interactive setup")}`)
	console.log(`  kimchi setup-tools                          ${dim("# configure coding tools")}`)
	console.log(`  kimchi                                      ${dim("# launch the interactive harness")}`)
	console.log(`  kimchi -p "explain src/cli.ts"              ${dim("# one-shot prompt, no session")}`)
	console.log(`  kimchi --continue                           ${dim("# resume the most recent session")}`)
	console.log(`  kimchi claude -p "review this PR"           ${dim("# run Claude Code via Kimchi")}`)
	console.log(
		`  kimchi codex                                ${dim("# run Codex via Kimchi (run kimchi setup-tools first)")}`,
	)
}
