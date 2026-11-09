import { ENV_VARS, type EnvVarDef } from "../env-vars.js"
import { bold, dim } from "./console-style.js"

const NOT_SET = "(not set)"

/**
 * Word-wrap `text` so no line exceeds `width` columns. Long descriptions
 * (e.g. telemetry's) would otherwise wrap at the terminal edge and land at
 * column 0, visually breaking out of the description column.
 */
function wrapText(text: string, width: number): string[] {
	const lines: string[] = []
	let line = ""
	for (const word of text.split(" ")) {
		if (line && line.length + 1 + word.length > width) {
			lines.push(line)
			line = word
		} else {
			line = line ? `${line} ${word}` : word
		}
	}
	if (line) lines.push(line)
	return lines
}

function displayValue(def: EnvVarDef): string {
	const raw = process.env[def.name]
	// An explicitly empty value is effectively unset.
	if (raw === undefined || raw === "") return dim(NOT_SET)
	// Never print the value itself. The output is designed to be pasted into
	// bug reports and CI logs, and even nominally non-secret values (proxy
	// URLs, tags, endpoint overrides) can carry credentials or internal
	// hostnames — "set" is all we disclose, so no masking logic can be wrong.
	return "set"
}

/**
 * `kimchi env` — list the supported, user-facing environment variables with
 * their descriptions. `--values` additionally prints whether each variable
 * is currently set — never the value itself, so the output is anonymised
 * and safe to paste.
 *
 * Only ENV_VARS from the central registry (src/env-vars.ts) is printed;
 * IGNORED_ENV_VARS and TEST_SUITE_ENV_VARS hold internal/test plumbing that
 * stays registered (so the scan test still accounts for it) but never shows.
 */
// No `-v` alias: -v is the global version flag, and getSubcommand /
// isHelpOrVersionArgs in cli.ts check it before the subcommand name.
const ACCEPTED_FLAGS = ["--help", "-h", "--values"] as const

function printUsage(stream: typeof console.log): void {
	stream("Usage: kimchi env [--values]")
	stream("")
	stream("List the supported environment variables.")
	stream("Add --values to show whether each variable is currently set (values are never printed).")
}

export async function runEnv(args: string[]): Promise<number> {
	// Unknown args win over --help: a typo'd flag next to -h must not exit 0.
	const unknown = args.filter((a) => !ACCEPTED_FLAGS.includes(a as (typeof ACCEPTED_FLAGS)[number]))
	if (unknown.length > 0) {
		console.error(`kimchi env: unknown argument: ${unknown.map((a) => `"${a}"`).join(", ")}`)
		printUsage(console.error)
		return 1
	}

	if (args.includes("--help") || args.includes("-h")) {
		printUsage(console.log)
		return 0
	}

	const showValues = args.includes("--values")

	console.log(bold("Environment variables recognised by kimchi"))
	console.log()
	const pad = Math.max(...ENV_VARS.map((v) => v.name.length))
	// Continuation lines (wrapped descriptions and value lines) align with the
	// description column, not column 0.
	const descIndent = `  ${"".padEnd(pad)}  `
	// Piped output has no terminal width; 80 mirrors the common default.
	const columns = process.stdout.columns ?? 80
	const descWidth = Math.max(columns - descIndent.length, 20)
	for (const def of ENV_VARS) {
		const [first, ...rest] = wrapText(def.description, descWidth)
		console.log(`  ${def.name.padEnd(pad)}  ${first}`)
		for (const cont of rest) {
			console.log(`${descIndent}${cont}`)
		}
		if (showValues) {
			console.log(`${descIndent}${displayValue(def)}`)
		}
	}
	return 0
}
