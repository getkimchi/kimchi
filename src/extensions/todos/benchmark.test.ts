import { beforeEach, describe, expect, it } from "vitest"
import type { Ferment } from "../../ferment/types.js"
import type { FermentRuntime } from "../ferment/runtime.js"
import { __test_renderTodoPromptBlock, __test_resetTodoWidgetState } from "./index.js"
import { __resetTodoStore, applyWriteTodos, setActiveFermentTodoScopeProvider } from "./store.js"

const benchmarkEnabled = process.env.KIMCHI_TODOS_BENCHMARK === "1" && !!process.env.KIMCHI_API_KEY
const benchmarkIt = benchmarkEnabled ? it : it.skip

const MODEL = process.env.KIMCHI_TODOS_BENCHMARK_MODEL ?? "kimi-k2.6"
const BASE_URL = process.env.KIMCHI_TODOS_BENCHMARK_BASE_URL ?? "https://llm.kimchi.dev/openai/v1"

interface ChatCompletionChoice {
	finish_reason?: string
	message?: {
		content?: string
		reasoning_content?: string
		tool_calls?: Array<{ function?: { arguments?: string } }>
	}
}

interface TodoBenchmarkScenario {
	blockedPattern: RegExp
	expectedId: number
	expectedPattern: RegExp
	todos: Array<{
		content: string
		status: "blocked" | "completed" | "in_progress" | "pending"
	}>
}

const NEXT_ACTION_SCENARIOS: TodoBenchmarkScenario[] = [
	{
		blockedPattern: /release notes|maintainer signoff/i,
		expectedId: 2,
		expectedPattern: /repair.*persistence|persistence.*assertion/i,
		todos: [
			{ content: "collect failing TUI transcript", status: "completed" },
			{ content: "repair Ferment todo persistence assertion", status: "in_progress" },
			{ content: "rerun live todo benchmark", status: "pending" },
			{ content: "publish release notes after maintainer signoff", status: "blocked" },
		],
	},
	{
		blockedPattern: /merge release|approval/i,
		expectedId: 3,
		expectedPattern: /tighten.*timeout|timeout.*assertion/i,
		todos: [
			{ content: "inspect flaky log output", status: "completed" },
			{ content: "add regression fixture", status: "pending" },
			{ content: "tighten timeout assertion", status: "in_progress" },
			{ content: "merge release after approval", status: "blocked" },
		],
	},
	{
		blockedPattern: /docs.*owner|owner.*review/i,
		expectedId: 2,
		expectedPattern: /mann.*whitney|statistical.*comparison/i,
		todos: [
			{ content: "source Eino DeepAgent docs", status: "completed" },
			{ content: "implement Mann Whitney statistical comparison", status: "in_progress" },
			{ content: "design benchmark scenario matrix", status: "pending" },
			{ content: "publish docs after owner review", status: "blocked" },
		],
	},
	{
		blockedPattern: /readme.*release|release.*decision/i,
		expectedId: 2,
		expectedPattern: /validate.*disk|disk.*persistence/i,
		todos: [
			{ content: "write TUI harness seed", status: "completed" },
			{ content: "validate disk persistence after tool call", status: "in_progress" },
			{ content: "rerun non-live TUI suite", status: "pending" },
			{ content: "update README after release decision", status: "blocked" },
		],
	},
	{
		blockedPattern: /tag.*maintainer|maintainer.*tag/i,
		expectedId: 3,
		expectedPattern: /step.*alias|scope.*alias/i,
		todos: [
			{ content: "identify hidden ferment-level todo bug", status: "completed" },
			{ content: "rerun live Ferment TUI suite", status: "pending" },
			{ content: "accept step scope alias in schema", status: "in_progress" },
			{ content: "cut release tag after maintainer approval", status: "blocked" },
		],
	},
]

function makeRuntime(active?: Ferment): FermentRuntime {
	return {
		getActive: () => active,
	} as unknown as FermentRuntime
}

