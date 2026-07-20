import { describe, expect, it } from "vitest"
import { classifyLLMGatewayError, LLMGatewayError } from "./llm-gateway-error.js"

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
			name: "stream idle timeout (Bun patchedFetch abort)",
			message: "LLM stream idle timeout: no chunks for 120000ms",
			reason: "transport_failure",
		},
		{
			name: "headers idle timeout (Bun patchedFetch abort)",
			message: "LLM request idle timeout: no response headers within 120000ms",
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
