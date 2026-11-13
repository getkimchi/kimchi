import { readFileSync } from "node:fs"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
	batchChoice,
	DECISION_BATCH_SIZE,
	DECISION_QUESTION_CAP,
	DecisionBreaker,
	DecisionGateError,
	decide,
	MEMORY_DECISION_TAG,
	sharedDecisionBreaker,
	systemoneEndpoint,
} from "./decision-gate.js"
import { usageLedgerPath } from "./usage-ledger.js"

beforeEach(() => {
	// The shared breaker is process-global state: failure-injecting tests
	// would otherwise wedge later tests' decides into circuit-open mode.
	sharedDecisionBreaker.recordSuccess()
})

/** The last usage-ledger row (rows accumulate across this file's tests). */
function lastLedgerRow(): Record<string, unknown> {
	const lines = readFileSync(usageLedgerPath(), "utf-8")
		.split("\n")
		.filter((line) => line.length > 0)
	const last = lines[lines.length - 1]
	if (!last) throw new Error("usage ledger has no rows")
	return JSON.parse(last) as Record<string, unknown>
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
}

function answersBody(names: string[]): unknown {
	return {
		id: "decision-x",
		model: "d3",
		answers: Object.fromEntries(
			names.map((n) => [n, { type: "choice", choice: "yes", probabilities: { yes: 0.8, no: 0.2 }, confidence: 0.9 }]),
		),
		usage: { input_tokens: 10, output_tokens: 0 },
	}
}

const GATE = { endpoint: "https://gateway.test/typesafe/v1/systemone", apiKey: "k" }

describe("systemoneEndpoint", () => {
	it("strips the openai/v1 surface to mount typesafe at the origin root", () => {
		expect(systemoneEndpoint("https://llm.kimchi.dev/openai/v1")).toBe("https://llm.kimchi.dev/typesafe/v1/systemone")
	})
	it("tolerates an origin-root endpoint and trailing slashes", () => {
		expect(systemoneEndpoint("https://llm.kimchi.dev/")).toBe("https://llm.kimchi.dev/typesafe/v1/systemone")
		expect(systemoneEndpoint("https://eu.example.com/openai/v1//")).toBe("https://eu.example.com/typesafe/v1/systemone")
	})
})

