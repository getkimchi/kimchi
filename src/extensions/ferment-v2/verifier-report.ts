/**
 * verifier-report.ts — the Ferment V2 verifier's report tools.
 *
 * The verifier reports through host-bound tools instead of a final JSON
 * object, so a malformed report is rejected while the session can still fix
 * it:
 *
 * - `report_finding` records an objective violation as soon as it is
 *   observed, citing executed `[eN]` evidence; findings survive a session
 *   that later fails or is retried;
 * - `retract_finding` withdraws a finding whose expectation proved wrong,
 *   keeping it (and the reason) in the record;
 * - `submit_verdict` ends the review. `continue`/`impossible` need an active
 *   finding; `met` needs none.
 *
 * - `resolve_finding` settles each finding an earlier review left open, given
 *   the implementer's response (fixed, or disputed with evidence): fixed or
 *   still failing (both need a re-run), dispute accepted or rejected. A
 *   finding still failing, or whose dispute is rejected, stays active under
 *   its ID; nothing closes by omission, so `submit_verdict` waits until every
 *   open finding is resolved.
 *
 * Only findings block completion.
 */

import { readFileSync } from "node:fs"
import { isAbsolute, relative, resolve } from "node:path"
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import type { FermentV2EvaluatorVerdict } from "./evaluator.js"
import type { VerifierEvidence } from "./verifier-guard.js"
import { isTestFilePath } from "./workspace.js"

export const REPORT_FINDING_TOOL = "report_finding"
export const RETRACT_FINDING_TOOL = "retract_finding"
export const SUBMIT_VERDICT_TOOL = "submit_verdict"
export const RESOLVE_FINDING_TOOL = "resolve_finding"

/** Report tools are metadata about the review, never evidence; the guard does not stamp them. */
export const VERIFIER_REPORT_TOOLS: readonly string[] = [
	REPORT_FINDING_TOOL,
	RETRACT_FINDING_TOOL,
	SUBMIT_VERDICT_TOOL,
	RESOLVE_FINDING_TOOL,
]

export interface VerifierFinding {
	id: string
	/** The verifier session attempt (transport retries start a new one) that recorded it. */
	attempt: number
	/** The objective clause the observation violates. */
	clause: string
	evidence: readonly string[]
	observed: string
	expected: string
	why: string
	status: "active" | "retracted"
	retractReason?: string
	/** Carried from an earlier review (still failing, or its dispute rejected). */
	carried?: true
}

/** The implementer's answer to an open finding. */
export interface FindingResponse {
	status: "fixed" | "disputed"
	/** What the implementer verified, or the objective text / repository evidence behind a dispute. */
	evidence: string
}

/** A finding an earlier review left open, as the next review receives it. */
export interface OpenFinding {
	id: string
	clause: string
	observed: string
	expected: string
	why: string
	response?: FindingResponse
	/** Disputes of this finding earlier reviews already rejected. */
	disputesRejected?: number
	/** Working-tree snapshot tree when a review last observed this finding open; `fixed` needs a different tree. */
	observedTree?: string
}

export const FINDING_RESOLUTIONS = ["fixed", "still_failing", "dispute_accepted", "dispute_rejected"] as const

export interface FindingResolution {
	id: string
	resolution: (typeof FINDING_RESOLUTIONS)[number]
	evidence: readonly string[]
	reason: string
	/** For dispute_accepted: the quoted passage that contradicts the finding, and where it comes from. */
	quote?: { source: "objective" | "repository" | "specification"; text: string; path?: string }
}

/** An exact-output requirement the host compares literally against the proposed final answer. */
export interface FinalAnswerCheck {
	clause: string
	/** The required literal answer, or null when only the format is constrained. */
	expected: string | null
}

export interface VerifierSubmission {
	verdict: FermentV2EvaluatorVerdict
	summary: string
	finalAnswer: readonly FinalAnswerCheck[]
}

