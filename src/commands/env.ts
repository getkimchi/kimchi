import { ENV_VARS, type EnvVarDef, IGNORED_ENV_VARS, TEST_SUITE_ENV_VARS } from "../env-vars.js"

// Keep piped output (`kimchi env > out.txt`, CI logs) free of escape codes.
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR

function bold(text: string): string {
	return COLOR ? `\x1b[1m${text}\x1b[0m` : text
}

function dim(text: string): string {
	return COLOR ? `\x1b[2m${text}\x1b[0m` : text
}

const MASKED_VALUE = "****"
const NOT_SET = "(not set)"

function displayValue(def: EnvVarDef): string {
	const raw = process.env[def.name]
	// An explicitly empty value is effectively unset — never render it as a
	// masked secret, which would imply a real credential is configured.
	if (raw === undefined || raw === "") return dim(NOT_SET)
	if (def.secret) return `set: ${MASKED_VALUE}`
	return `set: ${raw}`
}

/**
 * `kimchi env` — list the supported, user-facing environment variables with
 * their current set/unset state. Secret values are masked.
 *
 * Only ENV_VARS from the central registry (src/env-vars.ts) is printed;
 * IGNORED_ENV_VARS and TEST_SUITE_ENV_VARS hold internal/test plumbing that
 * stays registered (so the scan test still accounts for it) but never shows.
 */
export async function runEnv(args: string[]): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		console.log("Usage: kimchi env")
		console.log()
		console.log("List the supported environment variables with their current values (secrets masked).")
		return 0
	}

	console.log(bold("Environment variables recognised by kimchi"))
	console.log()
	const pad = Math.max(...ENV_VARS.map((v) => v.name.length))
	for (const def of ENV_VARS) {
		console.log(`  ${def.name.padEnd(pad)}  ${def.description}`)
		console.log(`  ${"".padEnd(pad)}  ${displayValue(def)}`)
	}
	console.log()
	const hidden = IGNORED_ENV_VARS.length + TEST_SUITE_ENV_VARS.length
	console.log(dim(`(${hidden} internal/dev variables exist for tests and workflows; they are not listed.)`))
	return 0
}