describe("decide", () => {
	it("records a usage-ledger row with kind, model, usage, and question count", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({
				...(answersBody(["q1"]) as Record<string, unknown>),
				usage: { input_tokens: 42, output_tokens: 0 },
			}),
		) as unknown as typeof fetch
		await decide(
			{ ...GATE, fetchImpl },
			"state",
			{ q1: { type: "choice", instructions: "i", criteria: { yes: "y", no: "n" } } },
			"triage",
		)
		expect(lastLedgerRow()).toMatchObject({ kind: "triage", model: "d3", inputTokens: 42, questions: 1 })
	})

	it("records a failed row (zero tokens) when the gateway rejects the call", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ error: "no quota" }, 401)) as unknown as typeof fetch
		await expect(
			decide(
				{ ...GATE, fetchImpl, maxRetries: 0 },
				"s",
				{ q1: { type: "choice", instructions: "i", criteria: { a: "a" } } },
				"recall",
			),
		).rejects.toThrow(/HTTP 401/)
		const row = lastLedgerRow()
		expect(row).toMatchObject({ kind: "recall", failed: true })
		expect(row.inputTokens).toBeUndefined()
	})

	it("posts state, questions, model, and the usage tag; returns validated answers", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(answersBody(["q1", "q2"]))) as unknown as typeof fetch
		const res = await decide({ ...GATE, fetchImpl }, "state text", {
			q1: { type: "choice", instructions: "i1", criteria: { yes: "y", no: "n" } },
			q2: { type: "choice", instructions: "i2", criteria: { yes: "y", no: "n" } },
		})
		expect(res.answers.q1?.choice).toBe("yes")
		expect(res.answers.q2?.probabilities.yes).toBeCloseTo(0.8)
		const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
		if (!call) throw new Error("expected exactly one fetch call")
		expect(String(call[0])).toBe("https://gateway.test/typesafe/v1/systemone")
		const body = JSON.parse(String(call[1].body)) as {
			model: string
			state: string
			tags: string[]
			questions: Record<string, unknown>
		}
		expect(body.model).toBe("d3")
		expect(body.state).toBe("state text")
		expect(body.tags).toEqual([MEMORY_DECISION_TAG])
		expect(Object.keys(body.questions)).toEqual(["q1", "q2"])
	})

	it("sends the SSO organization header only when the gate carries one", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(answersBody(["q1"]))) as unknown as typeof fetch
		const questions = { q1: { type: "choice" as const, instructions: "i", criteria: { yes: "y", no: "n" } } }
		await decide({ ...GATE, organizationId: "org-7", fetchImpl }, "s", questions)
		let call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
		expect((call?.[1]?.headers as Record<string, string>)["X-CastAi-Organization-Id"]).toBe("org-7")

		await decide({ ...GATE, fetchImpl }, "s", questions)
		call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1]
		expect((call?.[1]?.headers as Record<string, string>)["X-CastAi-Organization-Id"]).toBeUndefined()
	})

	it("rejects a question set over the gateway cap without calling fetch", async () => {
		const fetchImpl = vi.fn() as unknown as typeof fetch
		const questions = Object.fromEntries(
			Array.from({ length: DECISION_QUESTION_CAP + 1 }, (_, i) => [
				`q${i}`,
				{ type: "choice" as const, instructions: "i", criteria: { a: "a" } },
			]),
		)
		await expect(decide({ ...GATE, fetchImpl }, "s", questions)).rejects.toBeInstanceOf(DecisionGateError)
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it("rejects an empty question set", async () => {
		await expect(decide(GATE, "s", {})).rejects.toThrow(/no questions/)
	})

	it("degrades with DecisionGateError on non-retryable HTTP (degrade path, never session-fatal)", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ error: "no quota" }, 401)) as unknown as typeof fetch
		await expect(
			decide({ ...GATE, fetchImpl }, "s", { q: { type: "choice", instructions: "i", criteria: { a: "a" } } }),
		).rejects.toThrow(/HTTP 401/)
	})

	it("degrades with DecisionGateError when answers are missing/unparseable", async () => {
		const fetchImpl = vi.fn(async () =>
			jsonResponse({ answers: { q1: { notAnAnswer: true } } }),
		) as unknown as typeof fetch
		await expect(
			decide({ ...GATE, fetchImpl }, "s", { q1: { type: "choice", instructions: "i", criteria: { a: "a" } } }),
		).rejects.toThrow(/missing a parseable answer/)
	})
})

describe("batchChoice", () => {
	it("slices items under the batch bound and returns answers in item order", async () => {
		const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { questions: Record<string, unknown> }
			return jsonResponse(answersBody(Object.keys(body.questions)))
		}) as unknown as typeof fetch
		const items = Array.from({ length: DECISION_BATCH_SIZE * 2 + 3 }, (_, i) => `fact ${i}`)
		const answers = await batchChoice(
			{ ...GATE, fetchImpl },
			"state",
			items,
			(text, i) => ({
				type: "choice",
				instructions: `judge ${text} (#${i})`,
				criteria: { yes: "y", no: "n" },
			}),
			undefined,
			DECISION_BATCH_SIZE,
		)
		expect(answers).toHaveLength(items.length)
		expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(3)
	})

	it("throws DecisionGateError when the response answers the wrong question set", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(answersBody(["item_wrong"]))) as unknown as typeof fetch
		await expect(
			batchChoice({ ...GATE, fetchImpl }, "state", ["only fact"], () => ({
				type: "choice",
				instructions: "i",
				criteria: { a: "a" },
			})),
		).rejects.toBeInstanceOf(DecisionGateError)
	})
})

