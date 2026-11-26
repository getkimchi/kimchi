import { existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
	DEFAULT_ENV_NAME,
	envsBaseDir,
	type ResolvedKimchiEnv,
	readResolvedKimchiEnv,
	resolveKimchiEnv,
	validateEnvName,
} from "../env-root.js"
import { ENV_VARS, type EnvVarDef } from "../env-vars.js"
import { bold, dim } from "./console-style.js"

const NOT_SET = "(not set)"

/**
 * Word-wrap `text` so no line exceeds `width` columns. Long descriptions
 * (e.g. telemetry's) would otherwise wrap at the terminal edge and land at
 * column 0, visually breaking out of the description column. A token longer
 * than `width` (e.g. the OLLAMA_HOST URL in a narrow terminal) is hard-broken
 * into width-sized chunks — mid-token breaks are acceptable for URLs; letting
 * the terminal wrap them would land the tail at column 0, which is exactly
 * what this wrapper exists to prevent.
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
		while (line.length > width) {
			lines.push(line.slice(0, width))
			line = line.slice(width)
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
	stream("Usage: kimchi env [vars] [--values]")
	stream("       kimchi env list")
	stream("       kimchi env which")
	stream("       kimchi env create <name>")
	stream("")
	stream("Without a subcommand (or with `vars`): list the supported environment variables.")
	stream("Add --values to show whether each variable is currently set (values are never printed).")
	stream("")
	stream("list    — list harness environments (config, logins, sessions per env)")
	stream("which   — print the environment active for this invocation")
	stream("create  — create a new environment (use it with --env <name> or KIMCHI_ENV)")
}

/** The machine's default env — the legacy layout when it exists, else a fresh
 *  envs/default tree. Pure default resolution (ignores any active selection). */
function machineDefaultEnv(): ResolvedKimchiEnv {
	return resolveKimchiEnv({ rawArgv: [], env: {}, home: homedir() })
}

/** The env active for this invocation (entry.ts publishes it); falls back to
 *  the machine default when it has not been resolved (standalone use). */
function activeEnv(): ResolvedKimchiEnv {
	try {
		return readResolvedKimchiEnv()
	} catch {
		return machineDefaultEnv()
	}
}

function envLabel(env: ResolvedKimchiEnv): string {
	return env.legacyDefault ? `${env.name} (legacy layout)` : env.name
}

function listEnvironments(): number {
	const def = machineDefaultEnv()
	const active = activeEnv()
	const rows: Array<{ name: string; label: string; root: string; active: boolean }> = [
		{ name: def.name, label: envLabel(def), root: def.root, active: active.name === def.name },
	]
	try {
		const entries = readdirSync(envsBaseDir(), { withFileTypes: true })
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name === def.name) continue
			if (validateEnvName(entry.name) !== undefined) continue
			rows.push({
				name: entry.name,
				label: entry.name,
				root: join(envsBaseDir(), entry.name),
				active: active.name === entry.name,
			})
		}
	} catch {
		// No envs/ directory yet — the default env row is the whole list.
	}
	rows.sort((a, b) =>
		a.name === DEFAULT_ENV_NAME ? -1 : b.name === DEFAULT_ENV_NAME ? 1 : a.name.localeCompare(b.name),
	)

	console.log(bold("Harness environments"))
	console.log()
	const pad = Math.max(...rows.map((r) => r.label.length))
	for (const row of rows) {
		console.log(`  ${row.active ? "* " : "  "}${row.label.padEnd(pad)}  ${dim(row.root)}`)
	}
	console.log()
	console.log(dim(`Select one per invocation with --env <name> or KIMCHI_ENV.`))
	return 0
}

function whichEnvironment(): number {
	const active = activeEnv()
	console.log(envLabel(active))
	console.log(dim(active.root))
	return 0
}

function createEnvironment(args: string[]): number {
	const [name, ...extra] = args
	if (!name || extra.length > 0) {
		console.error("Usage: kimchi env create <name>")
		return 2
	}
	if (name === DEFAULT_ENV_NAME) {
		console.error(
			`kimchi env create: "${DEFAULT_ENV_NAME}" is reserved — the default env is the existing layout and cannot be created`,
		)
		return 2
	}
	const error = validateEnvName(name)
	if (error) {
		console.error(`kimchi env create: ${error}`)
		return 2
	}
	const root = join(envsBaseDir(), name)
	// lstat, not existsSync: a pre-planted symlink at envs/<name> must not
	// silently redirect the new env's whole state tree to its target.
	let rootLstat: { isSymbolicLink(): boolean; isDirectory(): boolean } | undefined
	try {
		rootLstat = lstatSync(root)
	} catch {
		// absent — the expected fresh case
	}
	if (rootLstat) {
		if (rootLstat.isSymbolicLink() || !rootLstat.isDirectory()) {
			console.error(`kimchi env create: ${root} already exists and is not a directory — refusing to create through it`)
			return 1
		}
		if (existsSync(join(root, "harness"))) {
			console.error(`kimchi env create: environment "${name}" already exists`)
			console.error(dim(root))
			return 1
		}
	}
	try {
		mkdirSync(join(root, "harness"), { recursive: true })
	} catch (err) {
		// e.g. a dangling symlink at envs/<name>/harness → EEXIST: a stack
		// trace crash is not a usable error for a state-tree command.
		console.error(`kimchi env create: cannot create ${join(root, "harness")}: ${(err as Error).message}`)
		return 1
	}
	console.log(`Created environment "${name}"`)
	console.log(dim(root))
	console.log(`Use it with: kimchi --env ${name}`)
	return 0
}

function listEnvVars(args: string[]): number {
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

export async function runEnv(args: string[]): Promise<number> {
	const [first, ...rest] = args
	switch (first) {
		case undefined:
		case "--values":
		case "--help":
		case "-h":
			return listEnvVars(args)
		case "vars":
			return listEnvVars(rest)
		case "list":
			return listEnvironments()
		case "which":
			return whichEnvironment()
		case "create":
			return createEnvironment(rest)
		default:
			// Flags keep the historical "unknown argument" error (they may carry
			// values, e.g. `kimchi env --bogus x`).
			if (first.startsWith("-")) return listEnvVars(args)
			console.error(`kimchi env: unknown subcommand "${first}"`)
			printUsage(console.error)
			return 1
	}
}
