export type LLMGatewayErrorReason =
	| "rate_limit"
	| "transport_failure"
	| "stream_interrupted"
	| "provider_5xx"
	| "provider_error"
	| "bad_request"
	| "context_window_exceeded"
	| "invalid_request_payload"

export const LLM_GATEWAY_INFRASTRUCTURE_EXIT_CODE = 74
const LLM_GATEWAY_REQUEST_EXIT_CODE = 1

const LLM_GATEWAY_REASON_POLICIES: Record<
	LLMGatewayErrorReason,
	{ readonly retryable: boolean; readonly isInfrastructure: boolean; readonly exitCode: number }
> = {
	rate_limit: { retryable: true, isInfrastructure: true, exitCode: LLM_GATEWAY_INFRASTRUCTURE_EXIT_CODE },
	transport_failure: { retryable: true, isInfrastructure: true, exitCode: LLM_GATEWAY_INFRASTRUCTURE_EXIT_CODE },
	stream_interrupted: { retryable: true, isInfrastructure: true, exitCode: LLM_GATEWAY_INFRASTRUCTURE_EXIT_CODE },
	provider_5xx: { retryable: true, isInfrastructure: true, exitCode: LLM_GATEWAY_INFRASTRUCTURE_EXIT_CODE },
	provider_error: { retryable: true, isInfrastructure: true, exitCode: LLM_GATEWAY_INFRASTRUCTURE_EXIT_CODE },
	bad_request: { retryable: false, isInfrastructure: false, exitCode: LLM_GATEWAY_REQUEST_EXIT_CODE },
	context_window_exceeded: { retryable: false, isInfrastructure: false, exitCode: LLM_GATEWAY_REQUEST_EXIT_CODE },
	invalid_request_payload: { retryable: false, isInfrastructure: false, exitCode: LLM_GATEWAY_REQUEST_EXIT_CODE },
}

export class LLMGatewayError {
	readonly name = "LLMGatewayError"
	readonly reason: LLMGatewayErrorReason
	readonly rawMessage: string
	readonly httpStatusCode?: number

	constructor(params: { reason: LLMGatewayErrorReason; rawMessage: string; httpStatusCode?: number }) {
		this.reason = params.reason
		this.rawMessage = params.rawMessage
		this.httpStatusCode = params.httpStatusCode
	}

	get retryable(): boolean {
		return LLM_GATEWAY_REASON_POLICIES[this.reason].retryable
	}

	get isInfrastructure(): boolean {
		return LLM_GATEWAY_REASON_POLICIES[this.reason].isInfrastructure
	}

	exitCode(): number {
		return LLM_GATEWAY_REASON_POLICIES[this.reason].exitCode
	}
}

const HTTP_STATUS_RES = [
	/"code"\s*:\s*(400|429|500|502|503|504|524|529)\b/i,
	/\bcode\s*(?:=|:)?\s*(400|429|500|502|503|504|524|529)\b/i,
	/\b(?:http(?:\s+status)?|status(?:\s+code)?)\s*(?:=|:)?\s*(400|429|500|502|503|504|524|529)\b/i,
	/\b(400|429|500|502|503|504|524|529)\s+status\s+code\b/i,
	/\b(400)\s+bad\s+request\b/i,
	/\b(429)\s+(?:too many requests|rate.?limit(?:ed)?)\b/i,
	/\b(500)\s+(?:internal server error|server error)\b/i,
	/\b(502)\s+bad gateway\b/i,
	/\b(503)\s+(?:service unavailable|server error)\b/i,
	/\b(504)\s+gateway timeout\b/i,
	/\b(?:cloudflare\s+)?(524)\s+timeout\b/i,
	/\b(529)\s+overloaded\b/i,
]

const FIVE_XX_STATUS_CODES = new Set([500, 502, 503, 504, 524, 529])

const INVALID_REQUEST_PAYLOAD_RE = /tools must not be an empty array/i
const CONTEXT_WINDOW_RE =
	/ContextWindowExceeded|context(?:\s|-)?(?:window|length|overflow)|maximum context|prompt too long|longer than the model'?s context length/i
