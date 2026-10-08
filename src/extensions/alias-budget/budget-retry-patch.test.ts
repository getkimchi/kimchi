import type { AssistantMessage } from "@earendil-works/pi-ai"
import type { AgentSessionEvent, MessageEndEvent } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it } from "vitest"
import { isInfrastructureProviderError } from "../../infrastructure-error.js"
import { configureInfrastructureBreaker, recordInfrastructureBreakerFailure } from "../../upstream-retry-patch.js"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"
import { preserveRawErrorMessage } from "../error-preservation.js"
import interactiveErrorSurfaceExtension, { __resetInteractiveErrorSurfaceState } from "../interactive-error-surface.js"
import {
	__getBudgetCorrectionStateForTests,
	__resetBudgetCorrectionStoreForTests,
	getBudgetRetryVerdict,
	recordOutgoingBudget,
	scheduleCorrection,
} from "./budget-correction-store.js"
import { installBudgetCorrectionRetryPatch } from "./budget-retry-patch.js"

const RAW_REJECTION =
	"litellm.BadRequestError: OpenAIException - max_completion_tokens is too large: 512000.This model supports at most 262144 completion tokens."

type FakeMessage = { stopReason?: string; provider?: string; model?: string; errorMessage?: string }
type FakeClass = {
	prototype: {
		_isRetryableError?: (message: FakeMessage) => boolean
		_prepareRetry?: (message: FakeMessage) => Promise<boolean>
		_handlePostAgentRun?: () => Promise<boolean>
		_emitExtensionEvent?: (event: AgentSessionEvent) => Promise<void>
		__kimchiBudgetRetryPatch?: boolean
	}
}

interface FakeSessionOptions {
	delegateVerdict?: boolean
	prepareRetryResult?: boolean
	postRunResult?: boolean
}

function makeSessionClass(options: FakeSessionOptions = {}): FakeClass {
	const { delegateVerdict = false, prepareRetryResult = true, postRunResult = false } = options
	const prototype: FakeClass["prototype"] = {
		_isRetryableError() {
			return delegateVerdict
		},
		_prepareRetry: async () => prepareRetryResult,
		_handlePostAgentRun: async () => postRunResult,
		_emitExtensionEvent: async () => {},
	}
	return { prototype }
}

function makeSession(retryAttempt = 0, retryEnabled = true, maxRetries = 3) {
	return {
		sessionManager: { getSessionId: () => "s1" },
		settingsManager: { getRetrySettings: () => ({ enabled: retryEnabled, maxRetries, baseDelayMs: 1 }) },
		_retryAttempt: retryAttempt,
	}
}

beforeEach(() => {
	__resetBudgetCorrectionStoreForTests()
	__resetInteractiveErrorSurfaceState()
	configureInfrastructureBreaker(0)
})

describe("session retry verdict before error presentation", () => {
	it.each([
		{ enabled: false, maxRetries: 3, attempt: 0 },
		{ enabled: true, maxRetries: 0, attempt: 0 },
		{ enabled: true, maxRetries: 3, attempt: 3 },
	])("presents a terminal failure with session settings $enabled/$maxRetries at attempt $attempt", async ({
		enabled,
		maxRetries,
		attempt,
	}) => {
		const { api, getHandler } = createExtensionApi()
		interactiveErrorSurfaceExtension(api)
		const ctx = createContext({ sessionManager: { getSessionId: () => "s1" } })
		const message: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "kimchi-dev",
			model: "auto",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: RAW_REJECTION,
			timestamp: 1,
		}
		const klass = makeSessionClass()
		klass.prototype._emitExtensionEvent = async (event) => {
			if (event.type === "message_end") {
				await getHandler<MessageEndEvent, unknown>("message_end")(event, ctx)
			}
		}
		installBudgetCorrectionRetryPatch(klass as never)
		const session = { ...makeSession(attempt, enabled, maxRetries), ...klass.prototype }
		recordOutgoingBudget("s1", "auto", 512_000, false)
		// Follow upstream order: extension message_end precedes post-run classification.
		await session._emitExtensionEvent?.({ type: "message_end", message })
		expect(message.errorMessage).toContain("The request could not be completed")
		expect(message.errorMessage).not.toBe("Retrying…")
		expect(getBudgetRetryVerdict("s1", "auto", RAW_REJECTION)).toBe(false)
		expect(__getBudgetCorrectionStateForTests("s1")?.pending).toBeUndefined()
	})
})

