import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { fullText, STARTUP_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
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
	const finalAnswerResponse: FakeResponseScript = { stream: ["Feature A is complete."] }

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
				finalAnswerResponse,
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
			expect(requests).toHaveLength(8)
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
					rawDeltas: [
						{ delta: { content: "Work is underway before manual compaction." }, delayMs: 250 },
						{ delta: { content: " This interrupted response must not finish." }, delayMs: 5_000 },
					],
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
				{ stream: ["Manual-compaction work is complete."] },
			],
		},
		async (fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })

			terminal.submit("/ferment-v2 --tokens 20k finish after manual compaction")
			await waitForChatRequest(fixture.fake.requests, 2)
			await waitForCookingAnimation(terminal)
			await new Promise((resolve) => setTimeout(resolve, 750))
			terminal.submit("/compact")
			await waitForText(terminal, "Work is underway before manual compaction.", { timeoutMs: 5_000 })
			await waitForText(terminal, "Compacted from", { timeoutMs: 5_000 })
			await waitForText(terminal, "Ferment V2 complete.", { timeoutMs: 5_000 })

			terminal.submit("/ferment-v2")
			await waitForText(terminal, "Status: complete", { timeoutMs: 5_000 })
			await waitForText(terminal, "Last evaluation: met", { timeoutMs: 5_000 })
			const requests = chatRequests(fixture.fake.requests)
			expect(requests).toHaveLength(7)
			expect(
				fixture.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))[1]?.aborted,
			).toBe(true)
			expect(JSON.stringify(requests[2]?.body)).toContain("You are a context summarization assistant")
			expect(JSON.stringify(requests[3]?.body)).toContain(manualCompactionSummaryMarker)
			trace.step("manual compaction interrupted a turn, retained context, and Ferment V2 resumed to completion")
		},
	)
})

test("experimental Ferment V2 edit fences stale output and Todos without cancelling the active response", async ({
	terminal,
}) => {
	const finishedRevisionOne = "REVISION_ONE_RESPONSE_FINISHED"
	const retainedTodo = "Keep current plan"
	const staleTodo = "STALE_REVISION_ONE_PLAN"
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-v2-mode-edit-keeps-active-turn",
			seedHome: enableFermentV2Mode,
			models: [{ slug: "thinking-model", displayName: "Fake Thinking", reasoning: true }],
			extraArgs: ["--model", "thinking-model"],
			responses: [
				{
					rawDeltas: [
						{ delta: { reasoning_content: "revision one starts" } },
						{ delta: { reasoning_content: " and finishes" }, delayMs: 5_000 },
						{ delta: { content: finishedRevisionOne }, delayMs: 250 },
					],
					toolCalls: [
						{
							id: "stale-revision-one-todos",
							function: {
								name: "update_todos",
								arguments: JSON.stringify({ todos: [{ content: staleTodo, status: "in_progress" }] }),
							},
						},
					],
				},
				{
					stream: ["Working on revised objective."],
				},
			],
		},
		async (fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			terminal.write(`/todos add ${retainedTodo}`)
			await waitForText(terminal, `/todos add ${retainedTodo}`, { timeoutMs: 5_000 })
			terminal.submit("")
			await waitForText(terminal, `Added todo: ${retainedTodo}`, { timeoutMs: 5_000 })

			terminal.submit("/ferment-v2 original objective")
			await waitForText(terminal, "Ferment V2 created.", { timeoutMs: 5_000 })
			await waitForChatRequest(fixture.fake.requests, 1)
			await waitForText(terminal, "Thinking", { timeoutMs: 5_000, full: false })

			terminal.submit("/ferment-v2 edit")
			await waitForText(terminal, "Edit Ferment V2", { timeoutMs: 3_000 })
			terminal.keyPress("u", { ctrl: true })
			terminal.submit("revised objective")
			await waitForText(terminal, "Ferment V2 updated to revision 2.", { timeoutMs: 3_000 })
			expect(fullText(terminal)).not.toContain(finishedRevisionOne)
			await waitForText(terminal, "Thought for", { timeoutMs: 10_000 })
			const revisedRequest = await waitForChatRequest(fixture.fake.requests, 2)
			expect(fermentV2Snapshot(revisedRequest)).toMatchObject({
				objective: "revised objective",
				status: "active",
			})
			expect(JSON.stringify(revisedRequest.body)).toContain("The new objective supersedes the previous objective")
			const currentTodos = collectStrings(revisedRequest.body).find((value) => value.includes("## Current Todos"))
			expect(currentTodos).toContain(retainedTodo)
			expect(currentTodos).not.toContain(staleTodo)
			await waitForText(terminal, "Working on revised objective.", { timeoutMs: 5_000 })
			expect(fullText(terminal)).not.toContain(finishedRevisionOne)
			expect(
				fixture.fake.requests.find((request) => request.url.startsWith("/openai/v1/chat/completions"))?.aborted,
			).toBe(false)
			expect(fullText(terminal)).not.toContain("Operation aborted")
			expect(fullText(terminal)).not.toContain("Ferment V2 paused because the agent turn was cancelled.")
			trace.step("edit kept revision 1 running but fenced its stale output and Todo mutation from revision 2")
		},
	)
})

