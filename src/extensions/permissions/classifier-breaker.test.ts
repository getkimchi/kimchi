import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createModel, createModelRegistry } from "../__mocks__/model-registry.js"
import { classifyToolCall } from "./classifier.js"
import { classifyToolCallViaBreaker, resetClassifierBreakerForTests } from "./classifier-breaker.js"
import { CLASSIFIER_BREAKER_WINDOW_MS } from "./constants.js"
import type { ClassifierFailureCode, ClassifierResult } from "./types.js"

vi.mock("./classifier.js", () => ({
	classifyToolCall: vi.fn(),
}))

const mockRegistry = createModelRegistry()

const candidates = [createModel("deepseek-v4-flash-0731")]
const call = { toolName: "bash", input: { command: "touch x" }, cwd: "/test" }
const options = { context: {} as never, timeoutMs: 8000, maxTotalMs: 25_000 }

function failure(failureCode: ClassifierFailureCode, reason = "classifier failed"): ClassifierResult {
	return { verdict: "requires-confirmation", ok: false, reason, failureCode }
}

function okResult(): ClassifierResult {
	return { verdict: "safe", ok: true, reason: "fine", usedModelId: "deepseek-v4-flash-0731" }
}

describe("classifier breaker", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		resetClassifierBreakerForTests()
		vi.mocked(classifyToolCall).mockReset()
	})
	afterEach(() => {
		vi.useRealTimers()
		resetClassifierBreakerForTests()
	})

	it.each([
		"timeout",
		"provider_error",
		"budget_exhausted",
		"auth_timeout",
		"auth_unavailable",
	] as const)("trips on %s and serves the stored failure without calling the provider", async (code) => {
		vi.mocked(classifyToolCall).mockResolvedValueOnce(failure(code))
		const first = await classifyToolCallViaBreaker(candidates, mockRegistry, call, options)
		expect(first.tripped).toBe(true)
		expect(first.fromBreaker).toBe(false)
		expect(classifyToolCall).toHaveBeenCalledTimes(1)

		const second = await classifyToolCallViaBreaker(candidates, mockRegistry, call, options)
		expect(second.fromBreaker).toBe(true)
		expect(second.result).toEqual(first.result)
		expect(classifyToolCall).toHaveBeenCalledTimes(1)
	})

	it.each([
		"aborted",
		"invalid_output",
		"no_api_key",
		"no_candidates",
	] as const)("does not trip on %s — the provider is called again", async (code) => {
		vi.mocked(classifyToolCall).mockResolvedValue(failure(code))
		const first = await classifyToolCallViaBreaker(candidates, mockRegistry, call, options)
		expect(first.tripped).toBe(false)
		const second = await classifyToolCallViaBreaker(candidates, mockRegistry, call, options)
		expect(second.fromBreaker).toBe(false)
		expect(classifyToolCall).toHaveBeenCalledTimes(2)
	})

	it("reopens for another window after a failed probe", async () => {
		vi.mocked(classifyToolCall).mockResolvedValueOnce(failure("timeout")).mockResolvedValueOnce(failure("timeout"))
		await classifyToolCallViaBreaker(candidates, mockRegistry, call, options)
		vi.advanceTimersByTime(CLASSIFIER_BREAKER_WINDOW_MS)
		const probe = await classifyToolCallViaBreaker(candidates, mockRegistry, call, options)
		expect(probe.tripped).toBe(true)
		expect(probe.fromBreaker).toBe(false)
		// Re-opened: the next call is served from the stored failure again.
		const next = await classifyToolCallViaBreaker(candidates, mockRegistry, call, options)
		expect(next.fromBreaker).toBe(true)
		expect(classifyToolCall).toHaveBeenCalledTimes(2)
	})

	it("runs the probe with the normal ladder options — a probe succeeds whenever a normal call would", async () => {
		vi.mocked(classifyToolCall).mockResolvedValueOnce(failure("timeout")).mockResolvedValueOnce(okResult())
		await classifyToolCallViaBreaker(candidates, mockRegistry, call, options)
		vi.advanceTimersByTime(CLASSIFIER_BREAKER_WINDOW_MS)
		await classifyToolCallViaBreaker(candidates, mockRegistry, call, options)
		const probeOptions = vi.mocked(classifyToolCall).mock.calls[1]?.[3]
		expect(probeOptions).toEqual(options)
	})

	it("closes the breaker when a probe fails with a non-outage code", async () => {
		vi.mocked(classifyToolCall)
			.mockResolvedValueOnce(failure("timeout"))
			.mockResolvedValueOnce(failure("invalid_output"))
		await classifyToolCallViaBreaker(candidates, mockRegistry, call, options)
		vi.advanceTimersByTime(CLASSIFIER_BREAKER_WINDOW_MS)
		const probe = await classifyToolCallViaBreaker(candidates, mockRegistry, call, options)
		// The backend answered — not an outage. The breaker closes without a
		// recovery notice and the failure is handled like a normal call's.
		expect(probe.recovered).toBe(false)
		expect(probe.tripped).toBe(false)
		vi.mocked(classifyToolCall).mockResolvedValueOnce(okResult())
		const next = await classifyToolCallViaBreaker(candidates, mockRegistry, call, options)
		expect(next.fromBreaker).toBe(false)
		expect(classifyToolCall).toHaveBeenCalledTimes(3)
	})

	it("re-arms the breaker and rethrows when a probe throws", async () => {
		vi.mocked(classifyToolCall).mockResolvedValueOnce(failure("timeout")).mockRejectedValueOnce(new Error("boom"))
		await classifyToolCallViaBreaker(candidates, mockRegistry, call, options)
		vi.advanceTimersByTime(CLASSIFIER_BREAKER_WINDOW_MS)
		await expect(classifyToolCallViaBreaker(candidates, mockRegistry, call, options)).rejects.toThrow("boom")
		// The next call must probe again — not stay wedged on the stored failure.
		vi.mocked(classifyToolCall).mockResolvedValueOnce(okResult())
		const next = await classifyToolCallViaBreaker(candidates, mockRegistry, call, options)
		expect(next.recovered).toBe(true)
	})

	it("does not re-trip or overwrite the stored failure when concurrent calls fail together", async () => {
		vi.mocked(classifyToolCall)
			.mockResolvedValueOnce(failure("timeout", "first"))
			.mockResolvedValueOnce(failure("timeout", "second"))
		const [first, second] = await Promise.all([
			classifyToolCallViaBreaker(candidates, mockRegistry, call, options),
			classifyToolCallViaBreaker(candidates, mockRegistry, call, options),
		])
		expect(first.tripped).toBe(true)
		expect(second.tripped).toBe(false)
		// The stored failure is the first trip's; the window was not reset.
		const stored = await classifyToolCallViaBreaker(candidates, mockRegistry, call, options)
		expect(stored.fromBreaker).toBe(true)
		expect(stored.result.reason).toBe("first")
	})

	it("closes on a successful probe and reports recovery once", async () => {
		vi.mocked(classifyToolCall).mockResolvedValueOnce(failure("provider_error")).mockResolvedValueOnce(okResult())
		const first = await classifyToolCallViaBreaker(candidates, mockRegistry, call, options)
		expect(first.tripped).toBe(true)
		vi.advanceTimersByTime(CLASSIFIER_BREAKER_WINDOW_MS)
		const probe = await classifyToolCallViaBreaker(candidates, mockRegistry, call, options)
		expect(probe.recovered).toBe(true)
		expect(probe.result.ok).toBe(true)

		// Closed again: the provider is consulted normally, no recovery signal.
		vi.mocked(classifyToolCall).mockResolvedValueOnce(okResult())
		const next = await classifyToolCallViaBreaker(candidates, mockRegistry, call, options)
		expect(next.recovered).toBe(false)
		expect(next.fromBreaker).toBe(false)
		expect(classifyToolCall).toHaveBeenCalledTimes(3)
	})

	it("lets the next call probe again when a probe is aborted", async () => {
		vi.mocked(classifyToolCall)
			.mockResolvedValueOnce(failure("timeout"))
			.mockResolvedValueOnce(failure("aborted", "classifier aborted"))
		await classifyToolCallViaBreaker(candidates, mockRegistry, call, options)
		vi.advanceTimersByTime(CLASSIFIER_BREAKER_WINDOW_MS)
		const probe = await classifyToolCallViaBreaker(candidates, mockRegistry, call, options)
		expect(probe.tripped).toBe(false)
		expect(probe.recovered).toBe(false)
		// Aborted probe: the breaker must not close, and the next call probes
		// immediately (no fresh 60 s window).
		vi.mocked(classifyToolCall).mockResolvedValueOnce(okResult())
		const next = await classifyToolCallViaBreaker(candidates, mockRegistry, call, options)
		expect(next.recovered).toBe(true)
	})

	it("serves the stored failure to concurrent callers while one call probes", async () => {
		vi.mocked(classifyToolCall).mockResolvedValueOnce(failure("timeout"))
		await classifyToolCallViaBreaker(candidates, mockRegistry, call, options)
		vi.advanceTimersByTime(CLASSIFIER_BREAKER_WINDOW_MS)

		let releaseProbe: (result: ClassifierResult) => void = () => {}
		const probeGate = new Promise<ClassifierResult>((resolve) => {
			releaseProbe = resolve
		})
		vi.mocked(classifyToolCall).mockReturnValueOnce(probeGate)

		const probeCall = classifyToolCallViaBreaker(candidates, mockRegistry, call, options)
		const concurrent = await classifyToolCallViaBreaker(candidates, mockRegistry, call, options)
		expect(concurrent.fromBreaker).toBe(true)
		expect(classifyToolCall).toHaveBeenCalledTimes(2)

		releaseProbe(okResult())
		const probe = await probeCall
		expect(probe.recovered).toBe(true)
	})
})