const NON_GATEWAY_PROVIDER_VERDICT_RE =
	/unauthorized|authentication[_\s]?(?:error|failed)|invalid api key|\b401\b|\b403\b|permission denied|account.{0,40}\b(?:terminated|suspended|deactivated|disabled)\b|quota|billing|insufficient_quota|out of budget|usage limit/i

const RATE_LIMIT_TEXT_RE = /rate.?limit|too many requests/i
const STREAM_INTERRUPTED_RE =
	/stream ended without finish_reason|stream ended before message_stop|ended without finish/i
const HOSTED_VLLM_PROVIDER_ERROR_RE =
	/Hosted_vllmException.*(?:server disconnected|cannot connect to host|connect call failed|cannot schedule new futures after shutdown|executor.*shutdown|upstream request|call_upstream_request_error)|call_upstream_request_error|error sending request/i
const PROVIDER_5XX_TEXT_RE =
	/bad gateway|service unavailable|gateway timeout|internal server error|overloaded|overloaded_error|cloudflare.*timeout|timeout.*cloudflare/i
// Named-phrase forms only; numeric statuses are matched via parseHttpStatusCode.
const TRANSPORT_FAILURE_RE =
	/\bEOF\b|socket(?: connection was)? closed|socket hang up|other side closed|connection closed|connection reset|connection refused|connection lost|broken pipe|fetch failed|network.?error|connection.?error|upstream.?connect|reset before headers|http2 request did not get a response|i\/o timeout|(?:request|connection|socket|network|fetch|read|write|proxy|http2|tls).{0,30}(?:timeout|timed out)|timed out|EPIPE|ERR_SOCKET_CLOSED|ERR_STREAM_PREMATURE_CLOSE|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/i
const TRANSPORT_TERMINATION_RE =
	/\b(?:connection|request|stream|response|socket|http2 request)\b.{0,40}\b(?:terminated unexpectedly|unexpectedly (?:ended|closed|terminated)|ended unexpectedly|closed unexpectedly)\b/i
const BAD_REQUEST_TEXT_RE = /bad request|BadRequest/i

function parseHttpStatusCode(rawMessage: string): number | undefined {
	for (const pattern of HTTP_STATUS_RES) {
		const match = pattern.exec(rawMessage)
		if (match?.[1]) return Number.parseInt(match[1], 10)
	}
	return undefined
}

function createError(
	reason: LLMGatewayErrorReason,
	rawMessage: string,
	httpStatusCode: number | undefined,
): LLMGatewayError {
	return new LLMGatewayError({ reason, rawMessage, httpStatusCode })
}

export function classifyLLMGatewayError(rawMessage: string): LLMGatewayError | undefined {
	if (!rawMessage) return undefined

	// Parse the HTTP status once, in status context only (e.g. "code 429",
	// "503 Service Unavailable") — never a bare number. This keeps digits that
	// merely appear in offsets, token counts, or timestamps from fabricating a
	// status, and gives every numeric rule below one shared source of truth.
	const status = parseHttpStatusCode(rawMessage)

	if (INVALID_REQUEST_PAYLOAD_RE.test(rawMessage)) return createError("invalid_request_payload", rawMessage, status)
	if (CONTEXT_WINDOW_RE.test(rawMessage)) return createError("context_window_exceeded", rawMessage, status)
	if (NON_GATEWAY_PROVIDER_VERDICT_RE.test(rawMessage)) return undefined
	if (BAD_REQUEST_TEXT_RE.test(rawMessage) || status === 400) return createError("bad_request", rawMessage, status)

	if (RATE_LIMIT_TEXT_RE.test(rawMessage) || status === 429) return createError("rate_limit", rawMessage, status)
	if (STREAM_INTERRUPTED_RE.test(rawMessage)) return createError("stream_interrupted", rawMessage, status)
	if (HOSTED_VLLM_PROVIDER_ERROR_RE.test(rawMessage)) return createError("provider_error", rawMessage, status)
	if (PROVIDER_5XX_TEXT_RE.test(rawMessage) || (status !== undefined && FIVE_XX_STATUS_CODES.has(status)))
		return createError("provider_5xx", rawMessage, status)
	if (TRANSPORT_FAILURE_RE.test(rawMessage) || TRANSPORT_TERMINATION_RE.test(rawMessage))
		return createError("transport_failure", rawMessage, status)

	return undefined
}