export interface VerifierReportOptions {
	/** The guard's live evidence ledger; findings may cite only IDs in it. */
	evidence: ReadonlyMap<string, VerifierEvidence>
	/** Findings earlier reviews left open; every one must be resolved before submitting. */
	openFindings?: readonly OpenFinding[]
	/** The objective text an accepted dispute's objective quote must appear in. */
	objective?: string
	/** The repository root an accepted dispute's repository quote is checked against. */
	cwd?: string
	/** This review's working-tree snapshot tree, compared with each open finding's `observedTree`. */
	currentTree?: string
}

export interface VerifierReport {
	extension: InlineExtension
	/** Starts a new verifier session attempt; carried findings keep their original attempt. */
	beginAttempt(): number
	attempt(): number
	findings(): readonly VerifierFinding[]
	activeFindings(): readonly VerifierFinding[]
	resolutions(): readonly FindingResolution[]
	submission(): VerifierSubmission | undefined
	isSubmitted(): boolean
}

const MAX_FIELD_CHARS = 2_000
const EVIDENCE_REFERENCE = /^\[?(e\d+)\]?$/i

const text = (description: string) => Type.String({ minLength: 1, maxLength: MAX_FIELD_CHARS, description })

const reportFindingParameters = Type.Object({
	clause: text("The objective clause (quoted or closely paraphrased) the observation violates."),
	evidence: Type.Array(Type.String(), {
		minItems: 1,
		description: 'The [eN] IDs of the executed tool results that show the failure, for example ["e12"].',
	}),
	observed: text("What actually happened."),
	expected: text("What the objective requires, and where that expectation comes from."),
	why: text("Why the observation violates the clause."),
})

const retractFindingParameters = Type.Object({
	id: Type.String({ description: "The finding ID, for example F2." }),
	reason: text("Why the finding is wrong, for example a corrected expectation and its source."),
})

const resolveFindingParameters = Type.Object({
	id: Type.String({ description: "The open finding's ID, for example F3." }),
	resolution: Type.Union([
		Type.Literal("fixed"),
		Type.Literal("still_failing"),
		Type.Literal("dispute_accepted"),
		Type.Literal("dispute_rejected"),
	]),
	evidence: Type.Array(Type.String(), {
		description:
			"The [eN] IDs of the executed re-check; required for fixed and still_failing, and for dispute_rejected when you re-ran the check.",
	}),
	observed: Type.Optional(
		Type.String({ maxLength: MAX_FIELD_CHARS, description: "For still_failing: what the re-check observed now." }),
	),
	reproduction: Type.Optional(
		Type.String({
			maxLength: MAX_FIELD_CHARS,
			description:
				"For fixed: the finding's failing input exactly as your re-check ran it (the expression, arguments, or data), copied from the cited command, its output, or the probe file you wrote.",
		}),
	),
	reason: text(
		"Why: for dispute_accepted, how the quoted passage shows the expectation was wrong or out of scope; for dispute_rejected, why the response does not answer the finding.",
	),
	source: Type.Optional(
		Type.Union([Type.Literal("objective"), Type.Literal("repository"), Type.Literal("specification")], {
			description: "For dispute_accepted: where the quoted passage comes from.",
		}),
	),
	quote: Type.Optional(
		Type.String({
			maxLength: MAX_FIELD_CHARS,
			description: "For dispute_accepted: the exact passage that contradicts the finding's expectation.",
		}),
	),
	path: Type.Optional(
		Type.String({
			description:
				"For dispute_accepted with source repository: the file the quote is in, relative to the repository root.",
		}),
	),
})

const submitVerdictParameters = Type.Object({
	verdict: Type.Union([Type.Literal("met"), Type.Literal("continue"), Type.Literal("impossible")]),
	summary: Type.String({ maxLength: MAX_FIELD_CHARS, description: "A short task-facing summary of the review." }),
	finalAnswer: Type.Optional(
		Type.Array(
			Type.Object({
				clause: text("The objective clause that prescribes the text of the implementer's final reply."),
				expected: Type.Union([Type.String(), Type.Null()], {
					description: "The required literal answer, or null when only the format is constrained.",
				}),
			}),
			{
				description:
					"Only for objectives that prescribe the implementer's final reply text; the host compares the proposed final answer literally. Never for program output, error messages, or file contents.",
			},
		),
	),
})

