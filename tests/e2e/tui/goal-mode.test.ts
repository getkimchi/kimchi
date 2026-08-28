import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { STARTUP_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import type { FakeResponseRequest, FakeResponseScript } from "./support/fake-openai-server.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("experimental goal evaluates continue, resumes work, then completes", async ({ terminal }) => {
	const planningResponse: FakeResponseScript = {
		stream: ["Creating a tactical plan."],
		toolCalls: [
			{
				id: "create-goal-todos",
				function: {
					name: "create_todos",
					arguments: JSON.stringify({
						todos: [{ content: "Implement feature A", status: "in_progress" }],
					}),
				},
			},
		],
	}
	const planningStopResponse: FakeResponseScript = {
		stream: ["The plan is ready; implementation still remains."],
	}
	const continueEvaluationResponse: FakeResponseScript = {
		match: isGoalEvaluatorRequest,
		stream: [
			'{"verdict":"continue","checks":[{"requirement":"Implement feature A","met":false,"evidence":["m1"],"todoIds":[1]}],"reason":"Implementation is not evidenced yet."}',
		],
	}
	const finishTodosResponse: FakeResponseScript = {
		stream: ["Working toward the session goal.", " Verification is complete."],
		textDelayMs: 1_000,
		toolCalls: [
			{
				id: "finish-goal-todo",
				function: {
					name: "mark_todo",
					arguments: JSON.stringify({
						id: 1,
						status: "completed",
						note: "Evidence: scripted verification completed",
					}),
				},
			},
		],
	}
	const completionResponse: FakeResponseScript = {
		stream: ["Finalizing the session goal."],
		toolCalls: [
			{
				id: "complete-goal",
				function: {
					name: "update_goal",
					arguments: JSON.stringify({ status: "complete", completion_confidence: "proven" }),
				},
			},
		],
	}
	const metEvaluationResponse: FakeResponseScript = {
		match: isGoalEvaluatorRequest,
		stream: [
			'{"verdict":"met","checks":[{"requirement":"Implement feature A","met":true,"evidence":["l1"],"todoIds":[1]}],"reason":"The Todo is completed and the retained evidence records verification."}',
		],
	}

	await runKimchiSession(
		terminal,
		{
			artifactName: "goal-mode",
			seedHome: (homeDir) => enableGoalMode(homeDir),
			responses: [
				continueEvaluationResponse,
				metEvaluationResponse,
				planningResponse,
				planningStopResponse,
				finishTodosResponse,
				completionResponse,
			],
		},
		async (fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			expect(viewText(terminal)).not.toContain("Goal")
			trace.step("no goal segment before a goal exists, with experimental goal resource enabled")

			terminal.submit("/goal --tokens 2k implement feature A")
			await waitForText(terminal, "Goal created.", { timeoutMs: 5_000 })
			await waitForText(terminal, "Goal running · <1m · 0/2.0k tokens", { timeoutMs: 5_000 })

			const goal = goalSnapshot(await waitForChatRequest(fixture.fake.requests, 1))
			expect(goal).toMatchObject({
				objective: "implement feature A",
				status: "active",
				tokenBudget: 2_000,
			})
			trace.step("model received canonical goal context")
			await waitForText(terminal, "Implement feature A", { timeoutMs: 5_000 })
			await waitForText(terminal, "The plan is ready; implementation still remains.", { timeoutMs: 5_000 })
			await waitForText(terminal, "Working toward the session goal.", { timeoutMs: 5_000 })

			await waitForText(terminal, "Goal complete.", { timeoutMs: 5_000 })
			await waitForText(terminal, /goal reported verification\s+proven/, { timeoutMs: 5_000 })
			terminal.submit("/goal")
			await waitForText(terminal, "Evaluations: 2", { timeoutMs: 5_000 })
			await waitForText(terminal, "Last evaluation: met", { timeoutMs: 5_000 })
			const finalView = viewText(terminal)
			expect(finalView).not.toContain("Goal not met")
			expect(finalView).not.toContain("goal time")
			expect(finalView).not.toContain("Goal complete in")
			expect(finalView).not.toContain("Get Goal")
			expect(finalView).not.toContain("Update Goal")
			await new Promise((resolve) => setTimeout(resolve, 2_000))
			expect(chatRequests(fixture.fake.requests)).toHaveLength(6)
			trace.step("continue then met evaluation completed without duplicate Goal UI")
		},
	)
})

test("experimental goal shows the reason when work is blocked", async ({ terminal }) => {
	const blockedReason = "Needs a user-owned API token."
	await runKimchiSession(
		terminal,
		{
			artifactName: "goal-mode-blocked",
			seedHome: (homeDir) => enableGoalMode(homeDir),
			responses: [
				{
					stream: ["I cannot continue without user input."],
					toolCalls: [
						{
							id: "block-goal",
							function: {
								name: "update_goal",
								arguments: JSON.stringify({ status: "blocked", reason: blockedReason }),
							},
						},
					],
				},
			],
		},
		async (fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })

			terminal.submit("/goal finish the authenticated setup")
			await waitForText(terminal, "Goal blocked.", { timeoutMs: 5_000 })
			terminal.submit("/goal")
			await waitForText(terminal, "Status: blocked", { timeoutMs: 5_000 })
			await waitForText(terminal, `Blocked reason: ${blockedReason}`, { timeoutMs: 5_000 })
			await new Promise((resolve) => setTimeout(resolve, 500))
			expect(chatRequests(fixture.fake.requests)).toHaveLength(1)
			trace.step("blocked Goal reports its persisted reason without an evaluator call")
		},
	)
})

function enableGoalMode(homeDir: string): void {
	const settingsPath = join(homeDir, ".config", "kimchi", "harness", "settings.json")
	const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>
	settings.resources = { "extensions.goal": true }
	writeFileSync(settingsPath, `${JSON.stringify(settings, null, "\t")}\n`, "utf-8")
}

async function waitForChatRequest(requests: FakeResponseRequest[], count: number): Promise<FakeResponseRequest> {
	const deadline = Date.now() + 5_000
	while (Date.now() < deadline) {
		const request = chatRequests(requests)[count - 1]
		if (request) return request
		await new Promise((resolve) => setTimeout(resolve, 100))
	}
	throw new Error(`Timed out waiting for chat request ${count}.`)
}

function chatRequests(requests: FakeResponseRequest[]): FakeResponseRequest[] {
	return requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
}

function goalSnapshot(request: FakeResponseRequest): {
	objective: string
	status: string
	tokenBudget?: number
} {
	const context = collectStrings(request.body).find((value) => value.includes("<kimchi_session_goal>"))
	const match = context?.match(/<kimchi_session_goal>\s*(\{[\s\S]*?\})\s*Autonomous Goal continuation/)
	if (!match) throw new Error(`No canonical goal context found in request: ${JSON.stringify(request.body)}`)
	return JSON.parse(match[1])
}

function collectStrings(value: unknown): string[] {
	if (typeof value === "string") return [value]
	if (Array.isArray(value)) return value.flatMap(collectStrings)
	if (value && typeof value === "object") return Object.values(value).flatMap(collectStrings)
	return []
}

function isGoalEvaluatorRequest(request: FakeResponseRequest): boolean {
	return collectStrings(request.body).some((value) => value.includes("<goal_evaluator>"))
}