describe("decide onExchange hook", () => {
	const question = { type: "choice" as const, instructions: "durable?", criteria: { yes: "y", no: "n" } }

	it("receives the exact request body and the full parsed response on success", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(answersBody(["q1"]))) as unknown as typeof fetch
		const exchanges: Array<{ request: Record<string, unknown>; response?: Record<string, unknown> }> = []
		const result = await decide(
			{ ...GATE, fetchImpl, onExchange: (exchange) => exchanges.push(exchange) },
			"the full state text",
			{ q1: question },
		)
		expect(exchanges).toHaveLength(1)
		expect(exchanges[0]?.request).toEqual({
			model: "d3",
			state: "the full state text",
			questions: { q1: question },
			tags: [MEMORY_DECISION_TAG],
		})
		expect(exchanges[0]?.response?.answers).toEqual(result.answers)
		expect(exchanges[0]?.response?.id).toBe("decision-x")
		expect(exchanges[0]?.response?.usage).toEqual({ input_tokens: 10, output_tokens: 0 })
	})

	it("receives the HTTP status on a rejected call", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse({ error: "no quota" }, 401)) as unknown as typeof fetch
		const exchanges: Array<{ error?: string; status?: number }> = []
		await expect(
			decide({ ...GATE, fetchImpl, maxRetries: 0, onExchange: (exchange) => exchanges.push(exchange) }, "s", {
				q1: question,
			}),
		).rejects.toBeInstanceOf(DecisionGateError)
		expect(exchanges).toHaveLength(1)
		expect(exchanges[0]?.status).toBe(401)
	})

	it("receives the error on a network failure after the retry budget", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("socket hang up")
		}) as unknown as typeof fetch
		const exchanges: Array<{ error?: string }> = []
		await expect(
			decide({ ...GATE, fetchImpl, maxRetries: 0, onExchange: (exchange) => exchanges.push(exchange) }, "s", {
				q1: question,
			}),
		).rejects.toThrow("socket hang up")
		expect(exchanges).toHaveLength(1)
		expect(exchanges[0]?.error).toBe("socket hang up")
	})

	it("turn-path regression: no hook configured — behave exactly as before (no hook calls, same result)", async () => {
		const fetchImpl = vi.fn(async () => jsonResponse(answersBody(["q1"]))) as unknown as typeof fetch
		const result = await decide({ ...GATE, fetchImpl }, "s", { q1: question })
		expect(result.answers.q1?.choice).toBe("yes")
		expect(result.usage.input_tokens).toBe(10)
	})
})