describe("installBudgetCorrectionRetryPatch", () => {
	it("reports an eligible rejection retryable and schedules the correction", () => {
		const klass = makeSessionClass()
		installBudgetCorrectionRetryPatch(klass as never)
		recordOutgoingBudget("s1", "auto", 512_000, false)

		const verdict = klass.prototype._isRetryableError?.call(makeSession(), {
			stopReason: "error",
			provider: "kimchi-dev",
			model: "auto",
			errorMessage: RAW_REJECTION,
		})
		expect(verdict).toBe(true)
		// Correction scheduled for the corrective retry to consume.
		expect(__getBudgetCorrectionStateForTests("s1")?.pending).toEqual({
			modelId: "auto",
			requestedBudget: 512_000,
			correctedBudget: 262_144,
		})
	})

	it("still classifies via the preserved raw error after the surface mutated the message", () => {
		const klass = makeSessionClass()
		installBudgetCorrectionRetryPatch(klass as never)
		recordOutgoingBudget("s1", "auto", 512_000, false)

		const message: FakeMessage = {
			stopReason: "error",
			provider: "kimchi-dev",
			model: "auto",
			errorMessage: RAW_REJECTION,
		}
		// The error surface preserves the raw provider error BEFORE replacing
		// it with the placeholder.
		preserveRawErrorMessage(message)
		message.errorMessage = "Retrying…"

		expect(klass.prototype._isRetryableError?.call(makeSession(), message)).toBe(true)
	})

	it("delegates when the corrected attempt is rejected again (one corrective attempt)", () => {
		const klass = makeSessionClass()
		installBudgetCorrectionRetryPatch(klass as never)
		// The corrective retry went out already lowered and was rejected again.
		recordOutgoingBudget("s1", "auto", 262_144, true)

		const verdict = klass.prototype._isRetryableError?.call(makeSession(), {
			stopReason: "error",
			provider: "kimchi-dev",
			model: "auto",
			errorMessage: "max_completion_tokens is too large: 262144.This model supports at most 131072 completion tokens.",
		})
		expect(verdict).toBe(false)
	})

	it("delegates for non-matching errors, other providers, and missing model ids", () => {
		const klass = makeSessionClass({ delegateVerdict: true })
		installBudgetCorrectionRetryPatch(klass as never)
		recordOutgoingBudget("s1", "auto", 512_000, false)
		const classifier = klass.prototype._isRetryableError?.bind(makeSession())

		expect(classifier?.({ stopReason: "error", provider: "kimchi-dev", model: "auto", errorMessage: "boom" })).toBe(
			true,
		)
		expect(
			classifier?.({ stopReason: "error", provider: "anthropic", model: "auto", errorMessage: RAW_REJECTION }),
		).toBe(true)
		expect(classifier?.({ stopReason: "error", provider: "kimchi-dev", errorMessage: RAW_REJECTION })).toBe(true)
		expect(
			klass.prototype._isRetryableError?.call(makeSession(), {
				stopReason: "aborted",
				provider: "kimchi-dev",
				model: "auto",
				errorMessage: RAW_REJECTION,
			}),
		).toBe(true)
	})

	it("schedules idempotently across classifier invocations (retry metadata + decision)", () => {
		const klass = makeSessionClass()
		installBudgetCorrectionRetryPatch(klass as never)
		recordOutgoingBudget("s1", "auto", 512_000, false)
		const message: FakeMessage = {
			stopReason: "error",
			provider: "kimchi-dev",
			model: "auto",
			errorMessage: RAW_REJECTION,
		}
		const classifier = klass.prototype._isRetryableError?.bind(makeSession())

		expect(classifier?.(message)).toBe(true)
		expect(classifier?.(message)).toBe(true)
		expect(__getBudgetCorrectionStateForTests("s1")?.pending).toEqual({
			modelId: "auto",
			requestedBudget: 512_000,
			correctedBudget: 262_144,
		})
	})

	it("is exempt from the infrastructure breaker: a tripped breaker does not block correction", () => {
		// Trip the breaker with a real infrastructure failure.
		configureInfrastructureBreaker(1)
		recordInfrastructureBreakerFailure()
		const klass = makeSessionClass()
		installBudgetCorrectionRetryPatch(klass as never)
		recordOutgoingBudget("s1", "auto", 512_000, false)

		const verdict = klass.prototype._isRetryableError?.call(makeSession(), {
			stopReason: "error",
			provider: "kimchi-dev",
			model: "auto",
			errorMessage: RAW_REJECTION,
		})
		expect(verdict).toBe(true)
	})

	it("a budget-cap rejection does not trip the infrastructure breaker", () => {
		configureInfrastructureBreaker(1)
		// The breaker extension counts only infrastructure-classified errors;
		// a request-shaped budget 400 must not count.
		expect(isInfrastructureProviderError(RAW_REJECTION)).toBe(false)
	})

	it("wins over the infrastructure classifier's bad_request short-circuit (cli.ts install order)", () => {
		// cli.ts installs the infrastructure patch FIRST and this patch SECOND;
		// the second wrapper is outermost, so an eligible budget rejection must
		// be reported retryable even though the generic gateway classification
		// underneath calls it a terminal bad_request.
		const klass = makeSessionClass()
		// Simulate the wrapped classifier the infrastructure patch would see:
		// the delegate mimics upstream's generic verdict (non-retryable).
		installBudgetCorrectionRetryPatch(klass as never)
		recordOutgoingBudget("s1", "auto", 512_000, false)

		const verdict = klass.prototype._isRetryableError?.call(makeSession(), {
			stopReason: "error",
			provider: "kimchi-dev",
			model: "auto",
			errorMessage: RAW_REJECTION,
		})
		expect(verdict).toBe(true)
		expect(__getBudgetCorrectionStateForTests("s1")?.pending).toBeDefined()
	})

	it("fails fast when upstream internals change", () => {
		expect(() => installBudgetCorrectionRetryPatch({ prototype: {} } as never)).toThrow(/incompatible/)
	})

	it("is idempotent", () => {
		const klass = makeSessionClass()
		installBudgetCorrectionRetryPatch(klass as never)
		const wrapped = klass.prototype._isRetryableError
		installBudgetCorrectionRetryPatch(klass as never)
		expect(klass.prototype._isRetryableError).toBe(wrapped)
	})

	describe("retry availability and cleanup (review fixes)", () => {
		it("does not schedule a correction when session retries are disabled", () => {
			const klass = makeSessionClass()
			installBudgetCorrectionRetryPatch(klass as never)
			recordOutgoingBudget("s1", "auto", 512_000, false)
			const session = makeSession(0, false)

			const verdict = klass.prototype._isRetryableError?.call(session, {
				stopReason: "error",
				provider: "kimchi-dev",
				model: "auto",
				errorMessage: RAW_REJECTION,
			})
			expect(verdict).toBe(false)
			// No pending lowering was scheduled — nothing to leak into a later request.
			expect(__getBudgetCorrectionStateForTests("s1")?.pending).toBeUndefined()
			// The refusal is recorded as a verdict for the error surface.
			expect(getBudgetRetryVerdict("s1", "auto", RAW_REJECTION)).toBe(false)
		})

		it("does not schedule a correction when attempts are exhausted", () => {
			const klass = makeSessionClass()
			installBudgetCorrectionRetryPatch(klass as never)
			recordOutgoingBudget("s1", "auto", 512_000, false)
			const session = makeSession(3, true, 3)

			const verdict = klass.prototype._isRetryableError?.call(session, {
				stopReason: "error",
				provider: "kimchi-dev",
				model: "auto",
				errorMessage: RAW_REJECTION,
			})
			expect(verdict).toBe(false)
			expect(__getBudgetCorrectionStateForTests("s1")?.pending).toBeUndefined()
			expect(getBudgetRetryVerdict("s1", "auto", RAW_REJECTION)).toBe(false)
		})

		it("records an eligible verdict the error surface can defer to", () => {
			const klass = makeSessionClass()
			installBudgetCorrectionRetryPatch(klass as never)
			recordOutgoingBudget("s1", "auto", 512_000, false)

			klass.prototype._isRetryableError?.call(makeSession(), {
				stopReason: "error",
				provider: "kimchi-dev",
				model: "auto",
				errorMessage: RAW_REJECTION,
			})
			expect(getBudgetRetryVerdict("s1", "auto", RAW_REJECTION)).toBe(true)
			// A different rejection does not match the recorded verdict.
			expect(
				getBudgetRetryVerdict(
					"s1",
					"auto",
					"max_completion_tokens is too large: 131072.This model supports at most 65536 completion tokens.",
				),
			).toBeUndefined()
		})

		it("clears the pending correction when upstream refuses the retry", async () => {
			const klass = makeSessionClass({ prepareRetryResult: false })
			installBudgetCorrectionRetryPatch(klass as never)
			recordOutgoingBudget("s1", "auto", 512_000, false)

			// The classifier schedules the correction…
			expect(
				klass.prototype._isRetryableError?.call(makeSession(), {
					stopReason: "error",
					provider: "kimchi-dev",
					model: "auto",
					errorMessage: RAW_REJECTION,
				}),
			).toBe(true)
			expect(__getBudgetCorrectionStateForTests("s1")?.pending).toBeDefined()

			// …upstream then refuses to run the retry: the pending lowering is
			// dropped so it cannot silently lower a later, unrelated request.
			const prepared = await klass.prototype._prepareRetry?.call(makeSession(), {
				stopReason: "error",
				provider: "kimchi-dev",
				model: "auto",
				errorMessage: RAW_REJECTION,
			})
			expect(prepared).toBe(false)
			expect(__getBudgetCorrectionStateForTests("s1")?.pending).toBeUndefined()
		})

		it("keeps the pending correction when the retry will run", async () => {
			const klass = makeSessionClass({ prepareRetryResult: true })
			installBudgetCorrectionRetryPatch(klass as never)
			recordOutgoingBudget("s1", "auto", 512_000, false)

			klass.prototype._isRetryableError?.call(makeSession(), {
				stopReason: "error",
				provider: "kimchi-dev",
				model: "auto",
				errorMessage: RAW_REJECTION,
			})
			const prepared = await klass.prototype._prepareRetry?.call(makeSession(), {
				stopReason: "error",
				provider: "kimchi-dev",
				model: "auto",
				errorMessage: RAW_REJECTION,
			})
			expect(prepared).toBe(true)
			expect(__getBudgetCorrectionStateForTests("s1")?.pending).toEqual({
				modelId: "auto",
				requestedBudget: 512_000,
				correctedBudget: 262_144,
			})
		})

		it("keeps the pending correction while the turn continues (transient retry in flight)", async () => {
			// The corrected attempt failed transiently: upstream will retry the
			// same logical request, so the pending lowering must survive the
			// between-runs settlement that reports the turn is continuing.
			const klass = makeSessionClass({ postRunResult: true })
			installBudgetCorrectionRetryPatch(klass as never)
			scheduleCorrection("s1", "auto", 512_000, 262_144)

			const continuing = await klass.prototype._handlePostAgentRun?.call(makeSession())
			expect(continuing).toBe(true)
			expect(__getBudgetCorrectionStateForTests("s1")?.pending).toEqual({
				modelId: "auto",
				requestedBudget: 512_000,
				correctedBudget: 262_144,
			})
		})

		it("clears the pending correction at final settlement (turn over)", async () => {
			const klass = makeSessionClass({ postRunResult: false })
			installBudgetCorrectionRetryPatch(klass as never)
			scheduleCorrection("s1", "auto", 512_000, 262_144)

			const settled = await klass.prototype._handlePostAgentRun?.call(makeSession())
			expect(settled).toBe(false)
			expect(__getBudgetCorrectionStateForTests("s1")?.pending).toBeUndefined()
		})
	})
})