test("experimental Ferment V2 edit updates the revision while a tool is still running", async ({ terminal }) => {
	const toolMarker = "REVISION_ONE_TOOL_FINISHED"
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-v2-mode-edit-during-tool",
			seedHome: enableFermentV2Mode,
			responses: [
				{
					stream: ["Starting revision one command."],
					toolCalls: [
						{
							id: "call_revision_one_tool",
							function: {
								name: "bash",
								arguments: JSON.stringify({
									command:
										"sleep 2; printf '\\122\\105\\126\\111\\123\\111\\117\\116\\137\\117\\116\\105\\137\\124\\117\\117\\114\\137\\106\\111\\116\\111\\123\\110\\105\\104\\n'",
								}),
							},
						},
					],
				},
				{ stream: ["Working from revision two."] },
			],
		},
		async (fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })

			terminal.submit("/ferment-v2 original objective")
			await waitForText(terminal, "Starting revision one command.", { timeoutMs: 5_000 })
			await waitForText(terminal, "sleep 2", { timeoutMs: 5_000 })

			terminal.submit("/ferment-v2 edit revised objective")
			await waitForText(terminal, "Ferment V2 updated to revision 2.", { timeoutMs: 1_500 })
			expect(fullText(terminal)).not.toContain(toolMarker)
			await waitForText(terminal, toolMarker, { timeoutMs: 10_000 })

			const revisedRequest = await waitForChatRequest(fixture.fake.requests, 2)
			expect(fermentV2Snapshot(revisedRequest)).toMatchObject({
				objective: "revised objective",
				status: "active",
			})
			expect(JSON.stringify(revisedRequest.body)).toContain("The new objective supersedes the previous objective")
			expect(chatRequests(fixture.fake.requests).slice(0, 2).some(isFermentV2EvaluatorRequest)).toBe(false)
			await waitForText(terminal, "Working from revision two.", { timeoutMs: 5_000 })
			expect(fullText(terminal)).not.toContain("Operation aborted")
			expect(fullText(terminal)).not.toContain("Ferment V2 paused because the agent turn was cancelled.")
			trace.step(
				"revision edit landed during a running tool; the tool finished and the next model turn used revision 2",
			)
		},
	)
})

