import { beforeEach, describe, expect, it } from "vitest"
import { __test_renderTodoPromptBlock } from "./prompt-block.js"
import { __resetTodoStore, applyWriteTodos } from "./store.js"

const benchmarkEnabled = process.env.KIMCHI_TODOS_BENCHMARK === "1" && !!process.env.KIMCHI_API_KEY
const MODEL = process.env.KIMCHI_TODOS_BENCHMARK_MODEL ?? "kimi-k2.6"
const BASE_URL = process.env.KIMCHI_TODOS_BENCHMARK_BASE_URL ?? "https://api.moonshot.ai/v1/chat/completions"

interface TodoBenchmarkScenario {
	name: string
	todos: Array<{ content: string; status: "pending" | "in_progress" | "blocked" | "completed" }>
	user: string
	expected: RegExp
}

const NEXT_ACTION_SCENARIOS: TodoBenchmarkScenario[] = [
	{
		name: "continue active item",
		todos: [
			{ content: "wire write_todos tool", status: "in_progress" },
			{ content: "add overlay command", status: "pending" },
		],
		user: "What should you do next?",
		expected: /wire write_todos tool/i,
	},
	{
		name: "skip completed item",
		todos: [
			{ content: "write reducer tests", status: "completed" },
			{ content: "connect resource toggle", status: "pending" },
		],
		user: "Pick the next implementation task.",
		expected: /connect resource toggle/i,
	},
	{
		name: "surface blocked item",
		todos: [
			{ content: "wait for API key", status: "blocked" },
			{ content: "document manual check", status: "pending" },
		],
		user: "What risk should you mention before continuing?",
		expected: /wait for API key/i,
	},
	{
		name: "preserve order",
		todos: [
			{ content: "finish command parser", status: "pending" },
			{ content: "run focused tests", status: "pending" },
		],
		user: "Choose the next pending task.",
		expected: /finish command parser/i,
	},
	{
		name: "follow current list",
		todos: [
			{ content: "fix lint import order", status: "in_progress" },
			{ content: "run smoke tests", status: "pending" },
		],
		user: "Name the immediate next action.",
		expected: /fix lint import order/i,
	},
]

describe("todo guidance benchmark fixtures", () => {
	beforeEach(() => {
		__resetTodoStore()
	})

	it("renders current todos into the guidance block", () => {
		applyWriteTodos({
			todos: [
				{ content: "alpha", status: "in_progress" },
				{ content: "bravo", status: "pending" },
			],
		})

		expect(__test_renderTodoPromptBlock()).toContain(
			"Current global todos:\n- #1 [in_progress] alpha\n- #2 [pending] bravo",
		)
	})

	it("keeps the simple-task guardrail in prompt text", () => {
		expect(__test_renderTodoPromptBlock()).toContain(
			"Do not use write_todos for a single straightforward or purely conversational task.",
		)
	})
})

describe.skipIf(!benchmarkEnabled)("todo next-action recall live benchmark", () => {
	beforeEach(() => {
		__resetTodoStore()
	})

	it("scores visible todos above no-todos baseline", async () => {
		const withTodosScores: number[] = []
		const withoutTodosScores: number[] = []

		for (const scenario of NEXT_ACTION_SCENARIOS) {
			withoutTodosScores.push(scoreNextAction(await askModel(baseGuidance(), scenario.user), scenario.expected))

			__resetTodoStore()
			applyWriteTodos({ todos: scenario.todos })
			withTodosScores.push(
				scoreNextAction(await askModel(__test_renderTodoPromptBlock(), scenario.user), scenario.expected),
			)
		}

		const p = mannWhitneyExactP(withTodosScores, withoutTodosScores)
		expect(average(withTodosScores)).toBeGreaterThan(average(withoutTodosScores))
		expect(p).toBeLessThanOrEqual(0.05)
	}, 180_000)
})

function baseGuidance(): string {
	return 'You are a coding agent. Answer with JSON only: {"next_action":"..."}.'
}

async function askModel(system: string, user: string): Promise<string> {
	const response = await fetch(BASE_URL, {
		method: "POST",
		headers: {
			authorization: `Bearer ${process.env.KIMCHI_API_KEY}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: MODEL,
			messages: [
				{ role: "system", content: `${system}\n${baseGuidance()}` },
				{ role: "user", content: user },
			],
			temperature: 0,
			response_format: { type: "json_object" },
		}),
	})
	if (!response.ok) throw new Error(`Benchmark request failed: ${response.status} ${await response.text()}`)

	const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
	return data.choices?.[0]?.message?.content ?? ""
}

function scoreNextAction(raw: string, expected: RegExp): number {
	const parsed = parseJsonObject(raw)
	const nextAction = typeof parsed.next_action === "string" ? parsed.next_action : raw
	return expected.test(nextAction) ? 1 : 0
}

function parseJsonObject(raw: string): Record<string, unknown> {
	try {
		return JSON.parse(raw) as Record<string, unknown>
	} catch {
		return {}
	}
}

function average(values: readonly number[]): number {
	return values.reduce((sum, value) => sum + value, 0) / values.length
}

function mannWhitneyExactP(a: readonly number[], b: readonly number[]): number {
	const observed = mannWhitneyU(a, b)
	const combined = [...a, ...b]
	let asExtreme = 0
	let total = 0

	for (const indexes of combinations([...combined.keys()], a.length)) {
		const inA = new Set(indexes)
		const candidateA = combined.filter((_value, index) => inA.has(index))
		const candidateB = combined.filter((_value, index) => !inA.has(index))
		if (mannWhitneyU(candidateA, candidateB) >= observed) asExtreme += 1
		total += 1
	}

	return asExtreme / total
}

function mannWhitneyU(a: readonly number[], b: readonly number[]): number {
	let u = 0
	for (const left of a) {
		for (const right of b) {
			if (left > right) u += 1
			else if (left === right) u += 0.5
		}
	}
	return u
}

function* combinations(values: number[], size: number, start = 0, prefix: number[] = []): Generator<number[]> {
	if (prefix.length === size) {
		yield prefix
		return
	}
	for (let index = start; index < values.length; index += 1) {
		yield* combinations(values, size, index + 1, [...prefix, values[index]])
	}
}
