import { describe, expect, it } from "vitest"
import { classifyLLMGatewayError, formatWait, LLMGatewayError, parseRateLimitRetryAt } from "./llm-gateway-error.js"

describe("classifyLLMGatewayError", () => {
	it.each([
		{
			name: "Kimi rate limit",
			message: "kimi-k2.7 model is rate limited until 2026-07-09T13:18:18Z",
			reason: "rate_limit",
		},
		{
			name: "MiniMax rate limit",
			message: "minimax-m3 model is rate limited until 2026-07-09T13:18:18Z",
			reason: "rate_limit",
		},
		{
			name: "HTTP 429",
			message: "429 Too Many Requests",
			reason: "rate_limit",
			httpStatusCode: 429,
		},
		{
			name: "local proxy EOF",
			message: 'proxying request: Post "http://localhost:10000/v1/chat/completions": EOF',
			reason: "transport_failure",
		},
		{
			name: "provider proxy EOF",
			message: 'proxying request: Post "<redacted-url>": EOF',
			reason: "transport_failure",
		},
		{
			name: "broken pipe",
			message: 'proxying request: Post "<url>": write tcp <local>-><remote>: write: broken pipe',
			reason: "transport_failure",
		},
		{
			name: "socket closed unexpectedly",
			message:
				"The socket connection was closed unexpectedly. For more information, pass verbose: true in the second argument to fetch()",
			reason: "transport_failure",
		},
		{
			name: "connection terminated unexpectedly",
			message: "connection terminated unexpectedly",
			reason: "transport_failure",
		},
		{
			name: "request unexpectedly ended",
			message: "request unexpectedly ended while reading upstream response",
			reason: "transport_failure",
		},
		{
			name: "stream terminated unexpectedly",
			message: "provider stream terminated unexpectedly",
			reason: "transport_failure",
		},
		{
			name: "connection reset by peer",
			message: 'proxying request: Post "<url>": read tcp 127.0.0.1:1->127.0.0.1:2: read: connection reset by peer',
			reason: "transport_failure",
		},
		{
			name: "connection refused",
			message: 'proxying request: Post "<url>": dial tcp 127.0.0.1:10000: connect: connection refused',
			reason: "transport_failure",
		},
		{
			name: "i/o timeout",
			message: 'proxying request: Post "<url>": dial tcp 10.0.0.1:443: i/o timeout',
			reason: "transport_failure",
		},
		{
			name: "undici bodyTimeout mid-stream (bare fetch TypeError message)",
			message: "terminated",
			reason: "transport_failure",
		},
		{
			name: "undici bodyTimeout mid-stream with provider metadata appended",
			message: 'terminated\n{"request_id":"abc"}',
			reason: "transport_failure",
		},
		{
			name: "undici bodyTimeout recorded via String(err) with the error-name prefix",
			message: "TypeError: terminated",
			reason: "transport_failure",
		},
		{
			name: "undici bodyTimeout wrapped Go-style by a proxy layer",
			message: 'Post "https://llm.kimchi.dev/openai/v1/chat/completions": terminated',
			reason: "transport_failure",
		},
		{
			name: "stream ended without finish reason",
			message: "Stream ended without finish_reason",
			reason: "stream_interrupted",
		},
		{
			name: "provider 502",
			message: "502 status code (no body)",
			reason: "provider_5xx",
			httpStatusCode: 502,
		},
		{
			name: "provider 503 html",
			message: "503 Server Error. The service you requested is not available at this time.",
			reason: "provider_5xx",
			httpStatusCode: 503,
		},
		{
			name: "provider 500 nginx",
			message: "500 Internal Server Error ... nginx",
			reason: "provider_5xx",
			httpStatusCode: 500,
		},
		{
			name: "Cloudflare 524",
			message: "Cloudflare 524 timeout",
			reason: "provider_5xx",
			httpStatusCode: 524,
		},
		{
			name: "provider overload 529",
			message: "529 Overloaded",
			reason: "provider_5xx",
			httpStatusCode: 529,
		},
		{
			name: "provider overloaded_error",
			message: "overloaded_error",
			reason: "provider_5xx",
		},
		{
			name: "gateway timeout",
			message: "504 Gateway Timeout",
			reason: "provider_5xx",
			httpStatusCode: 504,
		},
		{
			name: "service is temporarily unavailable (HTTP 200 body)",
			message: "The service is temporarily unavailable.",
			reason: "provider_5xx",
		},
		{
			name: "service unavailable (compact form)",
			message: "503 Service Unavailable",
			reason: "provider_5xx",
			httpStatusCode: 503,
		},
		{
			name: "hosted vLLM server disconnected",
			message: "InternalServerError: Hosted_vllmException - Server disconnected",
			reason: "provider_error",
		},
		{
			name: "hosted vLLM cannot connect",
			message:
				"InternalServerError: Hosted_vllmException - Cannot connect to host serverless-kimi-k2-7 [Connect call failed ('34.118.225.213', 11434)]",
			reason: "provider_error",
		},
		{
			name: "hosted vLLM executor shutdown",
			message: "Hosted_vllmException - cannot schedule new futures after shutdown, code 500",
			reason: "provider_error",
			httpStatusCode: 500,
		},
		{
			name: "hosted vLLM upstream request",
			message: "Internal Server Error, call_upstream_request_error, error sending request",
			reason: "provider_error",
		},
	] as const)("classifies retryable gateway failure: $name", ({ message, reason, httpStatusCode }) => {
		const error = classifyLLMGatewayError(message)

		expect(error).toBeInstanceOf(LLMGatewayError)
		expect(error).toMatchObject({
			reason,
			rawMessage: message,
		})
		expect(error?.retryable).toBe(true)
		expect(error?.isInfrastructure).toBe(true)
		expect(error?.exitCode()).toBe(74)
		expect(error?.httpStatusCode).toBe(httpStatusCode)
	})

	it.each([
		{
			name: "budget exhausted",
			message: "budget exhausted",
			reason: "budget_exhausted",
		},
		{
			name: "api key budget exhausted",
			message: "api key budget exhausted",
			reason: "budget_exhausted",
		},
		{
			name: "organization budget exhausted",
			message: "organization budget exhausted",
			reason: "budget_exhausted",
		},
		{
			name: "team budget exhausted",
			message: "team budget exhausted",
			reason: "budget_exhausted",
		},
		{
			name: "429 budget exhausted (classified before the generic 429 rule)",
			message: "429 budget exhausted",
			reason: "budget_exhausted",
		},
		{
			name: "status code 429 budget exhausted",
			message: "status code 429: budget exhausted",
			reason: "budget_exhausted",
			httpStatusCode: 429,
		},
		{
			name: "billing budget exhausted",
			message: "429 billing budget exhausted",
			reason: "budget_exhausted",
		},
		{
			name: "billing error with API key budget exhausted",
			message: "billing error: API key budget exhausted",
			reason: "budget_exhausted",
		},
		{
			name: "empty tools array",
			message:
				"Value error, tools must not be an empty array. Either provide at least one tool or omit the field entirely.",
			reason: "invalid_request_payload",
		},
		{
			name: "context window exceeded",
			message:
				"ContextWindowExceededError: Hosted_vllmException - The input (132000 tokens) is longer than the model's context length (131072 tokens), code 400",
			reason: "context_window_exceeded",
			httpStatusCode: 400,
		},
		{
			name: "standalone context window exceeded error class",
			message: "ContextWindowExceededError",
			reason: "context_window_exceeded",
		},
		{
			name: "generic hosted vLLM bad request",
			message: "BadRequestError: Hosted_vllmException - BadRequest, code 400",
			reason: "bad_request",
			httpStatusCode: 400,
		},
		{
			name: "hosted vLLM bad request with JSON character offsets",
			message:
				"Hosted_vllmException - invalid escaped character in string: line 1 column 504 (char 503) BadRequestError code 400",
			reason: "bad_request",
			httpStatusCode: 400,
		},
		{
			name: "generic HTTP bad request",
			message: "400 Bad Request",
			reason: "bad_request",
			httpStatusCode: 400,
		},
		{
			name: "provider content_filter finish reason",
			message: "Provider finish_reason: content_filter",
			reason: "content_filter",
		},
		{
			name: "content filter variant",
			message: "Response filtered by content filter policy",
			reason: "content_filter",
		},
		{
			name: "bad request with hosted vLLM transport wording",
			message: "BadRequestError: Hosted_vllmException - error sending request, code 400",
			reason: "bad_request",
			httpStatusCode: 400,
		},
		{
			name: "HTTP 400 with transport wording",
			message: "HTTP 400 error sending request",
			reason: "bad_request",
			httpStatusCode: 400,
		},
		{
			name: "status 400 with upstream connect wording",
			message: "upstream connect error: status code 400",
			reason: "bad_request",
			httpStatusCode: 400,
		},
	] as const)("classifies non-retryable request failure: $name", ({ message, reason, httpStatusCode }) => {
		const error = classifyLLMGatewayError(message)

		expect(error).toBeInstanceOf(LLMGatewayError)
		expect(error).toMatchObject({
			reason,
			rawMessage: message,
		})
		expect(error?.retryable).toBe(false)
		expect(error?.isInfrastructure).toBe(false)
		expect(error?.exitCode()).toBe(1)
		expect(error?.httpStatusCode).toBe(httpStatusCode)
	})

	it.each([
		"invalid api key",
		"insufficient_quota: billing hard limit reached",
		"unrelated agent failure",
		"model returned 500 tokens before stopping",
		"tool call unexpectedly missing argument",
		"model response terminated by safety policy",
		"response was filtered by the content policy",
		"content was filtered for safety reasons",
	])("ignores non-gateway provider verdicts: %s", (message) => {
		expect(classifyLLMGatewayError(message)).toBeUndefined()
	})

	// A digit run equal to a status code but outside status context (an offset,
	// a count, a timestamp fragment) must never fabricate a classification —
	// especially not a retryable exit-74 one.
	it.each([
		"processed 429 files before the agent stopped",
		"wrote 400 rows then the run ended",
		"upstream returned 502 while proxying",
		"failed after 503 iterations of the loop",
	])("does not classify a bare status number outside status context: %s", (message) => {
		expect(classifyLLMGatewayError(message)).toBeUndefined()
	})
})