test("experimental Ferment V2 evaluates settled work without a completion-tool loop or extra nudge", async ({
	terminal,
}) => {
	const firstHiddenCandidate = "TEXT_ONLY_CANDIDATE_MUST_NOT_TRIGGER_NUDGE"
	const secondHiddenCandidate = "REVISED_TEXT_ONLY_CANDIDATE"
	const acceptedFinal = "TEXT_ONLY_CANDIDATE_ACCEPTED"
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-v2-mode-gated-text-only-completion",
			seedHome: enableFermentV2Mode,
			models: [{ slug: "thinking-model", displayName: "Fake Thinking", reasoning: true }],
			extraArgs: ["--model", "thinking-model"],
			responses: [
				{
					match: isFermentV2EvaluatorRequest,
					stream: [
						'{"verdict":"continue","checks":[{"requirement":"Write a concise final synthesis","met":false,"evidence":["l1"],"todoIds":[1]}],"reason":"The evaluator wants a concise final synthesis before returning a continue verdict."}',
					],
					textDelayMs: 5_500,
				},
				{
					match: isFermentV2EvaluatorRequest,
					stream: [
						'{"verdict":"met","checks":[{"requirement":"Finish the task","met":true,"failureMode":"the result could omit the synthesis; l1 records the verified work","evidence":["l1"],"todoIds":[1]}],"reason":"The verified work and concise synthesis satisfy the objective."}',
					],
				},
				{
					stream: ["Creating the task Todo."],
					toolCalls: [
						{
							id: "create-text-only-todo",
							function: {
								name: "create_todos",
								arguments: JSON.stringify({ todos: [{ content: "Finish the task", status: "in_progress" }] }),
							},
						},
					],
				},
				{
					stream: ["Verified the task."],
					toolCalls: [
						{
							id: "finish-text-only-todo",
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
				},
				{
					thinking: ["Reviewing the first completion candidate."],
					stream: [firstHiddenCandidate],
					usage: { prompt_tokens: 100, completion_tokens: 10 },
				},
				{
					thinking: ["Reviewing the revised completion candidate."],
					stream: [secondHiddenCandidate],
					usage: { prompt_tokens: 20, completion_tokens: 5 },
				},
				{
					thinking: ["Returning the accepted final answer."],
					stream: [acceptedFinal],
					usage: { prompt_tokens: 30, completion_tokens: 8 },
				},
			],
		},
		async (fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })

			terminal.submit("/ferment-v2 finish the task")
			await waitForText(terminal, acceptedFinal, { timeoutMs: 20_000 })
			await waitForText(terminal, "Ferment V2 complete.", { timeoutMs: 5_000 })
			await waitForText(terminal, "Prompt summary", { timeoutMs: 5_000 })
			const requests = chatRequests(fixture.fake.requests)
			expect(requests).toHaveLength(7)
			const continuation = JSON.stringify(requests[4]?.body)
			expect(continuation).toContain("Remaining task gap: Remaining requirement: Write a concise final synthesis.")
			expect(continuation).not.toMatch(/independent evaluation|completion policy|the evaluator/i)
			expect(JSON.stringify(requests)).not.toContain("If you have finished, please summarize the result")
			expect(fullText(terminal)).not.toContain(firstHiddenCandidate)
			expect(fullText(terminal)).not.toContain(secondHiddenCandidate)
			expect(fullText(terminal).match(/Prompt summary/g)).toHaveLength(1)
			expect(fullText(terminal).match(/Worked for/g)).toHaveLength(1)
			trace.step("settled Todos reached evaluation without a completion-tool turn or empty-turn nudge")
		},
	)
})