function makeFerment(): Ferment {
	return {
		id: "bench-ferment",
		name: "Todo benchmark ferment",
		status: "running",
		activePhaseId: "phase-1",
		worktree: { path: "/repo" },
		scoping: {},
		phases: [
			{
				id: "phase-1",
				index: 1,
				name: "Benchmark",
				goal: "Measure tactical todo guidance.",
				status: "active",
				steps: [
					{
						id: "step-1",
						index: 1,
						description: "Continue benchmark implementation.",
						status: "running",
					},
				],
			},
		],
		decisions: [],
		memories: [],
		createdAt: "2026-05-29T00:00:00.000Z",
		updatedAt: "2026-05-29T00:00:00.000Z",
	}
}

function seedGlobalTodos(scenario: TodoBenchmarkScenario = NEXT_ACTION_SCENARIOS[0]): string {
	applyWriteTodos({ todos: scenario.todos })
	return __test_renderTodoPromptBlock(makeRuntime())
}

function seedFermentTodos(): string {
	const ferment = makeFerment()
	setActiveFermentTodoScopeProvider(() => ({
		level: "step",
		fermentId: ferment.id,
		phaseId: "phase-1",
		stepId: "step-1",
	}))
	applyWriteTodos({
		todos: [
			{ content: "implement benchmark harness", status: "completed" },
			{ content: "validate model uses active tactical todos", status: "in_progress" },
			{ content: "compare benchmark results against control", status: "pending" },
		],
	})
	return __test_renderTodoPromptBlock(makeRuntime(ferment))
}

function scoreNextAction(result: Record<string, unknown>, scenario: TodoBenchmarkScenario): number {
	const normalized = JSON.stringify(result).toLowerCase()
	let score = 0
	if (scenario.expectedPattern.test(normalized)) score += 3
	if (Number(result.next_todo_id) === scenario.expectedId) score += 2
	if (normalized.includes("in_progress") || normalized.includes("in progress")) score += 1
	if (!scenario.blockedPattern.test(normalized)) score += 1
	return score
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b)
	const middle = Math.floor(sorted.length / 2)
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
}

function mannWhitneyU(sampleA: readonly number[], sampleB: readonly number[]): { pOneSided: number; u: number } {
	const combined = [
		...sampleA.map((value) => ({ group: "a" as const, value })),
		...sampleB.map((value) => ({ group: "b" as const, value })),
	]
	const sorted = [...combined].sort((left, right) => left.value - right.value)
	const ranks = new Map<number, number>()
	for (let index = 0; index < sorted.length; ) {
		let end = index + 1
		while (end < sorted.length && sorted[end].value === sorted[index].value) end += 1
		const averageRank = (index + 1 + end) / 2
		for (let cursor = index; cursor < end; cursor += 1) ranks.set(cursor, averageRank)
		index = end
	}
	const rankSumA = sorted.reduce((sum, item, index) => sum + (item.group === "a" ? (ranks.get(index) ?? 0) : 0), 0)
	const observedU = rankSumA - (sampleA.length * (sampleA.length + 1)) / 2
	const values = combined.map((item) => item.value)
	let permutations = 0
	let asExtreme = 0
	for (const indexes of combinations(values.length, sampleA.length)) {
		const chosen = new Set(indexes)
		const candidateA = values.filter((_value, index) => chosen.has(index))
		const candidateB = values.filter((_value, index) => !chosen.has(index))
		const candidateU = mannWhitneyUValue(candidateA, candidateB)
		permutations += 1
		if (candidateU >= observedU) asExtreme += 1
	}
	return { pOneSided: asExtreme / permutations, u: observedU }
}

function mannWhitneyUValue(sampleA: readonly number[], sampleB: readonly number[]): number {
	let u = 0
	for (const a of sampleA) {
		for (const b of sampleB) {
			if (a > b) u += 1
			else if (a === b) u += 0.5
		}
	}
	return u
}

