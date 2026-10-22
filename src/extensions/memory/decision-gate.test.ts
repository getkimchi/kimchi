import { describe, expect, it, vi } from "vitest"
import {
	batchChoice,
	DECISION_BATCH_SIZE,
	DECISION_QUESTION_CAP,
	DecisionGateError,
	decide,
	MEMORY_DECISION_TAG,
	systemoneEndpoint,
} from "./decision-gate.js"

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