test("experimental Ferment V2 reveals the final answer only after evaluation accepts it", async ({ terminal }) => {
	const earlyHiddenCandidate = "EARLY_CANDIDATE_BEFORE_TODOS_MUST_STAY_HIDDEN"
	const privateEmail = "candidate-owner@example.com"
	const firstHiddenCandidate = `UNVERIFIED_CANDIDATE_MUST_STAY_HIDDEN ${privateEmail}`
	const secondHiddenCandidate = "REVISED_CANDIDATE_MUST_STAY_HIDDEN"
	const acceptedFinal = "VERIFIED_FINAL_AFTER_EVALUATION"
	const visibleThinking = "VISIBLE_THINKING_DURING_ACTIVE_FERMENT"
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-v2-mode-evaluation-gate",
			seedHome: enableFermentV2Mode,
			env: { KIMCHI_REDACTION_ENABLED: "1" },
			models: [{ slug: "thinking-model", displayName: "Fake Thinking", reasoning: true }],
			extraArgs: ["--model", "thinking-model"],
			responses: [
				{
					match: isFermentV2EvaluatorRequest,
					stream: [
						'{"verdict":"continue","checks":[{"requirement":"Finish behind the evaluator gate","met":false,"evidence":["l1"],"todoIds":[1]}],"reason":"Verify the remaining evaluator concern."}',
					],
					textDelayMs: 1_500,
				},
				{
					match: isFermentV2EvaluatorRequest,
					stream: [
						'{"verdict":"met","checks":[{"requirement":"Finish behind the evaluator gate","met":true,"failureMode":"the result could be unverified; l1 and l2 record both verification passes","evidence":["l1","l2"],"todoIds":[1,2]}],"reason":"Both completed Todos have retained verification evidence."}',
					],
				},
				{
					thinking: [visibleThinking],
					thinkingDelayMs: 500,
					stream: [earlyHiddenCandidate],
					toolCalls: [
						{
							id: "claim-before-todos",
							function: {
								name: "update_ferment_v2",
								arguments: JSON.stringify({ status: "complete", completion_confidence: "proven" }),
							},
						},
					],
				},
				{
					stream: ["Creating the gated completion Todo."],
					toolCalls: [
						{
							id: "create-gated-completion-todo",
							function: {
								name: "create_todos",
								arguments: JSON.stringify({
									todos: [{ content: "Finish behind the evaluator gate", status: "in_progress" }],
								}),
							},
						},
					],
				},
				{
					stream: [firstHiddenCandidate],
					toolCalls: [
						{
							id: "finish-gated-completion-todo",
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
				},
				{
					toolCalls: [
						{
							id: "claim-gated-completion",
							function: {
								name: "update_ferment_v2",
								arguments: JSON.stringify({ status: "complete", completion_confidence: "proven" }),
							},
						},
					],
				},
				{
					stream: ["Reopening tactical work after the rejected completion."],
					toolCalls: [
						{
							id: "add-remaining-gated-todo",
							function: {
								name: "add_todo",
								arguments: JSON.stringify({
									content: "Verify the remaining evaluator concern",
									status: "in_progress",
								}),
							},
						},
					],
				},
				{
					stream: [secondHiddenCandidate],
					toolCalls: [
						{
							id: "finish-remaining-gated-todo",
							function: {
								name: "mark_todo",
								arguments: JSON.stringify({
									id: 2,
									status: "completed",
									note: "Evidence: remaining evaluator concern verified",
								}),
							},
						},
					],
				},
				{
					toolCalls: [
						{
							id: "reclaim-gated-completion",
							function: {
								name: "update_ferment_v2",
								arguments: JSON.stringify({ status: "complete", completion_confidence: "proven" }),
							},
						},
					],
				},
				{ stream: [acceptedFinal] },
			],
		},
		async (fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })

			terminal.submit("/ferment-v2 finish behind the evaluator gate")
			await waitForText(terminal, "Thought for", { timeoutMs: 5_000 })
			expect(fullText(terminal)).not.toContain(visibleThinking)
			trace.step("active Ferment V2 preserves the normal thinking block")
			await waitForChatRequest(fixture.fake.requests, 2)
			expect(fullText(terminal)).not.toContain(earlyHiddenCandidate)
			const firstEvaluatorRequest = await waitForChatRequest(fixture.fake.requests, 5)
			expect(isFermentV2EvaluatorRequest(firstEvaluatorRequest)).toBe(true)
			expect(JSON.stringify(firstEvaluatorRequest.body)).toContain("UNVERIFIED_CANDIDATE_MUST_STAY_HIDDEN")
			expect(JSON.stringify(firstEvaluatorRequest.body)).not.toContain(privateEmail)
			expect(JSON.stringify(firstEvaluatorRequest.body)).toContain("[REDACTED-EMAIL_ADDRESS]")
			const cookingMessage = await waitForCookingAnimation(terminal)
			expect(fullText(terminal)).not.toContain(firstHiddenCandidate)
			trace.step("completion candidate stayed hidden while evaluation was pending")

			const continuationRequest = await waitForChatRequest(fixture.fake.requests, 6)
			expect(JSON.stringify(continuationRequest.body)).toContain(
				"If more work remains after Todos were settled, preserve those Todos and their evidence; extend the list with a concrete missing action or reopen the matching Todo instead of clearing or replacing the list.",
			)
			const resumedWorkRequest = await waitForChatRequest(fixture.fake.requests, 7)
			expect(JSON.stringify(resumedWorkRequest.body)).toContain("Finish behind the evaluator gate")
			expect(JSON.stringify(resumedWorkRequest.body)).toContain("Verify the remaining evaluator concern")
			await waitForText(terminal, "Reopening tactical work after the rejected completion.", { timeoutMs: 5_000 })
			trace.step("rejected completion rebuilt the settled Todo list before further work")

			await waitForText(terminal, acceptedFinal, { timeoutMs: 5_000 })
			await waitForText(terminal, "Ferment V2 complete.", { timeoutMs: 5_000 })
			expect(fullText(terminal)).toContain("Thought for")
			expect(fullText(terminal)).not.toContain(earlyHiddenCandidate)
			expect(fullText(terminal)).not.toContain(firstHiddenCandidate)
			expect(fullText(terminal)).not.toContain(secondHiddenCandidate)
			expect(JSON.stringify(chatRequests(fixture.fake.requests))).not.toContain(privateEmail)
			expect(JSON.stringify(chatRequests(fixture.fake.requests))).not.toContain(
				"If you have finished, please summarize the result",
			)
			expect(fullText(terminal)).not.toContain(visibleThinking)
			expect(fullText(terminal)).not.toContain("Checking completion")
			expect(fullText(terminal)).not.toContain(cookingMessage)
			expect(JSON.stringify(chatRequests(fixture.fake.requests).at(-1)?.body)).toContain(
				"Do not narrate the completion check, control messages, evidence gathering, or your internal process unless directly required by the original objective.",
			)
			expect(JSON.stringify(chatRequests(fixture.fake.requests).at(-1)?.body)).toContain(
				"If the original objective requires exact output, return exactly that output with no preface or summary.",
			)
			expect(fullText(terminal).match(/Worked for/g)).toHaveLength(1)
			trace.step("accepted final answer appeared only after the evaluator returned met")
		},
	)
})