describe("parseRateLimitRetryAt", () => {
	const NOW = Date.parse("2026-08-05T12:00:00Z")
	const EXPECTED = Date.parse("2026-08-05T16:27:33Z")

	it.each([
		{ name: "bare UTC stamp", stamp: "2026-08-05T16:27:33Z", expected: EXPECTED },
		{ name: "sentence-final period", stamp: "2026-08-05T16:27:33Z.", expected: EXPECTED },
		{ name: "trailing clause", stamp: "2026-08-05T16:27:33Z, retry later.", expected: EXPECTED },
		{ name: "closing parenthesis", stamp: "2026-08-05T16:27:33Z)", expected: EXPECTED },
		// The gateway reports UTC, so an unzoned stamp must not be read as local time.
		{ name: "no zone", stamp: "2026-08-05T16:27:33", expected: EXPECTED },
		{ name: "fractional seconds", stamp: "2026-08-05T16:27:33.123Z", expected: EXPECTED + 123 },
		{ name: "explicit offset", stamp: "2026-08-05T18:27:33+02:00", expected: EXPECTED },
	])("parses $name", ({ stamp, expected }) => {
		expect(parseRateLimitRetryAt(`kimi-k2.7 model is rate limited until ${stamp}`, NOW)).toBe(expected)
	})

	it.each([
		{ name: "a bare number", message: "rate limited until 5" },
		{ name: "no deadline at all", message: "429 Too Many Requests" },
		{ name: "an unparseable stamp", message: "rate limited until 2026-13-45T99:99:99Z" },
		{ name: "a deadline already passed", message: "rate limited until 2026-08-05T11:00:00Z" },
	])("returns undefined for $name", ({ message }) => {
		expect(parseRateLimitRetryAt(message, NOW)).toBeUndefined()
	})
})

