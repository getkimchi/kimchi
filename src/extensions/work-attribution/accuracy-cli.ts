import { readFileSync, realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { type AttributionAccuracyResult, type AttributionLabel, compareAttributionAccuracy } from "./accuracy.js"
import { compareIndependentAttribution, isAttributionReference } from "./accuracy-reference.js"
import type { RequestCostAllocation } from "./costs.js"
import { object } from "./summary.js"

/** Everything the script entry needs to print and exit; runCli itself performs no process I/O. */
export interface CliOutcome {
	code: 0 | 1 | 2 | 3
	stdout: string[]
	stderr: string[]
}

const USAGE = "Usage: pnpm exec tsx src/extensions/work-attribution/accuracy-cli.ts <report.json> <labels.json>"
const OVERLAP_NOTE =
	"Wrong assignment divides wrong spending by assigned spending. Correct coverage divides correct spending by spending expected on a PR."
const INCOMPLETE_NOTE = "Percentages: full percentages unavailable (comparison incomplete)"

function readJson(path: string): { ok: true; value: unknown } | { ok: false; message: string } {
	let raw: string
	try {
		raw = readFileSync(path, "utf8")
	} catch (error) {
		return { ok: false, message: `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}` }
	}
	try {
		return { ok: true, value: JSON.parse(raw) as unknown }
	} catch (error) {
		return { ok: false, message: `Cannot parse ${path}: ${error instanceof Error ? error.message : String(error)}` }
	}
}

function rejected(message: string): CliOutcome {
	return { code: 1, stdout: [], stderr: [message] }
}

function metricLines(result: AttributionAccuracyResult, complete: boolean): string[] {
	if (!complete) return [INCOMPLETE_NOTE]
	return (
		[
			["Correct coverage", "correctCoveragePercent"],
			["Wrong assignment", "wrongAssignmentPercent"],
		] as const
	).map(([name, metric]) => {
		const dollars = result.metrics[metric]
		const requests = result.requestMetrics[metric]
		return `${name}: ${dollars === null ? "n/a (zero spending denominator)" : `${dollars}% of spending`}; ${requests === null ? "n/a (zero request denominator)" : `${requests}% of requests`}`
	})
}

/** Validate the two file arguments, run the comparison and render the summary; never touches process or console. */
export function runCli(argv: readonly string[]): CliOutcome {
	if (argv.length !== 2) return rejected(USAGE)
	const [reportPath, labelsPath] = argv

	const report = readJson(reportPath)
	if (!report.ok) return rejected(report.message)
	if (!object(report.value) || !Array.isArray(report.value.requests))
		return rejected(`Invalid report ${reportPath}: expected a non-null, non-array object with a "requests" array`)

	const labels = readJson(labelsPath)
	if (!labels.ok) return rejected(labels.message)
	if (!Array.isArray(labels.value) && !isAttributionReference(labels.value))
		return rejected(`Invalid reference ${labelsPath}: expected a version 1 reference or an array of attribution labels`)
	const referenceRequests = Array.isArray(labels.value) ? labels.value : labels.value.requests
	if (report.value.requests.length === 0 && referenceRequests.length === 0)
		return {
			code: 2,
			stdout: ["Work-attribution accuracy comparison", "Incomplete — no requests to compare"],
			stderr: [],
		}

	if (isAttributionReference(labels.value)) {
		const result = compareIndependentAttribution(
			{
				requests: report.value.requests as RequestCostAllocation[],
				pullRequests: report.value.pullRequests,
				unallocated: report.value.unallocated,
			},
			labels.value,
		)
		const stdout = [
			"Work-attribution accuracy comparison",
			`Independent reference: ${result.referenceRequests} requests; ${result.referenceKnownCostUsd} known USD`,
			`Coverage: ${result.comparison.coverage.labelledRequests}/${result.comparison.coverage.reportRequests} observed requests labelled; ${result.comparison.coverage.pricedRequests} priced`,
			...result.pullRequests.map(
				(pr) =>
					`PR ${pr.key} [${pr.account.apiUrl}; organization ${pr.account.organizationId}; user ${pr.account.userId}]: reported ${pr.reportedCostUsd} USD; expected ${pr.expectedCostUsd === null ? "unknown" : `${pr.expectedCostUsd} USD`}; error ${pr.errorUsd === null ? "unknown" : `${pr.errorUsd} USD`}`,
			),
			`Sum of absolute PR errors: ${result.sumAbsolutePullRequestErrorUsd === null ? "unavailable (comparison incomplete)" : `${result.sumAbsolutePullRequestErrorUsd} USD`}`,
			...metricLines(result.comparison, result.complete),
			...result.problems
				.concat(result.differences)
				.map((problem) => `[${problem.kind}] ${problem.requestId ?? "report"}: ${problem.detail}`),
			!result.complete
				? "Incomplete"
				: result.matches
					? "Complete; report matches the independent reference"
					: "Complete comparison; report differs from the independent reference",
		]
		return { code: !result.complete ? 2 : result.matches ? 0 : 3, stdout, stderr: [] }
	}

	const result = compareAttributionAccuracy(
		report.value.requests as RequestCostAllocation[],
		labels.value as AttributionLabel[],
	)

	const stdout: string[] = [
		"Work-attribution accuracy comparison",
		"Label-only comparison: accounts, prices and aggregate totals are not independently checked.",
	]
	for (const [name, bucket] of [
		["Reference", result.reference],
		["Correct", result.correct],
		["Wrong", result.wrong],
		["Missed", result.missed],
	] as const)
		stdout.push(`${name}: ${bucket.knownCostUsd} USD (${bucket.requestIds.length} requests)`)

	const coverage = result.coverage
	stdout.push(
		`Coverage: ${coverage.labelledRequests}/${coverage.reportRequests} labelled, ${coverage.pricedRequests}/${coverage.reportRequests} priced, ${coverage.scoredRequests}/${coverage.reportRequests} scored requests`,
		`Scored spending: ${coverage.scoredKnownCostUsd} of ${coverage.reportKnownCostUsd} known USD; ${coverage.unpricedRequestIds.length} requests have unknown prices`,
	)
	stdout.push(...metricLines(result, result.complete))

	stdout.push(OVERLAP_NOTE)

	if (result.problems.length > 0) {
		stdout.push(`Problems (${result.problems.length}):`)
		result.problems.forEach((problem, index) => {
			stdout.push(`${index + 1}. [${problem.kind}] ${problem.requestId ?? "(no request id)"}: ${problem.detail}`)
		})
	}

	const matches = result.wrong.requestIds.length === 0 && result.missed.requestIds.length === 0
	stdout.push(
		result.complete
			? `Complete comparison; assignments ${matches ? "match" : "differ from"} labels`
			: `Incomplete — ${result.problems.length} problems; full percentages unavailable`,
	)
	return { code: !result.complete ? 2 : matches ? 0 : 3, stdout, stderr: [] }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const outcome = runCli(process.argv.slice(2))
	for (const line of outcome.stdout) console.log(line)
	for (const line of outcome.stderr) console.error(line)
	process.exitCode = outcome.code
}