test("experimental Ferment V2 preserves exact output when accepted final delivery resumes", async ({ terminal }) => {
	const sessionFile = "accepted-final-restart.jsonl"
	const exactOutput = "EXACT-FINAL-RESTART-PAYLOAD"
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-v2-mode-accepted-final-restart",
			extraArgs: ["--session", sessionFile],
			responses: [
				{
					match: (request) =>
						JSON.stringify(request.body).includes(
							"If the original objective requires exact output, return exactly that output with no preface or summary.",
						),
					stream: [exactOutput],
				},
			],
			seedHome(homeDir, workDir) {
				enableFermentV2Mode(homeDir)
				writeAcceptedFermentV2Session(join(workDir, sessionFile), workDir, exactOutput)
			},
		},
		async (fixture, trace) => {
			await waitForText(terminal, exactOutput, { timeoutMs: 5_000 })
			await waitForText(terminal, "Ferment V2 complete.", { timeoutMs: 5_000 })
			const requests = chatRequests(fixture.fake.requests)
			expect(requests).toHaveLength(1)
			expect(requests.filter(isFermentV2EvaluatorRequest)).toHaveLength(0)
			expect(JSON.stringify(requests[0]?.body)).toContain(
				"If the original objective requires exact output, return exactly that output with no preface or summary.",
			)
			expect(readFileSync(join(fixture.workDir, sessionFile), "utf-8")).toContain('"status":"complete"')
			trace.step("accepted replay delivered the exact payload without reevaluation")
		},
	)
})

