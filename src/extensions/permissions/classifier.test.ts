import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createModel, createModelRegistry } from "../__mocks__/model-registry.js"
import { classifyToolCall, parseClassifierOutput } from "./classifier.js"
import { classifierHealth } from "./classifier-health.js"
import { resolveClassifierCandidates } from "./classifier-models.js"

const completeMock = vi.fn()
vi.mock("@earendil-works/pi-ai/compat", () => ({
	complete: (...args: unknown[]) => completeMock(...args),
}))

const primary = createModel("deepseek-v4-flash-0731")
const fallback = createModel("minimax-m3")
const call = { toolName: "edit", input: { path: "foo.ts" }, cwd: "/tmp" }
const options = { timeoutMs: 8000 }
function response(content = '{"verdict":"safe","reason":"fine","riskScore":"low"}', stopReason = "stop") {
	return { content: [{ type: "text", text: content }], stopReason }
}
function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

describe("classifyToolCall", () => {
	it.each([
		"output",
		"provider",
		"auth",
	])("keeps %s diagnostics and tool inputs out of health events", async (source) => {
		const secret = "SENTINEL_SECRET"
		const registry = createModelRegistry()
		if (source === "auth") registry.getApiKeyAndHeaders.mockRejectedValue(new Error(secret))
		completeMock.mockResolvedValue(
			source === "provider" ? { ...response("", "error"), errorMessage: secret } : response(secret),
		)
		const promise = classifyToolCall([primary], registry, { ...call, input: { command: secret } }, options)
		await vi.runAllTimersAsync()
		const result = await promise
		expect(result.ok).toBe(false)
		const health = classifierHealth(result, [primary], [])
		expect(health).toBeDefined()
		expect(JSON.stringify(health)).not.toContain(secret)
		expect(health?.payload).not.toHaveProperty("reason")
	})

	it("caps retries on every candidate", async () => {
		completeMock.mockResolvedValue(response("invalid"))
		const promise = classifyToolCall([primary, fallback], createModelRegistry(), call, options)
		await vi.runAllTimersAsync()
		expect(await promise).toMatchObject({ ok: false, failureCode: "invalid_output" })
		expect(completeMock.mock.calls.map(([model]) => model)).toEqual([
			primary,
			primary,
			primary,
			fallback,
			fallback,
			fallback,
		])
	})

	beforeEach(() => {
		completeMock.mockReset()
		vi.useFakeTimers()
	})
	afterEach(() => {
		expect(vi.getTimerCount()).toBe(0)
		vi.restoreAllMocks()
		vi.useRealTimers()
	})

	it("uses fallback when the primary slug is missing", async () => {
		const registry = createModelRegistry([fallback])
		const { candidates } = resolveClassifierCandidates(registry)
		completeMock.mockResolvedValue(response())
		const result = await classifyToolCall(candidates, registry, call, options)
		expect(result).toMatchObject({ ok: true, usedModelId: fallback.id })
		expect(completeMock.mock.calls[0]?.[0]).toBe(fallback)
	})

	it.each(["safe", "requires-confirmation"])("stops on a valid %s verdict", async (verdict) => {
		completeMock.mockResolvedValue(response(JSON.stringify({ verdict, reason: "fine", riskScore: "low" })))
		const result = await classifyToolCall([primary, fallback], createModelRegistry(), call, options)
		expect(result).toMatchObject({ verdict, ok: true, riskScore: "low", usedModelId: primary.id })
		expect(result).not.toHaveProperty("retryable")
		expect(result.failureCode).toBeUndefined()
		expect(completeMock).toHaveBeenCalledTimes(1)
	})

	it.each(["deepseek-v4-flash-0731", "kimi-k3"])("keeps classifier tags and token limits (%s)", async (modelId) => {
		let sentPayload: unknown
		completeMock.mockImplementation((_model, _context, opts) => {
			sentPayload = opts.onPayload({ max_completion_tokens: 100, max_tokens: 100, tags: ["existing"] })
			return response()
		})
		await classifyToolCall([createModel(modelId)], createModelRegistry(), call, options)
		expect(sentPayload).toEqual({
			max_completion_tokens: 100,
			max_tokens: 100,
			tags: ["source:classifier", "existing"],
		})
	})

	it.each([
		["timeout", () => response("", "aborted")],
		["provider_error", () => ({ ...response("", "error"), errorMessage: "rate limit exceeded" })],
		[
			"provider_error",
			() => {
				throw new Error("connection failed")
			},
		],
		["invalid_output", () => response("not json")],
	] as const)("retries %s then advances to fallback", async (_code, failure) => {
		completeMock.mockImplementation((model) => (model === primary ? failure() : response()))
		const promise = classifyToolCall([primary, fallback], createModelRegistry(), call, options)
		await vi.runAllTimersAsync()
		expect(await promise).toMatchObject({ ok: true, usedModelId: fallback.id })
		expect(completeMock.mock.calls.map(([model]) => model)).toEqual([primary, primary, primary, fallback])
	})

	it.each([2, 3])("can succeed on primary attempt %i", async (successAttempt) => {
		completeMock.mockImplementation(() =>
			completeMock.mock.calls.length === successAttempt ? response() : response("", "aborted"),
		)
		const promise = classifyToolCall([primary], createModelRegistry(), call, options)
		await vi.runAllTimersAsync()
		expect(await promise).toMatchObject({ ok: true, usedModelId: primary.id })
		expect(completeMock).toHaveBeenCalledTimes(successAttempt)
	})

	it.each([
		["timeout", response("", "aborted")],
		["provider_error", { ...response("", "error"), errorMessage: "rate limit exceeded" }],
		["invalid_output", response("invalid")],
	] as const)("fails closed with public %s code after the cap", async (failureCode, failure) => {
		completeMock.mockResolvedValue(failure)
		const promise = classifyToolCall([primary], createModelRegistry(), call, options)
		await vi.runAllTimersAsync()
		const result = await promise
		expect(result).toMatchObject({ verdict: "requires-confirmation", ok: false, failureCode })
		expect(result).not.toHaveProperty("retryable")
		expect(result.usedModelId).toBeUndefined()
		expect(completeMock).toHaveBeenCalledTimes(3)
	})

	it("reserves a full fallback attempt after actual primary timeouts", async () => {
		const starts: number[] = []
		completeMock.mockImplementation((model) => {
			starts.push(performance.now())
			if (model === primary) return new Promise(() => {})
			return new Promise((resolve) => setTimeout(() => resolve(response()), 7999))
		})
		const started = performance.now()
		const promise = classifyToolCall([primary, fallback], createModelRegistry(), call, options)
		await vi.runAllTimersAsync()
		expect(await promise).toMatchObject({ ok: true, usedModelId: fallback.id })
		expect(starts.map((t) => t - started)).toEqual([0, 8500, 16500])
		expect(performance.now() - started).toBe(24499)
	})

	it("bounds a provider that ignores abort by the total budget", async () => {
		let attemptSignal: AbortSignal | undefined
		completeMock.mockImplementation((_model, _context, opts) => {
			attemptSignal = opts.signal
			return new Promise(() => {})
		})
		const promise = classifyToolCall([primary], createModelRegistry(), call, { timeoutMs: 8000, maxTotalMs: 2000 })
		const started = performance.now()
		await vi.runAllTimersAsync()
		expect(await promise).toMatchObject({ ok: false, failureCode: "budget_exhausted" })
		expect(performance.now() - started).toBe(2000)
		expect(attemptSignal?.aborted).toBe(true)
		expect(completeMock).toHaveBeenCalledTimes(1)
	})

	it("starts no work when the budget cannot fit an attempt", async () => {
		const registry = createModelRegistry()
		expect(await classifyToolCall([primary], registry, call, { ...options, maxTotalMs: 999 })).toMatchObject({
			ok: false,
			failureCode: "budget_exhausted",
		})
		expect(registry.getApiKeyAndHeaders).not.toHaveBeenCalled()
		expect(completeMock).not.toHaveBeenCalled()
	})

	it.each(["missing", "throws"] as const)("skips %s auth and uses fallback", async (kind) => {
		const registry = createModelRegistry()
		if (kind === "missing") registry.getApiKeyAndHeaders.mockResolvedValueOnce({ ok: false, error: "secret" })
		else registry.getApiKeyAndHeaders.mockRejectedValueOnce(new Error("secret"))
		completeMock.mockResolvedValue(response())
		expect(await classifyToolCall([primary, fallback], registry, call, options)).toMatchObject({
			ok: true,
			usedModelId: fallback.id,
		})
		expect(completeMock.mock.calls[0]?.[0]).toBe(fallback)
	})

	it("reports auth lookup failures when auth is configured", async () => {
		const registry = createModelRegistry()
		registry.getApiKeyAndHeaders.mockResolvedValue({ ok: false, error: "secret" })
		const result = await classifyToolCall([primary, fallback], registry, call, options)
		expect(result.failureCode).toBe("auth_unavailable")
		expect(result.reason).toContain(`${primary.id} skipped: auth lookup failed`)
		expect(result.reason).toContain(`${fallback.id} skipped: auth lookup failed`)
		expect(result).not.toHaveProperty("retryable")
		expect(result.reason).not.toContain("secret")
	})

	it("reports no_api_key when no auth is configured", async () => {
		const registry = createModelRegistry()
		registry.hasConfiguredAuth.mockReturnValue(false)
		registry.getApiKeyAndHeaders.mockResolvedValue({ ok: false, error: "secret" })
		const result = await classifyToolCall([primary, fallback], registry, call, options)
		expect(result.failureCode).toBe("no_api_key")
		expect(result.reason).toContain(`${primary.id} skipped: no API key`)
		expect(result.reason).toContain(`${fallback.id} skipped: no API key`)
		expect(result).not.toHaveProperty("retryable")
		expect(result.reason).not.toContain("secret")
	})

	it("uses the fallback when the primary provider is unconfigured", async () => {
		const registry = createModelRegistry()
		registry.hasConfiguredAuth.mockImplementation((model) => model.id !== primary.id)
		registry.getApiKeyAndHeaders.mockResolvedValueOnce({ ok: false, error: "secret" })
		completeMock.mockResolvedValue(response())
		expect(await classifyToolCall([primary, fallback], registry, call, options)).toMatchObject({
			ok: true,
			usedModelId: fallback.id,
		})
		expect(completeMock.mock.calls[0]?.[0]).toBe(fallback)
	})

	it("aggregates no_api_key and auth lookup failures across the ladder", async () => {
		const registry = createModelRegistry()
		registry.hasConfiguredAuth.mockImplementation((model) => model.id !== primary.id)
		registry.getApiKeyAndHeaders
			.mockResolvedValueOnce({ ok: false, error: "secret" })
			.mockRejectedValueOnce(new Error("secret"))
		const result = await classifyToolCall([primary, fallback], registry, call, options)
		expect(result.failureCode).toBe("auth_unavailable")
		expect(result.reason).toContain(`${primary.id} skipped: no API key`)
		expect(result.reason).toContain(`${fallback.id} skipped: auth lookup failed`)
		expect(result.reason).not.toContain("secret")
	})

	it.each(["resolve", "reject"] as const)("bounds stalled primary auth and ignores late %s", async (settlement) => {
		const pending = deferred<Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>>>()
		const registry = createModelRegistry()
		registry.getApiKeyAndHeaders.mockReturnValueOnce(pending.promise)
		completeMock.mockResolvedValue(response())
		const promise = classifyToolCall([primary, fallback], registry, call, options)
		await vi.runAllTimersAsync()
		expect(await promise).toMatchObject({ ok: true, usedModelId: fallback.id })
		if (settlement === "resolve") pending.resolve({ ok: true, apiKey: "late", headers: {} })
		else pending.reject(new Error("late auth error"))
		await vi.runAllTimersAsync()
		expect(completeMock).toHaveBeenCalledTimes(1)
		expect(completeMock.mock.calls[0]?.[0]).toBe(fallback)
	})

	it("bounds a single stalled auth lookup", async () => {
		const registry = createModelRegistry()
		registry.getApiKeyAndHeaders.mockReturnValue(new Promise(() => {}))
		const started = performance.now()
		const promise = classifyToolCall([primary], registry, call, options)
		await vi.runAllTimersAsync()
		expect(await promise).toMatchObject({ failureCode: "budget_exhausted", ok: false })
		expect(performance.now() - started).toBe(25000)
		expect(completeMock).not.toHaveBeenCalled()
	})

	it.each(["resolve", "reject"] as const)("ignores late completion %s after timeout", async (settlement) => {
		const pending = deferred<ReturnType<typeof response>>()
		completeMock.mockReturnValueOnce(pending.promise).mockResolvedValue(response())
		const promise = classifyToolCall([primary], createModelRegistry(), call, options)
		await vi.runAllTimersAsync()
		expect(await promise).toMatchObject({ ok: true })
		if (settlement === "resolve") pending.resolve(response())
		else pending.reject(new Error("late provider error"))
		await vi.runAllTimersAsync()
		expect(completeMock).toHaveBeenCalledTimes(2)
	})

	it.each([
		"empty",
		"before",
		"auth",
		"backoff",
		"completion",
		"final",
	] as const)("returns classifier aborted during %s without advancing", async (stage) => {
		const controller = new AbortController()
		const registry = createModelRegistry()
		completeMock.mockResolvedValue(response("", "aborted"))
		if (stage === "empty" || stage === "before") controller.abort()
		if (stage === "auth") registry.getApiKeyAndHeaders.mockReturnValue(new Promise(() => {}))
		if (stage === "completion") completeMock.mockReturnValue(new Promise(() => {}))
		if (stage === "final")
			completeMock
				.mockImplementation(() => {
					if (completeMock.mock.calls.length === 3) controller.abort()
					return response()
				})
				.mockResolvedValueOnce(response("", "aborted"))
				.mockResolvedValueOnce(response("", "aborted"))
		const promise = classifyToolCall(
			stage === "empty" ? [] : [primary, fallback],
			registry,
			call,
			options,
			controller.signal,
		)
		if (["auth", "backoff", "completion"].includes(stage)) {
			await vi.advanceTimersByTimeAsync(100)
			controller.abort()
		}
		await vi.runAllTimersAsync()
		expect(await promise).toMatchObject({ reason: "classifier aborted", failureCode: "aborted", ok: false })
		expect(completeMock.mock.calls.every(([model]) => model === primary)).toBe(true)
		if (stage === "empty" || stage === "before") expect(registry.getApiKeyAndHeaders).not.toHaveBeenCalled()
	})

	it("fails closed when no candidates exist", async () => {
		const result = await classifyToolCall([], createModelRegistry(), call, options)
		expect(result).toEqual({
			verdict: "requires-confirmation",
			reason: "no model available for classifier",
			ok: false,
			failureCode: "no_candidates",
		})
		expect(completeMock).not.toHaveBeenCalled()
	})

	it("does not expose retryable on public parser failures", () => {
		expect(parseClassifierOutput("invalid")).not.toHaveProperty("retryable")
	})
})

