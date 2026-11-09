import { ENV_VARS, type EnvVarDef } from "../env-vars.js"

// Keep piped output (`kimchi env > out.txt`, CI logs) free of escape codes.
// Computed per call: a long-lived process may see NO_COLOR change after
// import, and tests drive isTTY/NO_COLOR directly.
function colorEnabled(): boolean {
	return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR
}

function bold(text: string): string {
	return colorEnabled() ? `\x1b[1m${text}\x1b[0m` : text
}

function dim(text: string): string {
	return colorEnabled() ? `\x1b[2m${text}\x1b[0m` : text
}

const MASKED_VALUE = "****"
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
	// An explicitly empty value is effectively unset — never render it as a
	// masked secret, which would imply a real credential is configured.
	if (raw === undefined || raw === "") return dim(NOT_SET)
	if (def.secret) return `set: ${MASKED_VALUE}`
	return `set: ${sanitizeValue(redactUrlCredentials(raw))}`
}

// Values land in terminals and pasted bug reports: drop control characters
// (ESC byte of ANSI sequences, DEL, C0) and collapse any stray newline so a
// value can never inject escape codes or forge extra output lines (e.g. a
// fake `set: ****` row).
function sanitizeValue(value: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
	return value.replace(/[\x00-\x1f\x7f]+/g, " ").trim()
}

/**
 * URL-valued variables (KIMCHI_PROXY, OLLAMA_HOST, endpoint overrides) can
 * embed basic-auth credentials in the userinfo part
 * (`http://[REDACTED-URL_WITH_CREDENTIALS]@proxy:8080`). Output is designed to be shared
 * (`kimchi env --values > out.txt`, CI logs, bug reports), so mask the
 * credentials while keeping host/port/path — the part that carries
 * diagnostic value. Non-URL values pass through unchanged.
 */
function redactUrlCredentials(raw: string): string {
	try {
		const url = new URL(raw)
		if (url.username || url.password) {
			// Keep protocol + host + path/query (the diagnostic part), mask credentials.
			const path = url.pathname === "/" ? "" : url.pathname
			return `${url.protocol}//${MASKED_VALUE}@${url.host}${path}${url.search}`
		}
	} catch {
		// Not a parseable URL — the scheme-less userinfo fallback below applies.
	}
	// Scheme-less proxy syntax (`user:pw@host:8080`) is common in the wild;
	// mask anything userinfo-shaped so it can never print in the clear.
	return raw.replace(/(^|\/\/)[^/@\s:]+(:[^/@\s]*)?@/, `$1${MASKED_VALUE}@`)
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

	const showValues = args.includes("--values") || args.includes("-v")

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