function result(message: string) {
	return { content: [{ type: "text" as const, text: message }], details: undefined }
}

/** Tool results that execute something; a `fixed` resolution must cite at least one. */
const EXECUTED_TOOLS = new Set(["bash", "bash_control"])
/** Tool results whose input or output can hold the reproduction: executions and the probe files written for them. */
const REPRODUCTION_TOOLS = new Set([...EXECUTED_TOOLS, "write", "edit"])
const MIN_REPRODUCTION_CHARS = 4

function squash(text: string): string {
	return text.replace(/\s+/g, " ").trim()
}

function evidenceText(entry: VerifierEvidence): string {
	const strings: string[] = [entry.excerpt]
	const collect = (value: unknown) => {
		if (typeof value === "string") strings.push(value)
		else if (Array.isArray(value)) value.forEach(collect)
		else if (value && typeof value === "object") Object.values(value).forEach(collect)
	}
	collect(entry.input)
	return squash(strings.join("\n"))
}

/**
 * A `fixed` resolution must rest on a re-check of the finding itself: at
 * least one cited result executed something, and the quoted reproduction
 * appears in a cited execution (command or output) or in a probe file the
 * verifier wrote or edited. Reading the code is not a re-check.
 */
export function fixedEvidenceProblem(
	findingId: string,
	reproduction: string | undefined,
	ids: readonly string[],
	evidence: ReadonlyMap<string, VerifierEvidence>,
): string | undefined {
	const cited = ids.map((id) => evidence.get(id)).filter((entry): entry is VerifierEvidence => entry !== undefined)
	if (!cited.some((entry) => EXECUTED_TOOLS.has(entry.toolName))) {
		return `fixed needs the [eN] of an executed re-check of ${findingId} (a command you ran), not only reads.`
	}
	const quoted = squash(reproduction ?? "")
	if (quoted.length < MIN_REPRODUCTION_CHARS) {
		return `fixed needs reproduction: ${findingId}'s failing input exactly as your re-check ran it.`
	}
	const found = cited.some((entry) => REPRODUCTION_TOOLS.has(entry.toolName) && evidenceText(entry).includes(quoted))
	if (!found) {
		return `the reproduction "${quoted.slice(0, 120)}" does not appear in any cited command, its output, or a probe file you wrote. Re-run ${findingId}'s own failing input and cite that run.`
	}
	return undefined
}

function normalizeEvidence(references: readonly string[]): { ids: string[]; invalid: string[] } {
	const ids: string[] = []
	const invalid: string[] = []
	for (const reference of references) {
		const match = reference.trim().match(EVIDENCE_REFERENCE)
		if (match) ids.push(match[1].toLowerCase())
		else invalid.push(reference)
	}
	return { ids, invalid }
}

