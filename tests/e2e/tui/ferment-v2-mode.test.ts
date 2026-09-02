import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { STARTUP_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import type { FakeResponseRequest, FakeResponseScript } from "./support/fake-openai-server.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const COMPACTION_SUMMARY_MARKER = "FERMENT_V2_COMPACTION_SUMMARY"

test("experimental Ferment V2 continues after automatic compaction and then completes", async ({ terminal }) => {
	const planningResponse: FakeResponseScript = {
		stream: ["Creating a tactical plan."],
		textDelayMs: 500,
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
		usage: { prompt_tokens: 7_500, completion_tokens: 0 },
	}
	const compactionResponse: FakeResponseScript = {
		stream: [`${COMPACTION_SUMMARY_MARKER}: the Ferment V2 plan is ready and implementation remains.`],
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
			seedHome: (homeDir) => enableFermentV2Mode(homeDir, { reserveTokens: 1_000, keepRecentTokens: 1 }),
			responses: [
				continueEvaluationResponse,
				metEvaluationResponse,
				planningResponse,
				planningStopResponse,
				compactionResponse,
				finishTodosResponse,
				completionResponse,
			],
		},
		async (fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			expect(viewText(terminal)).not.toContain("Ferment V2")
			trace.step("no Ferment V2 segment before a run exists, with the experimental resource enabled")

			terminal.submit("/ferment-v2 --tokens 20k implement feature A")
			await waitForText(terminal, "Ferment V2 created.", { timeoutMs: 5_000 })

			const fermentV2 = fermentV2Snapshot(await waitForChatRequest(fixture.fake.requests, 1))
			expect(fermentV2).toMatchObject({
				objective: "implement feature A",
				status: "active",
				tokenBudget: 20_000,
			})
			trace.step("model received canonical Ferment V2 context")
			await waitForText(terminal, "Implement feature A", { timeoutMs: 5_000 })
			await waitForText(terminal, "The plan is ready; implementation still remains.", { timeoutMs: 5_000 })
			await waitForText(terminal, "Compacted from", { timeoutMs: 5_000 })
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
			const requests = chatRequests(fixture.fake.requests)
			expect(requests).toHaveLength(7)
			expect(JSON.stringify(requests[2]?.body)).toContain("You are a context summarization assistant")
			expect(JSON.stringify(requests[4]?.body)).toContain(COMPACTION_SUMMARY_MARKER)
			trace.step("Ferment V2 compacted, continued from the summary, then completed")
		},
	)
})

test("experimental Ferment V2 continues after manual compaction interrupts a turn", async ({ terminal }) => {
	const manualCompactionSummaryMarker = "FERMENT_V2_MANUAL_COMPACTION_SUMMARY"
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-v2-mode-manual-compaction",
			seedHome: (homeDir) => enableFermentV2Mode(homeDir, { reserveTokens: 1_000, keepRecentTokens: 1 }),
			responses: [
				{
					match: isFermentV2EvaluatorRequest,
					stream: [
						'{"verdict":"met","checks":[{"requirement":"Finish after manual compaction","met":true,"failureMode":"the resumed work could be incomplete; l1 records verification","evidence":["l1"],"todoIds":[1]}],"reason":"The resumed turn completed the Todo with retained evidence."}',
					],
				},
				{
					stream: ["Creating the manual-compaction Todo."],
					toolCalls: [
						{
							id: "create-manual-compaction-todo",
							function: {
								name: "create_todos",
								arguments: JSON.stringify({
									todos: [{ content: "Finish after manual compaction", status: "in_progress" }],
								}),
							},
						},
					],
				},
				{
					stream: ["Work is underway before manual compaction.", " This interrupted response must not finish."],
					textDelayMs: 1_500,
				},
				{ stream: [`${manualCompactionSummaryMarker}: resume the active Ferment V2.`] },
				{
					stream: ["Resumed after manual compaction."],
					toolCalls: [
						{
							id: "finish-manual-compaction-todo",
							function: {
								name: "mark_todo",
								arguments: JSON.stringify({
									id: 1,
									status: "completed",
									note: "Evidence: resumed work completed after manual compaction",
								}),
							},
						},
					],
				},
				{
					stream: ["Claiming completion after the resumed turn."],
					toolCalls: [
						{
							id: "complete-after-manual-compaction",
							function: {
								name: "update_ferment_v2",
								arguments: JSON.stringify({ status: "complete", completion_confidence: "proven" }),
							},
						},
					],
				},
			],
		},
		async (fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })

			terminal.submit("/ferment-v2 --tokens 20k finish after manual compaction")
			await waitForText(terminal, "Work is underway before manual compaction.", { timeoutMs: 5_000 })
			terminal.submit("/compact")
			await waitForText(terminal, "Compacted from", { timeoutMs: 5_000 })
			await waitForText(terminal, "Resumed after manual compaction.", { timeoutMs: 5_000 })
			await waitForText(terminal, "Ferment V2 complete.", { timeoutMs: 5_000 })

			terminal.submit("/ferment-v2")
			await waitForText(terminal, "Status: complete", { timeoutMs: 5_000 })
			await waitForText(terminal, "Last evaluation: met", { timeoutMs: 5_000 })
			const requests = chatRequests(fixture.fake.requests)
			expect(requests).toHaveLength(6)
			expect(JSON.stringify(requests[2]?.body)).toContain("You are a context summarization assistant")
			expect(JSON.stringify(requests[3]?.body)).toContain(manualCompactionSummaryMarker)
			trace.step("manual compaction interrupted a turn, retained context, and Ferment V2 resumed to completion")
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

function enableFermentV2Mode(homeDir: string, compaction?: { reserveTokens: number; keepRecentTokens: number }): void {
	const settingsPath = join(homeDir, ".config", "kimchi", "harness", "settings.json")
	const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>
	settings.resources = { "extensions.ferment-v2": true }
	if (compaction) settings.compaction = { enabled: true, ...compaction }
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