test("experimental Ferment V2 pauses when an accepted final answer cannot be delivered", async ({ terminal }) => {
	const hiddenCandidate = "UNDELIVERED_CANDIDATE_MUST_STAY_HIDDEN"
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-v2-mode-final-delivery-error",
			seedHome: enableFermentV2Mode,
			responses: [
				{
					match: isFermentV2EvaluatorRequest,
					stream: [
						'{"verdict":"met","checks":[{"requirement":"Finish before delivery","met":true,"failureMode":"the work could be unverified; l1 records verification","evidence":["l1"],"todoIds":[1]}],"reason":"The completed Todo retains verification evidence."}',
					],
				},
				{
					stream: ["Creating the delivery Todo."],
					toolCalls: [
						{
							id: "create-delivery-todo",
							function: {
								name: "create_todos",
								arguments: JSON.stringify({
									todos: [{ content: "Finish before delivery", status: "in_progress" }],
								}),
							},
						},
					],
				},
				{
					stream: ["Verified the delivery work."],
					toolCalls: [
						{
							id: "finish-delivery-todo",
							function: {
								name: "mark_todo",
								arguments: JSON.stringify({
									id: 1,
									status: "completed",
									note: "Evidence: scripted delivery verification completed",
								}),
							},
						},
					],
				},
				{
					stream: [hiddenCandidate],
					toolCalls: [
						{
							id: "claim-before-delivery-error",
							function: {
								name: "update_ferment_v2",
								arguments: JSON.stringify({ status: "complete", completion_confidence: "proven" }),
							},
						},
					],
				},
				{ streamError: "scripted final delivery failure" },
			],
		},
		async (_fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })

			terminal.submit("/ferment-v2 finish before delivery")
			await waitForText(terminal, "Ferment V2 paused because its final answer could not be delivered.", {
				timeoutMs: 10_000,
			})
			expect(fullText(terminal)).not.toContain(hiddenCandidate)
			expect(fullText(terminal)).not.toContain("Ferment V2 complete.")

			terminal.submit("/ferment-v2")
			await waitForText(terminal, "Status: paused", { timeoutMs: 5_000 })
			await waitForText(terminal, "Last evaluation: met", { timeoutMs: 5_000 })
			trace.step("accepted work stayed non-complete when the final answer stream failed")
		},
	)
})

test("experimental Ferment V2 pauses after the same unresolved gap repeats three times", async ({ terminal }) => {
	const repeatedGap = "The same objective requirement remains unverified."
	const responses = Array.from(
		{ length: 4 },
		(_, index) =>
			[
				{
					stream: [`Checking source ${index + 1}.`],
					toolCalls: [
						{
							id: `repeated-gap-check-${index + 1}`,
							function: { name: "bash", arguments: JSON.stringify({ command: "pwd" }) },
						},
					],
				},
				{ stream: [`Checked source ${index + 1}.`] },
				{
					match: isFermentV2EvaluatorRequest,
					stream: [JSON.stringify({ verdict: "continue", reason: repeatedGap })],
				},
			] satisfies FakeResponseScript[],
	).flat()

	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-v2-mode-repeated-gap",
			seedHome: enableFermentV2Mode,
			responses,
		},
		async (fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })

			terminal.submit("/ferment-v2 verify the same requirement")
			await waitForText(terminal, "Ferment V2 paused after 3 stalled continuation turns.", {
				timeoutMs: 15_000,
			})
			terminal.submit("/ferment-v2")
			await waitForText(terminal, "Status: paused", { timeoutMs: 5_000 })
			await waitForText(terminal, "Evaluations: 4", { timeoutMs: 5_000 })
			expect(chatRequests(fixture.fake.requests).filter(isFermentV2EvaluatorRequest)).toHaveLength(4)
			trace.step("three repeated evaluator gaps paused substantive but ineffective retry work")
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