function* combinations(total: number, choose: number, start = 0, prefix: number[] = []): Generator<number[]> {
	if (prefix.length === choose) {
		yield [...prefix]
		return
	}
	for (let index = start; index <= total - (choose - prefix.length); index += 1) {
		prefix.push(index)
		yield* combinations(total, choose, index + 1, prefix)
		prefix.pop()
	}
}

function scoreFermentTactical(result: Record<string, unknown>): number {
	const normalized = JSON.stringify(result).toLowerCase()
	const scopeTarget = typeof result.scope_target === "string" ? result.scope_target.toLowerCase() : ""
	let score = 0
	if (Number(result.next_todo_id) === 2) score += 2
	if (
		/validate.*model|model.*active tactical|active tactical todos|in_progress|in progress|continue/.test(normalized)
	) {
		score += 2
	}
	if (scopeTarget.includes("step-1") || scopeTarget.includes("active step")) score += 2
	if (scopeTarget.includes("phase-1") || scopeTarget.includes("active phase")) score += 1
	if (normalized.includes("ferment") || scopeTarget.includes("bench-ferment")) score += 1
	if (result.will_complete_ferment_step === false) score += 2
	return score
}

function parseJsonObject(text: string): Record<string, unknown> {
	const withoutThinking = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim()
	const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(withoutThinking)
	const candidates = fenced ? [fenced[1]] : jsonObjectCandidates(withoutThinking)
	for (const candidate of candidates) {
		try {
			return JSON.parse(candidate) as Record<string, unknown>
		} catch {}
	}
	throw new Error(`benchmark model response was not JSON: ${withoutThinking.slice(0, 240)}`)
}

function jsonObjectCandidates(text: string): string[] {
	const candidates: string[] = []
	for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
		let depth = 0
		let inString = false
		let escaped = false
		for (let index = start; index < text.length; index += 1) {
			const char = text[index]
			if (inString) {
				if (escaped) escaped = false
				else if (char === "\\") escaped = true
				else if (char === '"') inString = false
				continue
			}
			if (char === '"') inString = true
			else if (char === "{") depth += 1
			else if (char === "}") {
				depth -= 1
				if (depth === 0) {
					candidates.push(text.slice(start, index + 1))
					break
				}
			}
		}
	}
	return candidates.reverse()
}

async function askModel(system: string, user: string): Promise<Record<string, unknown>> {
	const response = await fetch(`${BASE_URL}/chat/completions`, {
		body: JSON.stringify({
			max_tokens: 2048,
			messages: [
				{
					role: "system",
					content: `${system}\n\nBenchmark response rule: return the requested compact JSON object immediately. Do not include markdown, prose, or chain-of-thought.`,
				},
				{ role: "user", content: user },
			],
			model: MODEL,
			response_format: { type: "json_object" },
			temperature: 0,
		}),
		headers: {
			Authorization: `Bearer ${process.env.KIMCHI_API_KEY}`,
			"Content-Type": "application/json",
		},
		method: "POST",
	})
	if (!response.ok) throw new Error(`benchmark model request failed: ${response.status} ${await response.text()}`)
	const json = (await response.json()) as {
		choices?: ChatCompletionChoice[]
	}
	const choice = json.choices?.[0]
	const content = choice?.message?.content ?? ""
	if (!content.trim()) {
		const fallback = choice?.message?.tool_calls?.[0]?.function?.arguments ?? choice?.message?.reasoning_content ?? ""
		if (fallback.trim().startsWith("{")) return parseJsonObject(fallback)
		throw new Error(
			`benchmark model response had no JSON content: ${JSON.stringify({
				finish_reason: choice?.finish_reason,
				message_keys: Object.keys(choice?.message ?? {}),
				reasoning_length: choice?.message?.reasoning_content?.length ?? 0,
				tool_call_count: choice?.message?.tool_calls?.length ?? 0,
			})}`,
		)
	}
	return parseJsonObject(content)
}

beforeEach(() => {
	__resetTodoStore()
	__test_resetTodoWidgetState()
})

