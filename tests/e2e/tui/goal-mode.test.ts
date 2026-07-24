import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { STARTUP_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import type { FakeResponseRequest, FakeResponseScript } from "./support/fake-openai-server.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("experimental goal stops after exact-revision completion", async ({ terminal }) => {
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
	const finishTodosResponse: FakeResponseScript = {
		stream: ["Working toward the session goal.", " Verification is complete."],
		textDelayMs: 1_000,
		toolCalls: [
			{
				id: "finish-goal-todo",
				function: { name: "mark_todo", arguments: JSON.stringify({ id: 1, status: "completed" }) },
			},
			{
				id: "clear-goal-todos",
				index: 1,
				function: { name: "clear_todos", arguments: "{}" },
			},
		],
	}
	const completionResponse: FakeResponseScript = {
		stream: ["Finalizing the session goal."],
		toolCalls: [
			{
				id: "complete-goal",
				function: { name: "update_goal", arguments: "{}" },
			},
		],
	}
	const completionToolCall = completionResponse.toolCalls?.[0]
	if (!completionToolCall) throw new Error("Goal completion tool call fixture is missing.")

	await runKimchiSession(
		terminal,
		{
			artifactName: "goal-mode",
			seedHome: (homeDir) => enableGoalMode(homeDir),
			responses: [
				planningResponse,
				finishTodosResponse,
				completionResponse,
				{ stream: ["Goal completion acknowledged."] },
			],
		},
		async (fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("ready with experimental goal resource enabled")

			terminal.submit("/goal --tokens 2k implement feature A")
			await waitForText(terminal, "Goal created.", { timeoutMs: 5_000 })
			await waitForText(terminal, "Goal running · <1m · 0/2.0k tokens", { timeoutMs: 5_000 })

			const goal = goalSnapshot(await waitForChatRequest(fixture.fake.requests, 1))
			expect(goal).toMatchObject({
				revision: 1,
				objective: "implement feature A",
				status: "active",
				tokenBudget: 2_000,
			})
			completionToolCall.function.arguments = JSON.stringify({
				goalId: goal.id,
				revision: goal.revision,
				status: "complete",
			})
			trace.step("model received canonical revision 1 goal context")
			await waitForText(terminal, "Implement feature A", { timeoutMs: 5_000 })
			await waitForText(terminal, "Working toward the session goal.", { timeoutMs: 5_000 })

			await waitForText(terminal, "Goal complete in", { timeoutMs: 5_000 })
			await waitForText(terminal, "Goal completion acknowledged.", { timeoutMs: 5_000 })
			const completedRequestCount = chatRequests(fixture.fake.requests).length
			await new Promise((resolve) => setTimeout(resolve, 2_000))
			expect(chatRequests(fixture.fake.requests)).toHaveLength(completedRequestCount)
			trace.step("complete goal did not schedule another continuation")
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
	id: string
	revision: number
	objective: string
	status: string
	tokenBudget?: number
} {
	const context = collectStrings(request.body).find((value) => value.includes("<kimchi_session_goal>"))
	const match = context?.match(/<kimchi_session_goal>\s*(\{[\s\S]*?\})\s*Autonomous goal continuation/)
	if (!match) throw new Error(`No canonical goal context found in request: ${JSON.stringify(request.body)}`)
	return JSON.parse(match[1])
}

function collectStrings(value: unknown): string[] {
	if (typeof value === "string") return [value]
	if (Array.isArray(value)) return value.flatMap(collectStrings)
	if (value && typeof value === "object") return Object.values(value).flatMap(collectStrings)
	return []
}
