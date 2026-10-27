#!/usr/bin/env node
/**
 * Pi upgrade trigger: each subcommand is one pipeline step; steps exchange JSON files in the
 * output dir, so any step can be re-run alone. See docs/pi-upgrade-trigger.md.
 */
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import { runAnalyze } from "./analyze.ts"
import { ALL_SUITES, LOCAL_DEFAULT_SUITES, type RunConfig, readBaseline, type Suite } from "./config.ts"
import { runDryRun } from "./dry-run.ts"
import { runFetch } from "./fetch.ts"
import { runInternals } from "./internals.ts"
import { runSettle } from "./settle.ts"
import { runTests } from "./tests.ts"

const USAGE = `usage: pnpm pi-upgrade <step> [options]

steps: settle, fetch, dry-run, internals, tests, analyze

options:
  --repo <dir>        checkout to analyse (default: current repo)
  --baseline <ver>    override the pinned Pi version
  --target <ver>      force a target version (skips the settle rule; never edits the issue)
  --out <dir>         output dir (default: <repo>/.kimchi/pi-upgrade/<target>)
  --suites <a,b|all>  test suites (default locally: ${LOCAL_DEFAULT_SUITES.join(",")})
  --publish           write to the GitHub issue (off by default)
  --state <file>      read issue state from a local file instead of GitHub`

type Step = (cfg: RunConfig) => Promise<unknown>

const STEPS: Record<string, Step> = {
	settle: runSettle,
	fetch: runFetch,
	"dry-run": runDryRun,
	internals: runInternals,
	tests: (cfg) => runTests(cfg),
	analyze: runAnalyze,
}

function parseSuites(value: string | undefined): Suite[] {
	if (!value) return LOCAL_DEFAULT_SUITES
	if (value === "all") return ALL_SUITES
	const suites = value.split(",").map((s) => s.trim())
	for (const s of suites) {
		if (!ALL_SUITES.includes(s as Suite)) throw new Error(`unknown suite "${s}" (known: ${ALL_SUITES.join(", ")})`)
	}
	return suites as Suite[]
}

export function buildConfig(argv: string[]): { step: string; cfg: RunConfig } {
	const { values, positionals } = parseArgs({
		args: argv,
		allowPositionals: true,
		options: {
			repo: { type: "string" },
			baseline: { type: "string" },
			target: { type: "string" },
			out: { type: "string" },
			suites: { type: "string" },
			publish: { type: "boolean", default: false },
			state: { type: "string" },
		},
	})
	const step = positionals[0] ?? ""
	const repoRoot = resolve(values.repo ?? process.cwd())
	const baseline = values.baseline ?? readBaseline(repoRoot)
	const target = values.target ?? null
	return {
		step,
		cfg: {
			repoRoot,
			outDir: resolve(values.out ?? resolve(repoRoot, ".kimchi/pi-upgrade", target ?? "latest")),
			baseline,
			target,
			now: new Date(),
			suites: parseSuites(values.suites),
			publish: values.publish ?? false,
			stateFile: values.state,
			forced: target !== null,
		},
	}
}

async function main(): Promise<void> {
	const { step, cfg } = buildConfig(process.argv.slice(2))
	const run = STEPS[step]
	if (!run) {
		console.error(USAGE)
		process.exit(2)
	}
	const result = await run(cfg)
	console.log(JSON.stringify(result, null, 2))
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : err)
	process.exit(1)
})
