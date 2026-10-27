import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { runAnalyze } from "./analyze.ts"
import { type RunConfig, writeJson } from "./config.ts"
import { runDryRun } from "./dry-run.ts"
import { runFetch } from "./fetch.ts"
import { findIssue, type IssueSnapshot } from "./github.ts"
import { runInternals } from "./internals.ts"
import { needsReport, runPublish } from "./publish.ts"
import { runRender } from "./render.ts"
import { runSettle, type SettleResult } from "./settle.ts"
import { inputsHash, parseState } from "./state.ts"
import { runTests } from "./tests.ts"

/** Steps between settle and publish, in order. Each reads what the previous ones wrote. */
export const PIPELINE = ["fetch", "dry-run", "internals", "tests", "analyze", "render"] as const

type StepFn = (cfg: RunConfig) => Promise<unknown>
export type PipelineSteps = Record<"settle" | (typeof PIPELINE)[number] | "publish", StepFn>

export const DEFAULT_STEPS: PipelineSteps = {
	settle: runSettle,
	fetch: runFetch,
	"dry-run": runDryRun,
	internals: runInternals,
	tests: (cfg) => runTests(cfg),
	analyze: runAnalyze,
	render: runRender,
	publish: runPublish,
}

/**
 * settle → (if a report is due) fetch … render → publish. A failing step is recorded as
 * `<step>.error.json` and the rest still run: render degrades on missing inputs, so a broken step
 * becomes part of the report instead of a silent red job.
 */
export async function runPipeline(cfg: RunConfig, steps: PipelineSteps, reportDue: () => boolean): Promise<void> {
	const settle = (await steps.settle(cfg)) as Pick<SettleResult, "target">
	if (settle.target && reportDue()) {
		for (const name of PIPELINE) {
			try {
				await steps[name](cfg)
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err)
				console.error(`[pi-upgrade] ${name} failed: ${message}`)
				writeJson(cfg, `${name}.error`, { message })
			}
		}
	}
	await steps.publish(cfg)
}

function tryFindIssue(): IssueSnapshot | null {
	try {
		return findIssue()
	} catch {
		return null
	}
}

export async function runAll(cfg: RunConfig): Promise<{ report: string | null }> {
	let due = false
	await runPipeline(cfg, DEFAULT_STEPS, () => {
		const settle = JSON.parse(readFileSync(join(cfg.outDir, "settle.json"), "utf8")) as SettleResult
		if (!settle.target) return false
		const issue = cfg.stateFile ? null : tryFindIssue()
		const state = parseState(cfg.stateFile ? readFileSync(cfg.stateFile, "utf8") : issue?.stateCommentBody)
		due = needsReport({
			issue,
			state,
			settle,
			inputsHash: inputsHash(cfg.repoRoot, settle.baseline, settle.target),
			now: cfg.now,
			forced: settle.forced,
		})
		if (!due) console.error("[pi-upgrade] issue is current: skipping the expensive steps")
		return due
	})
	const report = join(cfg.outDir, "report.md")
	// Only a report that was due must exist; quiet days (settling, current issue) are a green run.
	if (due && !existsSync(report)) throw new Error(`no report produced in ${cfg.outDir}`)
	return { report: due ? report : null }
}