function writeAcceptedFermentV2Session(sessionPath: string, workDir: string, acceptedDraft: string): void {
	const now = new Date().toISOString()
	const header = { type: "session", version: 3, id: "accepted-final-restart", timestamp: now, cwd: workDir }
	const fermentV2Id = "accepted-final-restart-ferment-v2"
	const revision = 1
	const fermentV2Entry = {
		type: "custom",
		customType: "kimchi_ferment_v2_state",
		data: {
			schemaVersion: 1,
			op: "put",
			fermentV2: {
				schemaVersion: 1,
				id: fermentV2Id,
				revision,
				objective: "Return only the uppercase form of exact-final-restart-payload, with no other text.",
				status: "active",
				evaluationCount: 1,
				lastEvaluation: {
					verdict: "met",
					reason: "The completed Todo retains verification evidence.",
					evaluatedAt: now,
				},
				tokensUsed: 0,
				timeUsedMs: 0,
				createdAt: now,
				updatedAt: now,
			},
		},
		id: "accepted-final-restart-state",
		parentId: null,
		timestamp: now,
	}
	const todoEntry = {
		type: "custom",
		customType: "kimchi.todos",
		data: {
			schemaVersion: 1,
			scope: { kind: "global" },
			todos: [{ id: 1, content: "Prepare the exact response", status: "completed" }],
			updatedAt: now,
		},
		id: "accepted-final-restart-todo",
		parentId: "accepted-final-restart-state",
		timestamp: now,
	}
	const acceptedFinalControlEntry = {
		type: "custom_message",
		customType: "kimchi_ferment_v2_control",
		content: acceptedFinalControlContent(acceptedDraft),
		display: false,
		details: {
			source: "evaluation_accepted",
			fermentV2Id,
			revision,
		},
		id: "accepted-final-restart-control",
		parentId: "accepted-final-restart-todo",
		timestamp: now,
	}
	writeFileSync(
		sessionPath,
		`${[header, fermentV2Entry, todoEntry, acceptedFinalControlEntry].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
		"utf-8",
	)
}

function acceptedFinalControlContent(acceptedDraft: string): string {
	return `The objective is complete and ready for user delivery.

Give the user only the final answer to the original objective. If the original objective requires exact output, return exactly that output with no preface or summary. Otherwise, start with the outcome. Do not narrate the completion check, control messages, evidence gathering, or your internal process unless directly required by the original objective. Do not call tools.

Return this evaluated draft verbatim: ${JSON.stringify(acceptedDraft)}`
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
	const match = context?.match(/<kimchi_session_ferment_v2>\s*(\{[\s\S]*?\})\s*Persistent objective continuation/)
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

async function waitForCookingAnimation(terminal: Parameters<typeof fullText>[0]): Promise<string> {
	const messages = [
		"Stirring",
		"Marinating",
		"Chopping",
		"Mixing the gochugaru",
		"Salting the cabbage",
		"Grinding spices",
		"Packing the jar",
		"Massaging the leaves",
		"Reducing",
		"Prepping aromatics",
		"Simmering",
		"Chilling",
		"Seasoning",
		"Tasting",
		"Letting it rest",
		"Rinsing",
		"Building the brine",
		"Cooking",
		"Braising",
		"Tossing everything together",
	]
	const deadline = Date.now() + 1_000
	let previousFrame: string | undefined
	while (Date.now() < deadline) {
		const text = fullText(terminal)
		const message = messages.find((candidate) => text.includes(candidate))
		if (message) {
			const frame = text.split("\n").find((line) => line.includes(message))
			if (frame && previousFrame && frame !== previousFrame) return message
			previousFrame = frame
		}
		await new Promise((resolve) => setTimeout(resolve, 25))
	}
	throw new Error("Timed out waiting for the standard cooking animation to advance.")
}
