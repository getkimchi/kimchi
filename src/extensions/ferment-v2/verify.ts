/**
 * verify.ts — the headless `/ferment-v2 --verify` entry.
 *
 * Runs the executing verifier on an objective file against a baseline
 * commit — transcript-free (no proposed answer, Todos, or previous gap) and
 * without creating or touching any ferment state — and writes a JSON report.
 * It exists so a benchmark harness (the L1 evaluator bench) can measure the
 * verifier on frozen cases: apply a patch, run `kimchi -p "/ferment-v2
 * --verify …"`, compare the report with the ground truth.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import {
	evaluateFermentV2,
	type FermentV2EvaluationResult,
	type FermentV2EvaluatorDiagnostics,
	type FermentV2VerifierCheck,
} from "./evaluator.js"
import type { FermentV2Baseline, FermentV2EvaluatorUsage } from "./types.js"
import type { IntegrityResult } from "./verifier-guard.js"
import type { FermentV2VerifierFacts } from "./verifier-prompt.js"
import { createGitRunner } from "./workspace.js"

export interface FermentV2VerifyRequest {
	objectiveFile: string
	out: string
	baseline?: string
}

export type FermentV2VerifyReport =
	| {
			schemaVersion: 1
			objectiveFile: string
			/** The resolved baseline commit; null when none could be resolved (outside git, unborn HEAD). */
			baseline: string | null
			verdict: FermentV2EvaluationResult["verdict"]
			reason: string
			checks: readonly FermentV2VerifierCheck[]
			model: string | null
			sameModelAsImplementer: boolean
			modelFallback: "session" | null
			usage: FermentV2EvaluatorUsage | null
			diagnostics: FermentV2EvaluatorDiagnostics
			facts: FermentV2VerifierFacts | null
			integrity: IntegrityResult | null
	  }
	| { schemaVersion: 1; objectiveFile: string; error: string }

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error)
}

function readObjectiveFile(path: string): string {
	let text: string
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path))
	} catch (error) {
		throw new Error(`Could not read objective file ${path}: ${errorMessage(error)}`)
	}
	if (!text.trim()) throw new Error(`Objective file ${path} is empty.`)
	return text
}

/**
 * Resolve the baseline commit: the given revision, or HEAD when none is
 * given. An explicit revision must name a commit; without one, a workspace
 * where HEAD does not resolve (outside git, unborn HEAD) runs without a
 * baseline and the verifier is told so.
 */
async function resolveBaseline(
	cwd: string,
	revision: string | undefined,
	signal: AbortSignal | undefined,
): Promise<FermentV2Baseline | undefined> {
	if (revision?.startsWith("-")) throw new Error(`--baseline ${revision} is not a revision.`)
	try {
		const commit = (
			await createGitRunner(cwd).run(["rev-parse", "--verify", "--quiet", `${revision ?? "HEAD"}^{commit}`], {
				signal,
			})
		).trim()
		if (commit) return { commit, capturedAt: new Date().toISOString() }
	} catch {
		// Falls through: an explicit revision is an error, a missing HEAD is not.
	}
	if (revision) throw new Error(`--baseline ${revision} does not name a commit.`)
	return undefined
}

function buildReport(
	objectiveFile: string,
	baseline: FermentV2Baseline | undefined,
	result: FermentV2EvaluationResult,
): FermentV2VerifyReport {
	return {
		schemaVersion: 1,
		objectiveFile,
		baseline: baseline?.commit ?? null,
		verdict: result.verdict,
		reason: result.reason,
		checks: result.verdict === "unavailable" ? [] : (result.checks ?? []),
		model: result.model ?? null,
		sameModelAsImplementer: result.sameModelAsImplementer === true,
		modelFallback: result.modelFallback ?? null,
		usage: result.usage ?? null,
		diagnostics: result.diagnostics,
		facts: result.facts ?? null,
		integrity: result.integrity ?? null,
	}
}

/**
 * Run the verifier for a `--verify` request and write its report to `out`
 * (resolved against the session cwd, parent directories created). Failures
 * before or around the run are written as an `error` report so a harness
 * can tell them from verdicts; a report that cannot be written throws.
 */
export async function runFermentV2Verify(
	request: FermentV2VerifyRequest,
	ctx: ExtensionContext,
	pi: ExtensionAPI,
): Promise<FermentV2VerifyReport> {
	const objectiveFile = resolve(ctx.cwd, request.objectiveFile)
	const out = resolve(ctx.cwd, request.out)
	let report: FermentV2VerifyReport
	try {
		const objective = readObjectiveFile(objectiveFile)
		const baseline = await resolveBaseline(ctx.cwd, request.baseline, ctx.signal)
		const result = await evaluateFermentV2(
			{
				objective,
				cwd: ctx.cwd,
				messages: [],
				todos: [],
				...(baseline ? { baseline } : {}),
				...(ctx.signal ? { signal: ctx.signal } : {}),
			},
			ctx,
			pi,
		)
		report = buildReport(objectiveFile, baseline, result)
	} catch (error) {
		report = { schemaVersion: 1, objectiveFile, error: errorMessage(error) }
	}
	mkdirSync(dirname(out), { recursive: true })
	writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, "utf-8")
	return report
}
