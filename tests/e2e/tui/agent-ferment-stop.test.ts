import { readFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText, waitForTurnToSettle } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("a worker stopped during final delivery stays stopped", async ({ terminal }) => {
	const call = (id: string, name: string, args: Record<string, unknown>) => ({
		id,
		function: { name, arguments: JSON.stringify(args) },
	})
	await runKimchiSession(
		terminal,
		{
			artifactName: "agent-ferment-stop",
			extraArgs: ["--session", "parent.jsonl"],
			responses: [
				{
					match: (request) => JSON.stringify(request.body).includes("<ferment_v2_evaluator>"),
					stream: [
						JSON.stringify({
							verdict: "met",
							checks: [
								{
									requirement: "Report the checked marker",
									met: true,
									failureMode: "The marker could be wrong; l1 records its verification.",
									evidence: ["l1"],
									todoIds: [1],
								},
								{
									kind: "final_answer",
									requirement: "State that the checked marker is ready",
									met: true,
									failureMode: "The answer could omit the marker; its exact text includes it.",
									candidateRef: "last_assistant",
									observedAnswer: "The checked marker is ready.",
									expectedAnswer: "The checked marker is ready.",
								},
							],
							reason: "The marker is verified.",
						}),
					],
				},
				{
					toolCalls: [
						call("spawn", "Agent", {
							prompt: "Report the checked marker.",
							description: "Check marker",
							subagent_type: "General-Purpose",
							ferment_v2: true,
							token_budget: 1024,
						}),
					],
				},
				{
					forSubagent: true,
					toolCalls: [
						call("todo", "create_todos", {
							todos: [{ content: "Check the marker", status: "in_progress" }],
						}),
					],
				},
				{
					forSubagent: true,
					toolCalls: [
						call("checked", "mark_todo", {
							id: 1,
							status: "completed",
							note: "Evidence: scripted marker verification passed.",
						}),
					],
				},
				{ forSubagent: true, stream: ["The checked marker is ready."] },
				{
					forSubagent: true,
					stream: ["The checked marker is ready."],
					usage: { prompt_tokens: 100, completion_tokens: 1200 },
				},
				{
					match: (request) => JSON.stringify(request.body).includes('"tool_call_id":"spawn"'),
					stream: ["WORKER_STOP_RECORDED"],
				},
			],
		},
		async (fixture, trace) => {
			terminal.submit("Run the marker worker and report its status.")
			await waitForText(terminal, "WORKER_STOP_RECORDED", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForTurnToSettle(fixture.fake.requests)
			const entries = readFileSync(join(fixture.workDir, "parent.jsonl"), "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
			const record = entries.findLast((entry) => entry.customType === "subagents:record")?.data
			expect(record).toMatchObject({ status: "aborted", abortReason: "token_budget" })
			const child = readFileSync(record.sessionFile, "utf8")
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line))
			expect(child.some((entry) => entry.data?.fermentV2?.lastEvaluation?.verdict === "met")).toBe(true)
			expect(child.filter((entry) => entry.message?.role === "assistant")).toHaveLength(4)
			expect(child.findLast((entry) => entry.customType === "kimchi_ferment_v2_state")?.data.fermentV2.status).toBe(
				"paused",
			)
			trace.step("the budget-stopped worker stayed paused after its parent reported the result")
		},
	)
})