/** Creates the report tools for one review; state spans every session attempt of that review. */
export function createVerifierReport(options: VerifierReportOptions): VerifierReport {
	const findings: VerifierFinding[] = []
	const resolutions: FindingResolution[] = []
	const open = options.openFindings ?? []
	let submission: VerifierSubmission | undefined
	let attempt = 0
	// New findings continue the numbering of the ones earlier reviews opened.
	let nextFindingId = 1 + open.reduce((max, finding) => Math.max(max, Number(finding.id.replace(/^F/i, "")) || 0), 0)
	const unresolved = () => open.filter((finding) => !resolutions.some((resolution) => resolution.id === finding.id))

	const active = () => findings.filter((finding) => finding.status === "active")
	const findActive = (id: string) =>
		findings.find((finding) => finding.status === "active" && finding.id.toLowerCase() === id.trim().toLowerCase())

	const extension: InlineExtension = (pi) => {
		pi.registerTool(
			defineTool({
				name: REPORT_FINDING_TOOL,
				// Sequential: a finding batched with submit_verdict must be recorded before the verdict is checked.
				executionMode: "sequential",
				label: "Report Finding",
				description:
					"Record an objective violation as soon as you observe it, citing the [eN] IDs of the executed tool results that show it. Findings block completion until retracted.",
				parameters: reportFindingParameters,
				execute: async (_toolCallId, params) => {
					if (submission) return result("Rejected: the verdict was already submitted.")
					const { ids, invalid } = normalizeEvidence(params.evidence)
					const unknown = ids.filter((id) => !options.evidence.has(id))
					if (invalid.length || unknown.length || !ids.length) {
						return result(
							`Rejected: cite only [eN] IDs stamped on your executed tool results${
								[...invalid, ...unknown].length ? ` (not found: ${[...invalid, ...unknown].join(", ")})` : ""
							}. Run the check first if it has not executed.`,
						)
					}
					const finding: VerifierFinding = {
						id: `F${nextFindingId++}`,
						attempt,
						clause: params.clause.trim(),
						evidence: [...new Set(ids)],
						observed: params.observed.trim(),
						expected: params.expected.trim(),
						why: params.why.trim(),
						status: "active",
					}
					findings.push(finding)
					return result(`Recorded finding ${finding.id}.`)
				},
			}),
		)
		pi.registerTool(
			defineTool({
				name: RETRACT_FINDING_TOOL,
				executionMode: "sequential",
				label: "Retract Finding",
				description:
					"Withdraw a finding whose expectation proved wrong. The finding and your reason stay in the record.",
				parameters: retractFindingParameters,
				execute: async (_toolCallId, params) => {
					if (submission) return result("Rejected: the verdict was already submitted.")
					const finding = findActive(params.id)
					if (!finding) return result(`Rejected: no active finding ${params.id}.`)
					if (finding.carried) {
						return result(
							`Rejected: ${finding.id} was carried from an earlier review and cannot be retracted. Leave it open and submit continue instead of met.`,
						)
					}
					finding.status = "retracted"
					finding.retractReason = params.reason.trim()
					return result(`Retracted finding ${finding.id}.`)
				},
			}),
		)
		if (open.length) {
			pi.registerTool(
				defineTool({
					name: RESOLVE_FINDING_TOOL,
					executionMode: "sequential",
					label: "Resolve Finding",
					description:
						"Settle a finding an earlier review left open: fixed or still_failing after re-running its check, or, for a disputed finding, dispute_accepted or dispute_rejected. Every open finding must be resolved before submit_verdict.",
					parameters: resolveFindingParameters,
					execute: async (_toolCallId, params) => {
						if (submission) return result("Rejected: the verdict was already submitted.")
						const finding = open.find((candidate) => candidate.id.toLowerCase() === params.id.trim().toLowerCase())
						if (!finding) return result(`Rejected: no open finding ${params.id}.`)
						if (resolutions.some((resolution) => resolution.id === finding.id)) {
							return result(`Rejected: ${finding.id} is already resolved.`)
						}
						const disputed = finding.response?.status === "disputed"
						if (params.resolution.startsWith("dispute_") && !disputed) {
							return result(`Rejected: ${finding.id} was not disputed; resolve it as fixed or still_failing.`)
						}
						const { ids, invalid } = normalizeEvidence(params.evidence)
						const unknown = ids.filter((id) => !options.evidence.has(id))
						if (invalid.length || unknown.length) {
							return result(
								`Rejected: cite only [eN] IDs stamped on your executed tool results (not found: ${[...invalid, ...unknown].join(", ")}).`,
							)
						}
						if (
							params.resolution === "fixed" &&
							finding.observedTree !== undefined &&
							options.currentTree !== undefined &&
							finding.observedTree === options.currentTree
						) {
							return result(
								`Rejected: the code has not changed since ${finding.id} was last observed failing, so it cannot be fixed. Resolve it as still_failing${disputed ? ", or settle the dispute" : ""}; if its expectation was wrong, say so with dispute evidence only when the implementer disputed it.`,
							)
						}
						const needsCheck = params.resolution === "fixed" || params.resolution === "still_failing"
						if (needsCheck && !ids.length) {
							return result(`Rejected: ${params.resolution} needs the [eN] evidence of the re-check you ran.`)
						}
						if (params.resolution === "fixed") {
							const problem = fixedEvidenceProblem(finding.id, params.reproduction, ids, options.evidence)
							if (problem) return result(`Rejected: ${problem}`)
						}
						const reason = params.reason.trim()
						if (params.resolution === "dispute_accepted") {
							const problem = disputeQuoteProblem(params, options)
							if (problem) return result(`Rejected: ${problem}`)
						}
						resolutions.push({
							id: finding.id,
							resolution: params.resolution,
							evidence: [...new Set(ids)],
							reason,
							...(params.resolution === "dispute_accepted" && params.source && params.quote
								? {
										quote: {
											source: params.source,
											text: params.quote.trim(),
											...(params.path?.trim() ? { path: params.path.trim() } : {}),
										},
									}
								: {}),
						})
						if (params.resolution === "still_failing" || params.resolution === "dispute_rejected") {
							findings.push({
								id: finding.id,
								attempt,
								clause: finding.clause,
								evidence: [...new Set(ids)],
								observed: params.observed?.trim() || finding.observed,
								expected: finding.expected,
								why:
									params.resolution === "dispute_rejected" ? `${finding.why} Dispute rejected: ${reason}` : finding.why,
								status: "active",
								carried: true,
							})
							return result(`${finding.id} stays open.`)
						}
						return result(`${finding.id} is closed.`)
					},
				}),
			)
		}
		pi.registerTool(
			defineTool({
				name: SUBMIT_VERDICT_TOOL,
				executionMode: "sequential",
				label: "Submit Verdict",
				description:
					'End the review. "met" requires no active findings; "continue" and "impossible" require at least one active finding.',
				parameters: submitVerdictParameters,
				execute: async (_toolCallId, params) => {
					if (submission) return result("The verdict was already submitted.")
					const pending = unresolved()
					if (pending.length) {
						return result(
							`Rejected: resolve the open findings ${pending.map((finding) => finding.id).join(", ")} with resolve_finding first.`,
						)
					}
					const open = active()
					if (params.verdict === "met" && open.length) {
						return result(
							`Rejected: active findings ${open.map((finding) => finding.id).join(", ")} contradict met. Retract a finding whose expectation was wrong, or submit continue.`,
						)
					}
					if (params.verdict !== "met" && !open.length) {
						return result(
							`Rejected: ${params.verdict} needs at least one active finding citing executed evidence. Call report_finding first.`,
						)
					}
					submission = {
						verdict: params.verdict,
						summary: params.summary.trim(),
						finalAnswer: (params.finalAnswer ?? []).map((check) => ({
							clause: check.clause.trim(),
							expected: check.expected,
						})),
					}
					return result("Verdict submitted. The review is complete.")
				},
			}),
		)
	}

	return {
		extension,
		beginAttempt: () => ++attempt,
		attempt: () => attempt,
		findings: () => findings,
		activeFindings: active,
		resolutions: () => resolutions,
		submission: () => submission,
		isSubmitted: () => submission !== undefined,
	}
}

