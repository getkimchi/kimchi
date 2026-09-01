import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { STARTUP_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import type { FakeResponseRequest, FakeResponseScript } from "./support/fake-openai-server.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("experimental Ferment V2 evaluates continue, resumes work, then completes", async ({ terminal }) => {
	const planningResponse: FakeResponseScript = {
		stream: ["Creating a tactical plan."],
		toolCalls: [
			{
				id: "create-ferment-v2-todos",
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
		match: isFermentV2EvaluatorRequest,
		stream: [
			'{"verdict":"continue","checks":[{"requirement":"Implement feature A","met":false,"evidence":["m1"],"todoIds":[1]}],"reason":"Implementation is not evidenced yet."}',
		],
	}
	const finishTodosResponse: FakeResponseScript = {
		stream: ["Working toward the session objective.", " Verification is complete."],
		textDelayMs: 1_000,
		toolCalls: [
			{
				id: "finish-ferment-v2-todo",
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
		stream: ["Finalizing the session objective."],
		toolCalls: [
			{
				id: "complete-ferment-v2",
				function: {
					name: "update_ferment_v2",
					arguments: JSON.stringify({ status: "complete", completion_confidence: "proven" }),
				},
			},
		],
	}
	const metEvaluationResponse: FakeResponseScript = {
		match: isFermentV2EvaluatorRequest,
		stream: [
			'{"verdict":"met","checks":[{"requirement":"Implement feature A","met":true,"failureMode":"the feature could be unverified; l1 records verification","evidence":["l1"],"todoIds":[1]}],"reason":"The Todo is completed and the retained evidence records verification."}',
		],
	}

	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-v2-mode",
			seedHome: (homeDir) => enableFermentV2Mode(homeDir),
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
			expect(viewText(terminal)).not.toContain("Ferment V2")
			trace.step("no Ferment V2 segment before a run exists, with the experimental resource enabled")

			terminal.submit("/ferment-v2 --tokens 2k implement feature A")
			await waitForText(terminal, "Ferment V2 created.", { timeoutMs: 5_000 })

			const fermentV2 = fermentV2Snapshot(await waitForChatRequest(fixture.fake.requests, 1))
			expect(fermentV2).toMatchObject({
				objective: "implement feature A",
				status: "active",
				tokenBudget: 2_000,
			})
			trace.step("model received canonical Ferment V2 context")
			await waitForText(terminal, "Implement feature A", { timeoutMs: 5_000 })
			await waitForText(terminal, "The plan is ready; implementation still remains.", { timeoutMs: 5_000 })
			await waitForText(terminal, "Working toward the session objective.", { timeoutMs: 5_000 })

			await waitForText(terminal, "Ferment V2 complete.", { timeoutMs: 5_000 })
			terminal.submit("/ferment-v2")
			await waitForText(terminal, "Evaluations: 2", { timeoutMs: 5_000 })
			await waitForText(terminal, "Last evaluation: met", { timeoutMs: 5_000 })
			const finalView = viewText(terminal)
			expect(finalView).not.toContain("Ferment V2 not met")
			expect(finalView).not.toContain("fermenting time")
			expect(finalView).not.toContain("Ferment V2 complete in")
			expect(finalView).not.toContain("Get Ferment V2")
			expect(finalView).not.toContain("Update Ferment V2")
			await new Promise((resolve) => setTimeout(resolve, 2_000))
			expect(chatRequests(fixture.fake.requests)).toHaveLength(6)
			trace.step("continue then met evaluation completed without duplicate Ferment V2 UI")
		},
	)
})

test("experimental Ferment V2 shows the reason when work is blocked", async ({ terminal }) => {
	const blockedReason = "Needs a user-owned API token."
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-v2-mode-blocked",
			seedHome: (homeDir) => enableFermentV2Mode(homeDir),
			responses: [
				{
					stream: ["I cannot continue without user input."],
					toolCalls: [
						{
							id: "block-ferment-v2",
							function: {
								name: "update_ferment_v2",
								arguments: JSON.stringify({ status: "blocked", reason: blockedReason }),
							},
						},
					],
				},
			],
		},
		async (fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })

			terminal.submit("/ferment-v2 finish the authenticated setup")
			await waitForText(terminal, "Ferment V2 blocked.", { timeoutMs: 5_000 })
			terminal.submit("/ferment-v2")
			await waitForText(terminal, "Status: blocked", { timeoutMs: 5_000 })
			await waitForText(terminal, `Blocked reason: ${blockedReason}`, { timeoutMs: 5_000 })
			await new Promise((resolve) => setTimeout(resolve, 500))
			expect(chatRequests(fixture.fake.requests)).toHaveLength(1)
			trace.step("blocked Ferment V2 reports its persisted reason without an evaluator call")
		},
	)
})

function enableFermentV2Mode(homeDir: string): void {
	const settingsPath = join(homeDir, ".config", "kimchi", "harness", "settings.json")
	const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>
	settings.resources = { "extensions.ferment-v2": true }
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

function fermentV2Snapshot(request: FakeResponseRequest): {
	objective: string
	status: string
	tokenBudget?: number
} {
	const context = collectStrings(request.body).find((value) => value.includes("<kimchi_session_ferment_v2>"))
	const match = context?.match(/<kimchi_session_ferment_v2>\s*(\{[\s\S]*?\})\s*Autonomous Ferment V2 continuation/)
	if (!match) throw new Error(`No canonical Ferment V2 context found in request: ${JSON.stringify(request.body)}`)
	return JSON.parse(match[1])
}

function collectStrings(value: unknown): string[] {
	if (typeof value === "string") return [value]
	if (Array.isArray(value)) return value.flatMap(collectStrings)
	if (value && typeof value === "object") return Object.values(value).flatMap(collectStrings)
	return []
}

function isFermentV2EvaluatorRequest(request: FakeResponseRequest): boolean {
	return collectStrings(request.body).some((value) => value.includes("<ferment_v2_evaluator>"))
}
