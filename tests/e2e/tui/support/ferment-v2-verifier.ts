import type { FakeResponseRequest, FakeResponseScript } from "./fake-openai-server.js"

export function isVerifierRequest(request: FakeResponseRequest): boolean {
	return (
		request.url.startsWith("/openai/v1/chat/completions") &&
		JSON.stringify(request.body).includes("<ferment_v2_verifier>")
	)
}

export function isImplementerRequest(request: FakeResponseRequest): boolean {
	return request.url.startsWith("/openai/v1/chat/completions") && !isVerifierRequest(request)
}

/** One executing verifier check; the guard stamps its result as the next [eN] (e1 in a fresh review). */
export function verifierCheck(id: string, command = "pwd"): FakeResponseScript {
	return {
		match: isVerifierRequest,
		stream: ["Running the verification check."],
		toolCalls: [{ id, function: { name: "bash", arguments: JSON.stringify({ command }) } }],
	}
}

export interface ScriptedFinding {
	clause: string
	observed: string
	expected: string
	why?: string
	evidence?: string[]
}

/**
 * The verifier's report: an optional finding citing the check's [e1] result,
 * then submit_verdict, which ends the review. The report tools run
 * sequentially, so the finding is recorded before the verdict is checked.
 */
export function verifierSubmit(
	verdict: "met" | "continue" | "impossible",
	summary: string,
	options: {
		finding?: ScriptedFinding
		finalAnswer?: { clause: string; expected: string | null }[]
		/** Settle findings an earlier review left open, before any new finding and the verdict. */
		resolve?: { id: string; resolution: string; evidence?: string[]; reproduction?: string; reason?: string }[]
		textDelayMs?: number
	} = {},
): FakeResponseScript {
	const { finding } = options
	const resolutions = options.resolve ?? []
	return {
		match: isVerifierRequest,
		...(options.textDelayMs ? { stream: ["Reporting the review."], textDelayMs: options.textDelayMs } : {}),
		toolCalls: [
			...resolutions.map((resolution, index) => ({
				id: `verifier-resolve-${index}`,
				index,
				function: {
					name: "resolve_finding",
					arguments: JSON.stringify({
						id: resolution.id,
						resolution: resolution.resolution,
						evidence: resolution.evidence ?? ["e1"],
						...(resolution.reproduction ? { reproduction: resolution.reproduction } : {}),
						reason: resolution.reason ?? "Re-ran the finding's check.",
					}),
				},
			})),
			...(finding
				? [
						{
							id: "verifier-finding",
							index: resolutions.length,
							function: {
								name: "report_finding",
								arguments: JSON.stringify({
									clause: finding.clause,
									evidence: finding.evidence ?? ["e1"],
									observed: finding.observed,
									expected: finding.expected,
									why: finding.why ?? "The objective requires it.",
								}),
							},
						},
					]
				: []),
			{
				id: "verifier-submit",
				index: resolutions.length + (finding ? 1 : 0),
				function: {
					name: "submit_verdict",
					arguments: JSON.stringify({
						verdict,
						summary,
						...(options.finalAnswer ? { finalAnswer: options.finalAnswer } : {}),
					}),
				},
			},
		],
	}
}

/** A complete scripted review: one executing check, then the report. */
export function verifierReview(
	id: string,
	verdict: "met" | "continue" | "impossible",
	summary: string,
	options: Parameters<typeof verifierSubmit>[2] & { command?: string } = {},
): FakeResponseScript[] {
	return [verifierCheck(id, options.command), verifierSubmit(verdict, summary, options)]
}