describe("DecisionBreaker circuit state machine", () => {
	const question = {
		type: "choice" as const,
		instructions: "is it?",
		criteria: { yes: "yes", no: "no" },
	}

	it("closed circuit passes decides through untouched", async () => {
		const t = 0
		const breaker = new DecisionBreaker({ now: () => t, probeDelayMs: 60_000 })
		const fetchImpl = vi.fn(async () => jsonResponse(answersBody(["q"]))) as unknown as typeof fetch
		for (let i = 0; i < 3; i++) {
			const r = await decide({ ...GATE, breaker, fetchImpl }, "s", { q: question })
			expect(r.answers.q?.choice).toBe("yes")
		}
		expect(fetchImpl).toHaveBeenCalledTimes(3)
		expect(breaker.shouldSkip()).toBe(false)
	})

	it("opens only after the consecutive-failure threshold; skips without fetching once open", async () => {
		const t = 0
		const breaker = new DecisionBreaker({ now: () => t, threshold: 2, probeDelayMs: 60_000 })
		const bad = vi.fn(async () => {
			throw new Error("read ETIMEDOUT")
		}) as unknown as typeof fetch
		const opts = { ...GATE, breaker, fetchImpl: bad, maxRetries: 0 } as const
		await expect(decide(opts, "s", { q: question })).rejects.toThrow("ETIMEDOUT")
		expect(breaker.shouldSkip()).toBe(false) // one specimen is NOT an outage
		await expect(decide(opts, "s", { q: question })).rejects.toThrow("ETIMEDOUT")
		expect(breaker.shouldSkip()).toBe(true) // second consecutive failure opens
		for (let i = 0; i < 5; i++) {
			await expect(decide(opts, "s", { q: question })).rejects.toBeInstanceOf(DecisionGateError)
		}
		expect(bad).toHaveBeenCalledTimes(2) // skipped calls never touched the wire
	})

	it("probe window admits exactly one specimen; success closes the circuit", async () => {
		let t = 0
		const breaker = new DecisionBreaker({ now: () => t, threshold: 1, probeDelayMs: 60_000 })
		const bad = vi.fn(async () => {
			throw new Error("EHOSTUNREACH")
		}) as unknown as typeof fetch
		await expect(decide({ ...GATE, breaker, fetchImpl: bad, maxRetries: 0 }, "s", { q: question })).rejects.toThrow()
		expect(breaker.shouldSkip()).toBe(true)
		t = 61_000
		expect(breaker.shouldSkip()).toBe(false) // probe due
		const good = vi.fn(async () => jsonResponse(answersBody(["q"]))) as unknown as typeof fetch
		const r = await decide({ ...GATE, breaker, fetchImpl: good }, "s", { q: question })
		expect(r.answers.q?.choice).toBe("yes")
		expect(breaker.shouldSkip()).toBe(false) // closed again
	})

	it("failed probe re-opens with doubled backoff (per interval, not per failure)", async () => {
		let t = 0
		const breaker = new DecisionBreaker({ now: () => t, threshold: 1, probeDelayMs: 60_000 })
		const bad = vi.fn(async () => {
			throw new Error("reset")
		}) as unknown as typeof fetch
		const opts = { ...GATE, breaker, fetchImpl: bad, maxRetries: 0 } as const
		await expect(decide(opts, "s", { q: question })).rejects.toThrow()
		t = 61_000
		await expect(decide(opts, "s", { q: question })).rejects.toThrow() // probe 1 fails → 120s
		t = 61_000 + 61_000
		expect(breaker.shouldSkip()).toBe(true)
		t = 61_000 + 121_000
		expect(breaker.shouldSkip()).toBe(false)
	})

	it("contract failures (valid HTTP, unparseable answers) never trip the breaker", async () => {
		const t = 0
		const breaker = new DecisionBreaker({ now: () => t, threshold: 1, probeDelayMs: 60_000 })
		const badContract = vi.fn(async () =>
			jsonResponse({ id: "x", model: "d3", answers: {}, usage: { input_tokens: 1, output_tokens: 0 } }),
		) as unknown as typeof fetch
		const opts = { ...GATE, breaker, fetchImpl: badContract } as const
		await expect(decide(opts, "s", { q: question })).rejects.toBeInstanceOf(DecisionGateError)
		expect(breaker.shouldSkip()).toBe(false)
		await expect(decide(opts, "s", { q: question })).rejects.toBeInstanceOf(DecisionGateError)
		expect(badContract).toHaveBeenCalledTimes(2)
	})

	it("probe-slot release: an aborted probe leaves the circuit probeable", async () => {
		let t = 0
		const breaker = new DecisionBreaker({ now: () => t, threshold: 1, probeDelayMs: 60_000 })
		// Open via one specimen failure.
		const bad = vi.fn(async () => {
			throw new Error("down")
		}) as unknown as typeof fetch
		await expect(decide({ ...GATE, breaker, fetchImpl: bad, maxRetries: 0 }, "s", { q: question })).rejects.toThrow()
		t = 61_000
		// Reserve the probe slot (the path decide() takes before awaiting).
		expect(breaker.shouldSkip()).toBe(false)
		breaker.reserveProbe()
		expect(breaker.shouldSkip()).toBe(true)
		// Simulate the unexpected-exit guard decide() runs in finally.
		breaker.releaseProbe()
		expect(breaker.shouldSkip()).toBe(false)
	})
})
