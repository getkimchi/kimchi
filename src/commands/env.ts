import { ENV_VARS, type EnvVarDef } from "../env-vars.js"

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
	return `set: ${redactUrlCredentials(raw)}`
}

/**
 * URL-valued variables (KIMCHI_PROXY, OLLAMA_HOST, endpoint overrides) can
 * embed basic-auth credentials in the userinfo part
 * (`http://[REDACTED-URL_WITH_CREDENTIALS]@proxy:8080`). Output is designed to be shared
 * (`kimchi env --values > out.txt`, CI logs, bug reports), so mask the
 * credentials while keeping host/port — the part that carries diagnostic
 * value. Non-URL values pass through unchanged.
 */
function redactUrlCredentials(raw: string): string {
	try {
		const url = new URL(raw)
		if (!url.username && !url.password) return raw
		// Keep protocol + host (the diagnostic part), mask credentials.
		return `${url.protocol}//${MASKED_VALUE}@${url.host}`
	} catch {
		return raw
	}
}

/**
 * `kimchi env` — list the supported, user-facing environment variables with
 * their descriptions. `--values` additionally prints each variable's current
 * state, masking secrets.
 *
 * Only ENV_VARS from the central registry (src/env-vars.ts) is printed;
 * IGNORED_ENV_VARS and TEST_SUITE_ENV_VARS hold internal/test plumbing that
 * stays registered (so the scan test still accounts for it) but never shows.
 */
const ACCEPTED_FLAGS = ["--help", "-h", "--values", "-v"] as const

function printUsage(stream: typeof console.log): void {
	stream("Usage: kimchi env [--values]")
	stream("")
	stream("List the supported environment variables.")
	stream("Add --values to show each variable's current state (secrets masked).")
}

export async function runEnv(args: string[]): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		printUsage(console.log)
		return 0
	}

	const unknown = args.filter((a) => !ACCEPTED_FLAGS.includes(a as (typeof ACCEPTED_FLAGS)[number]))
	if (unknown.length > 0) {
		console.error(`kimchi env: unknown argument: ${unknown.map((a) => `"${a}"`).join(", ")}`)
		printUsage(console.error)
		return 1
	}

	const showValues = args.includes("--values") || args.includes("-v")

	console.log(bold("Environment variables recognised by kimchi"))
	console.log()
	const pad = Math.max(...ENV_VARS.map((v) => v.name.length))
	for (const def of ENV_VARS) {
		console.log(`  ${def.name.padEnd(pad)}  ${def.description}`)
		if (showValues) {
			console.log(`  ${"".padEnd(pad)}  ${displayValue(def)}`)
		}
	}
	return 0
}
