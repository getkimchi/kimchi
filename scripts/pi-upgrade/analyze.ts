import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { type RunConfig, writeJson } from "./config.ts"
import { loadState } from "./github.ts"
import type { AnalysisFile } from "./schemas.ts"

/** Repo holding this script (the kimchi checkout that runs the workflow), not necessarily `--repo`. */
const KIMCHI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")
const WORKFLOW = join(KIMCHI_ROOT, "scripts/pi-upgrade/pi-upgrade.workflow.ts")
const TIMEOUT_MS = 45 * 60 * 1000

/**
 * Print mode swallows `/workflow run` errors (they go to ctx.ui.notify), so on a missing result ask
 * the host loader directly why the file would not load — usually a strict-TS validation error.
 */
async function diagnoseLoad(cwd: string): Promise<string | null> {
	process.env.PI_PACKAGE_DIR ??= KIMCHI_ROOT
	try {
		const { resolveWorkflow } = await import("@kimchi-dev/kimchi-workflows/host")
		const resolution = await resolveWorkflow(cwd, WORKFLOW)
		return resolution.ok ? null : resolution.error
	} catch (err) {
		return err instanceof Error ? err.message : String(err)
	}
}

/** Runs the AI workflow headless; on any failure writes `{ unavailable, reason }` so render still works. */
export async function runAnalyze(cfg: RunConfig): Promise<AnalysisFile> {
	writeJson(
		cfg,
		"state",
		loadState(cfg.stateFile, (p) => readFileSync(p, "utf8")),
	)
	const out = join(cfg.outDir, "analysis.json")
	rmSync(out, { force: true })

	const result = spawnSync(
		"bun",
		[
			"run",
			"--preload",
			join(KIMCHI_ROOT, "src/set-package-dir.ts"),
			join(KIMCHI_ROOT, "src/entry.ts"),
			"-p",
			`/workflow run ${WORKFLOW}`,
		],
		{
			cwd: cfg.repoRoot,
			env: { ...process.env, PI_UPGRADE_OUT_DIR: cfg.outDir },
			stdio: ["ignore", "inherit", "inherit"],
			timeout: TIMEOUT_MS,
		},
	)

	let analysis: AnalysisFile
	if (existsSync(out)) {
		analysis = JSON.parse(readFileSync(out, "utf8"))
	} else {
		const why = result.error?.message ?? (result.signal ? `killed by ${result.signal}` : `exit ${result.status}`)
		const loadError = await diagnoseLoad(cfg.repoRoot)
		analysis = {
			unavailable: true,
			reason: `analysis workflow produced no result (${why})${loadError ? `: ${loadError}` : ""}`,
		}
		console.error(analysis.reason)
		writeJson(cfg, "analysis", analysis)
	}
	return analysis
}