describe("formatWait", () => {
	it.each([
		{ ms: 1_000, expected: "1 second" },
		{ ms: 30_000, expected: "30 seconds" },
		{ ms: 59_000, expected: "59 seconds" },
		{ ms: 60_000, expected: "1 minute" },
		{ ms: 90_000, expected: "2 minutes" },
		{ ms: 59 * 60_000, expected: "59 minutes" },
		{ ms: 60 * 60_000, expected: "1 hour" },
		{ ms: 120 * 60_000, expected: "2 hours" },
		{ ms: -5_000, expected: "0 seconds" },
	])("formats $ms ms as $expected", ({ ms, expected }) => {
		expect(formatWait(ms)).toBe(expected)
	})
})

describe("model_retired", () => {
	it("classifies a 410 model_not_found body (Scenario A, unannounced removal)", () => {
		const error = classifyLLMGatewayError(
			'{"error": {"code": 410, "type": "model_not_found", "message": "The requested model is not available"}}',
		)
		expect(error?.reason).toBe("model_retired")
		expect(error?.httpStatusCode).toBe(410)
		expect(error?.retryable).toBe(false)
		expect(error?.isInfrastructure).toBe(false)
		expect(error?.exitCode()).toBe(1)
	})

	it("classifies a model_gone body and parses replacement hints (Scenario B)", () => {
		const error = classifyLLMGatewayError(
			'{"error": {"code": 410, "type": "model_gone", "message": "Model kimi-k2.5 has been retired.", "replacement": "kimi-k3", "suggested_alternatives": [{"id": "kimi-k2.7", "reason": "Prior generation"}, {"id": "glm-5.3"}], "docs": "https://docs.kimchi.dev/deprecations/kimi-k2.5"}}',
		)
		expect(error?.reason).toBe("model_retired")
		expect(error?.modelRetiredInfo).toEqual({
			replacement: "kimi-k3",
			alternatives: [
				{ slug: "kimi-k2.7", reason: "Prior generation" },
				{ slug: "glm-5.3", reason: undefined },
			],
			docs: "https://docs.kimchi.dev/deprecations/kimi-k2.5",
		})
	})

	it("parses the exact proxy model_gone envelope (objects with per-alternative reasons)", () => {
		// Byte-for-byte the gateway's model_gone response shape: object
		// entries, reason key omitted when unset, docs omitted when empty.
		const error = classifyLLMGatewayError(
			'{"error": {"type": "model_gone", "message": "Model \\"kimi-k2.7\\" has been removed.", "suggested_alternatives": [{"id": "glm-5.3", "reason": "Closest to K2.7 pricing ($1.40/$4.40 per 1M); reasoning and code, 1M context"}, {"id": "glm-5.3-flash", "reason": "Cheaper than K2.7 ($0.15/$0.50 per 1M)"}, {"id": "kimi-k3"}]}}',
		)
		expect(error?.reason).toBe("model_retired")
		expect(error?.modelRetiredInfo).toEqual({
			replacement: undefined,
			alternatives: [
				{ slug: "glm-5.3", reason: "Closest to K2.7 pricing ($1.40/$4.40 per 1M); reasoning and code, 1M context" },
				{ slug: "glm-5.3-flash", reason: "Cheaper than K2.7 ($0.15/$0.50 per 1M)" },
				{ slug: "kimi-k3", reason: undefined },
			],
			docs: undefined,
		})
	})

	it("parses the deprecation-service shape (replacementModel + alternatives with slug/reason/priority)", () => {
		const error = classifyLLMGatewayError(
			JSON.stringify({
				error: {
					message: "Model 'kimi-k2.7' has been retired.",
					type: "model_gone",
					code: 410,
					deprecatedTime: "2026-10-05T16:30:00Z",
					sunsetTime: "2026-10-18T23:59:59Z",
					replacementModel: "",
					alternatives: [
						{ slug: "glm-5.3", reason: "Closest to K2.7 pricing", priority: 0 },
						{ slug: "glm-5.3-flash", reason: "Cheaper than K2.7", priority: 1 },
						{ slug: "deepseek-v4.1-flash", reason: "Cheaper than K2.7", priority: 2 },
						{ slug: "kimi-k3", reason: "Latest generation", priority: 3 },
					],
					docs: "https://docs.kimchi.dev/deprecations/kimi-k2.7",
				},
			}),
		)
		expect(error?.reason).toBe("model_retired")
		expect(error?.modelRetiredInfo).toEqual({
			replacement: undefined,
			alternatives: [
				{ slug: "glm-5.3", reason: "Closest to K2.7 pricing" },
				{ slug: "glm-5.3-flash", reason: "Cheaper than K2.7" },
				{ slug: "deepseek-v4.1-flash", reason: "Cheaper than K2.7" },
				{ slug: "kimi-k3", reason: "Latest generation" },
			],
			docs: "https://docs.kimchi.dev/deprecations/kimi-k2.7",
		})
	})

	it("ignores an empty replacementModel string and falls back to alternatives", () => {
		const error = classifyLLMGatewayError(
			'{"error": {"type": "model_gone", "code": 410, "replacementModel": "", "alternatives": [{"slug": "kimi-k3"}], "docs": "https://docs.kimchi.dev/deprecations/kimi-k2.7"}}',
		)
		expect(error?.modelRetiredInfo).toEqual({
			replacement: undefined,
			alternatives: [{ slug: "kimi-k3", reason: undefined }],
			docs: "https://docs.kimchi.dev/deprecations/kimi-k2.7",
		})
	})

	it("strips ANSI/control characters from gateway-supplied reason text", () => {
		// JSON path: real escape bytes after JSON parsing.
		const parsed = classifyLLMGatewayError(
			'{"error": {"type": "model_gone", "code": 410, "suggested_alternatives": [{"id": "glm-5.3", "reason": "bad \u001b[2J cleared"}]}}',
		)
		expect(parsed?.modelRetiredInfo?.alternatives[0]?.reason).toBe("bad [2J cleared")

		// Regex-fallback path: a malformed body (trailing comma) fails
		// JSON.parse, the object regex still extracts the entry, and escape
		// sequences must not reach the terminal.
		const fallback = classifyLLMGatewayError(
			'{"error": {"type": "model_gone", "code": 410, "suggested_alternatives": [{"id": "glm-5.3", "reason": "bad \u001b[2J"},]}}',
		)
		const reason = fallback?.modelRetiredInfo?.alternatives[0]?.reason ?? ""
		const hasControlChars = [...reason].some((c) => {
			const code = c.charCodeAt(0)
			return code < 32 || (code >= 127 && code < 160)
		})
		expect(hasControlChars).toBe(false)
		expect(reason).toContain("bad")
	})

	it("strips control characters from replacement and docs", () => {
		const error = classifyLLMGatewayError(
			'{"error": {"type": "model_gone", "code": 410, "replacement": "kimi-\u001b[2Jk3", "docs": "https://d/\u001b[0mx"}}',
		)
		expect(error?.modelRetiredInfo?.replacement).toBe("kimi-[2Jk3")
		expect(error?.modelRetiredInfo?.docs).toBe("https://d/[0mx")
	})

	it("tolerates the legacy string-array alternatives shape", () => {
		const error = classifyLLMGatewayError(
			'{"error": {"type": "model_gone", "message": "Model kimi-k2.5 has been retired.", "suggested_alternatives": ["kimi-k2.7", "glm-5.3"]}}',
		)
		expect(error?.modelRetiredInfo).toEqual({
			replacement: undefined,
			alternatives: [
				{ slug: "kimi-k2.7", reason: undefined },
				{ slug: "glm-5.3", reason: undefined },
			],
			docs: undefined,
		})
	})

	it("classifies prose retirement without structured fields", () => {
		const error = classifyLLMGatewayError("Model deepseek-v3 has been removed from the gateway")
		expect(error?.reason).toBe("model_retired")
		expect(error?.modelRetiredInfo).toBeUndefined()
	})

	it("classifies a bare 410 status as retired", () => {
		const error = classifyLLMGatewayError("410 Gone")
		expect(error?.reason).toBe("model_retired")
		expect(error?.httpStatusCode).toBe(410)
	})

	it("does not classify plain 'model not found' prose without retirement markers", () => {
		expect(classifyLLMGatewayError("The model was not found, please check the model name")).toBeUndefined()
	})
})