describe("parseClassifierOutput", () => {
	it("parses a valid safe verdict", () => {
		const r = parseClassifierOutput(`{ "verdict": "safe", "reason": "project build" }`)
		expect(r.verdict).toBe("safe")
		expect(r.reason).toBe("project build")
		expect(r.ok).toBe(true)
	})

	it("parses requires-confirmation", () => {
		const r = parseClassifierOutput(`{"verdict":"requires-confirmation","reason":"ambiguous"}`)
		expect(r.verdict).toBe("requires-confirmation")
	})

	it("falls back to requires-confirmation for removed 'blocked' verdict", () => {
		const r = parseClassifierOutput(`{"verdict":"blocked","reason":"destructive"}`)
		expect(r.verdict).toBe("requires-confirmation")
		expect(r.ok).toBe(false)
	})

	it("extracts embedded JSON when LLM adds prose", () => {
		const raw = `Sure. Here is my answer:\n\n{"verdict":"safe","reason":"fine"}\n\nHope that helps.`
		expect(parseClassifierOutput(raw).verdict).toBe("safe")
	})

	it("falls back to requires-confirmation on garbage", () => {
		const r = parseClassifierOutput("not json at all")
		expect(r.verdict).toBe("requires-confirmation")
		expect(r.reason).toContain("unparseable")
		expect(r.ok).toBe(false)
	})

	it("falls back on unknown verdict", () => {
		const r = parseClassifierOutput(`{"verdict":"maybe","reason":"x"}`)
		expect(r.verdict).toBe("requires-confirmation")
		expect(r.ok).toBe(false)
		expect(r.reason).toBe("x")
	})

	it("defaults reason when missing", () => {
		const r = parseClassifierOutput(`{"verdict":"safe"}`)
		expect(r.reason).toBe("no reason provided")
	})

	it("strips <think>…</think> and parses JSON after", () => {
		const raw = `<think>The user is editing a test file, this is safe.</think>\n{"verdict":"safe","riskScore":"low","reason":"test file edit"}`
		const r = parseClassifierOutput(raw)
		expect(r.ok).toBe(true)
		expect(r.verdict).toBe("safe")
		expect(r.riskScore).toBe("low")
		expect(r.reason).toBe("test file edit")
	})

	it("strips <thinking>…</thinking> (alternate delimiter)", () => {
		const raw = `<thinking>checking blast radius</thinking>\n{"verdict":"requires-confirmation","riskScore":"medium","reason":"writes outside cwd"}`
		const r = parseClassifierOutput(raw)
		expect(r.ok).toBe(true)
		expect(r.verdict).toBe("requires-confirmation")
		expect(r.riskScore).toBe("medium")
	})

	it("ignores braces inside thinking block (the minimax-m2.7 bug)", () => {
		// Model thinks aloud about the JSON shape, including example braces,
		// then emits the real JSON after the closing tag. The naive
		// indexOf('{') / lastIndexOf('}') approach latches onto braces
		// inside the thinking text and returns null.
		const raw = `<think>The answer should look like {verdict: safe, reason: ...} so I'll output it now.</think>\n{"verdict":"safe","riskScore":"low","reason":"file edit"}`
		const r = parseClassifierOutput(raw)
		expect(r.ok).toBe(true)
		expect(r.verdict).toBe("safe")
		expect(r.riskScore).toBe("low")
		expect(r.reason).toBe("file edit")
	})

	it("returns unparseable when <think> is unclosed and no JSON follows", () => {
		const raw = "<think>The model burned its tokens reasoning and never produced a verdict."
		const r = parseClassifierOutput(raw)
		expect(r.ok).toBe(false)
		expect(r.verdict).toBe("requires-confirmation")
		expect(r.reason).toContain("unparseable")
	})

	it("strips <mm:think>…</mm:think> (minimax-m3 delimiter)", () => {
		const raw = `<mm:think>The answer should look like {verdict: safe} so I'll respond now.</mm:think>
{"verdict":"safe","riskScore":"low","reason":"file edit"}`
		const r = parseClassifierOutput(raw)
		expect(r.ok).toBe(true)
		expect(r.verdict).toBe("safe")
		expect(r.riskScore).toBe("low")
	})

	it("defaults riskScore to undefined when missing", () => {
		const r = parseClassifierOutput(`{"verdict":"safe","reason":"fine"}`)
		expect(r.ok).toBe(true)
		expect(r.verdict).toBe("safe")
		expect(r.riskScore).toBeUndefined()
	})

	it("defaults riskScore to undefined when invalid", () => {
		const r = parseClassifierOutput(`{"verdict":"safe","riskScore":"critical","reason":"fine"}`)
		expect(r.ok).toBe(true)
		expect(r.verdict).toBe("safe")
		expect(r.riskScore).toBeUndefined()
	})
})
