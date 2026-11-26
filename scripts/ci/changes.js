// Decides which CI suites a change needs. One place for the rules that the
// separate workflows used to copy into their own `paths-ignore` lists.
//
// Usage in CI: node scripts/ci/changes.js <base> <head>   (only the diff decides)
//              node scripts/ci/changes.js --all           (every suite runs)
// Writes `<suite>=true|false` lines to $GITHUB_OUTPUT and to stdout.
import { execFileSync } from "node:child_process"
import { appendFileSync } from "node:fs"
import { matchesGlob } from "node:path"
import { fileURLToPath } from "node:url"

// Files that never change what kimchi does. Only root and .github markdown:
// *.md under src/ and resources/ ships in the binary.
const NOT_CODE = [
	"docs/**",
	"*.md",
	".github/**/*.md",
	".github/ISSUE_TEMPLATE/**",
	"LICENSE",
	"NOTICE",
	"kimchi.png",
	"benchmark/**",
	"docker/**",
	"test-cases/**",
]

// Per suite: files that suite does not need to see. A suite runs when at
// least one changed file is outside its list.
export const SUITE_IGNORES = {
	tui: [...NOT_CODE, "src/**/*.test.ts", "tests/unit/**", "tests/smoke/**", "tests/e2e/acp/**", "tests/e2e/mcp/**"],
	// ACP fixtures import tests/e2e/tui/support/, so only the TUI test files are ignored.
	acp: [
		...NOT_CODE,
		"src/**/*.test.ts",
		"tests/unit/**",
		"tests/smoke/**",
		"tests/e2e/tui/*.test.ts",
		"tests/e2e/mcp/**",
	],
	// The conformance client imports TUI and ACP support code, so only their test files are ignored.
	mcp: [
		...NOT_CODE,
		"src/**/*.test.ts",
		"tests/unit/**",
		"tests/smoke/**",
		"tests/e2e/tui/*.test.ts",
		"tests/e2e/acp/*.test.ts",
	],
}

export function suitesToRun(changedFiles) {
	return Object.fromEntries(
		Object.entries(SUITE_IGNORES).map(([suite, ignores]) => [
			suite,
			changedFiles.some((file) => !ignores.some((glob) => matchesGlob(file, glob))),
		]),
	)
}

function changedFiles(base, head) {
	const output = execFileSync("git", ["diff", "--name-only", base, head], { encoding: "utf8" })
	return output.split("\n").filter(Boolean)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const [base, head] = process.argv.slice(2)
	let result
	if (base === "--all") {
		result = Object.fromEntries(Object.keys(SUITE_IGNORES).map((suite) => [suite, true]))
	} else if (base && head) {
		const files = changedFiles(base, head)
		console.log(`${files.length} changed file(s)`)
		result = suitesToRun(files)
	} else {
		console.error("usage: node scripts/ci/changes.js <base> <head> | --all")
		process.exit(2)
	}
	const lines = Object.entries(result).map(([suite, run]) => `${suite}=${run}`)
	for (const line of lines) console.log(line)
	if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`)
}