/**
 * Repository files that state required behavior rather than implement it:
 * tests, documentation, and schemas or specifications. A production-code
 * quote only restates what the code does, so it cannot settle a dispute
 * about what the code must do.
 */
function isContractPath(path: string): boolean {
	const normalized = path.replace(/\\/g, "/").toLowerCase()
	return (
		isTestFilePath(normalized) ||
		/\.(md|mdx|rst|txt|adoc)$/.test(normalized) ||
		/(^|\/)(docs?|documentation|specs?|schemas?)\//.test(normalized) ||
		/(^|\/)(readme|changelog|contributing)[^/]*$/.test(normalized) ||
		/\.schema\.json$/.test(normalized)
	)
}

/** Whitespace-insensitive containment, so a quote survives line wrapping. */
function containsQuote(text: string, quote: string): boolean {
	const squash = (value: string) => value.replace(/\s+/g, " ").trim().toLowerCase()
	return squash(text).includes(squash(quote))
}

/**
 * Why an accepted dispute's quoted source does not hold up, or undefined when
 * it does: objective quotes must appear in the objective text, repository
 * quotes in the named file; specification quotes are external and recorded as
 * given.
 */
function disputeQuoteProblem(
	params: { source?: string; quote?: string; path?: string },
	options: VerifierReportOptions,
): string | undefined {
	const quote = params.quote?.trim()
	if (!params.source || !quote) {
		return "dispute_accepted needs source and the exact quote that contradicts the finding's expectation. Without one, reject the dispute."
	}
	if (params.source === "objective" && options.objective !== undefined && !containsQuote(options.objective, quote)) {
		return "the quote does not appear in the objective. Quote it exactly, or reject the dispute."
	}
	if (params.source === "repository" && options.cwd !== undefined) {
		const path = params.path?.trim()
		if (!path) return "a repository quote needs the path of the file it is in."
		if (!isContractPath(path)) {
			return `${path} is production code: it shows what the code does, not what it must do. Quote the objective, documentation, a test, a schema, or a specification, or reject the dispute.`
		}
		const target = resolve(options.cwd, path)
		const rel = relative(options.cwd, target)
		if (rel.startsWith("..") || isAbsolute(rel)) return "the quoted file must be inside the repository."
		let content: string
		try {
			content = readFileSync(target, "utf-8")
		} catch {
			return `${path} could not be read. Quote a file that exists in the repository, or reject the dispute.`
		}
		if (!containsQuote(content, quote))
			return `the quote does not appear in ${path}. Quote it exactly, or reject the dispute.`
	}
	return undefined
}