describe("todo guidance benchmark fixtures", () => {
	it("makes current global todos visible to the model prompt", () => {
		const prompt = seedGlobalTodos()

		expect(prompt).toContain("Current Global todos:")
		expect(prompt).toContain("#2 [in_progress] repair Ferment todo persistence assertion")
		expect(prompt).toContain("#4 [blocked] publish release notes after maintainer signoff")
	})

	it("makes active Ferment tactical todos visible to the model prompt", () => {
		const prompt = seedFermentTodos()

		expect(prompt).toContain("DeepAgent-style tactical board")
		expect(prompt).toContain("Current default todo scope is Ferment bench-ferment, phase phase-1, step step-1")
		expect(prompt).toContain("Current Ferment · phase-1/step-1 todos:")
		expect(prompt).toContain("#2 [in_progress] validate model uses active tactical todos")
	})

	it("includes a simple-task guardrail inspired by DeepAgents guidance", () => {
		const prompt = __test_renderTodoPromptBlock(makeRuntime())

		expect(prompt).toContain("Do not use write_todos for a single straightforward or purely conversational task")
	})
})

describe("live todo guidance micro-benchmark", () => {
	benchmarkIt(
		"improves next-action recall over 5 trials compared with no visible todo state",
		{ timeout: 420_000 },
		async () => {
			const withScores: number[] = []
			const withoutScores: number[] = []
			for (const scenario of NEXT_ACTION_SCENARIOS) {
				__resetTodoStore()
				const withTodos = await askModel(
					seedGlobalTodos(scenario),
					[
						"Return strict JSON only with keys next_todo_id, next_action, blocked_todo_ids, reason.",
						"Pick the correct next todo from the visible todo state.",
						"Do not pick completed or blocked todos.",
						"If a todo is already in_progress, prefer continuing it.",
					].join(" "),
				)
				const withoutTodos = await askModel(
					"You are a coding agent. No todo state is visible in this prompt.",
					[
						"Return strict JSON only with keys next_todo_id, next_action, blocked_todo_ids, reason.",
						"Pick the correct next todo from the visible todo state.",
						"Do not pick completed or blocked todos.",
						"If no todo state is visible, use null for unknown fields.",
					].join(" "),
				)

				withScores.push(scoreNextAction(withTodos, scenario))
				withoutScores.push(scoreNextAction(withoutTodos, scenario))
			}

			const stats = mannWhitneyU(withScores, withoutScores)
			console.info(
				JSON.stringify({
					medianWithTodos: median(withScores),
					medianWithoutTodos: median(withoutScores),
					pOneSided: stats.pOneSided,
					u: stats.u,
					withScores,
					withoutScores,
				}),
			)
			expect(withScores.every((score) => score >= 5)).toBe(true)
			expect(median(withScores)).toBeGreaterThan(median(withoutScores))
			expect(stats.pOneSided).toBeLessThanOrEqual(0.05)
		},
	)

	benchmarkIt("keeps Ferment tactical work anchored to the active step", { timeout: 180_000 }, async () => {
		const result = await askModel(
			seedFermentTodos(),
			[
				"Return strict JSON only with keys next_todo_id, next_action, scope_target, will_complete_ferment_step, reason.",
				"Continue the current active Ferment work using the visible tactical todo state.",
				"Do not complete or change Ferment phase or step state.",
			].join(" "),
		)
		const score = scoreFermentTactical(result)

		console.info(JSON.stringify({ fermentTacticalScore: score, fermentTacticalResult: result }))
		expect(score).toBeGreaterThanOrEqual(7)
		expect(result.will_complete_ferment_step).toBe(false)
	})

	benchmarkIt("discourages todo overhead for a single straightforward task", { timeout: 180_000 }, async () => {
		const result = await askModel(
			__test_renderTodoPromptBlock(makeRuntime()),
			[
				"Return strict JSON only with keys should_use_write_todos, reason.",
				"Task: answer one factual question in one sentence. Should you call write_todos first?",
			].join(" "),
		)

		expect(result.should_use_write_todos).toBe(false)
	})
})