/** Renders carried findings for a fresh session after a transport retry. */
export function formatCarriedFindings(findings: readonly VerifierFinding[]): string {
	return [
		"Findings recorded by the interrupted earlier attempt of this review (still active):",
		...findings.map(
			(finding) =>
				`- ${finding.id} [${finding.clause}] observed: ${finding.observed} | expected: ${finding.expected}${
					finding.evidence.length ? ` (evidence ${finding.evidence.join(", ")})` : ""
				}${finding.carried ? " (carried from an earlier review; retraction is not allowed)" : ""}`,
		),
		"Confirm each one. Retract only a non-carried finding whose expectation proved wrong; carried findings keep blocking met.",
	].join("\n")
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)
const isText = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0

/** Parses open findings from state or a headless `--findings` file; malformed entries are dropped. */
export function parseOpenFindings(value: unknown): OpenFinding[] | undefined {
	if (!Array.isArray(value)) return undefined
	return value.flatMap((item): OpenFinding[] => {
		if (!isRecord(item)) return []
		const { id, clause, observed, expected, why, response, disputesRejected } = item
		if (![id, clause, observed, expected, why].every(isText)) return []
		const status = isRecord(response)
			? (["fixed", "disputed"] as const).find((candidate) => candidate === response.status)
			: undefined
		const parsedResponse: FindingResponse | undefined =
			status && isRecord(response) && isText(response.evidence) ? { status, evidence: response.evidence } : undefined
		return [
			{
				id: id as string,
				clause: clause as string,
				observed: observed as string,
				expected: expected as string,
				why: why as string,
				...(parsedResponse ? { response: parsedResponse } : {}),
				...(typeof disputesRejected === "number" && Number.isInteger(disputesRejected) && disputesRejected > 0
					? { disputesRejected }
					: {}),
				...(isText(item.observedTree) ? { observedTree: item.observedTree } : {}),
			},
		]
	})
}
