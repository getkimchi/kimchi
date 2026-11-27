import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { fullText, STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import type { FakeResponseRequest, FakeResponseScript } from "./support/fake-openai-server.js"
import { isVerifierRequest, verifierCheck, verifierSubmit } from "./support/ferment-v2-verifier.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const COMPACTION_SUMMARY_MARKER = "FERMENT_V2_COMPACTION_SUMMARY"

test("stopping a run preserves a paused goal that can be edited, resumed and cleared", async ({ terminal }) => {
	const objective = "Build a complete OAuth login and account linking migration with rollout safeguards"
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-v2-stop-edit-resume",
			responses: [
				{ stream: Array.from({ length: 40 }, () => "Still working. "), textDelayMs: 500 },
				{
					stream: ["The new setup requires a credential."],
					toolCalls: [
						{
							id: "new-goal-blocked",
							function: {
								name: "update_ferment_v2",
								arguments: JSON.stringify({ status: "blocked", reason: "Missing setup credential." }),
							},
						},
					],
				},
			],
		},
		async (fixture, trace) => {
			terminal.submit(`/ferment ${objective}`)
			expect(fermentV2Snapshot(await waitForChatRequest(fixture.fake.requests, 1))).toMatchObject({ objective })
			await waitForText(terminal, "◈ Ferment: running · Build a complete OAuth login and", { timeoutMs: 5_000 })
			terminal.keyCtrlC()
			await waitForText(terminal, "◈ Ferment: paused · Build a complete OAuth login and", { timeoutMs: 5_000 })
			trace.step("the short name survives pausing while the model receives the complete objective")
			terminal.submit("/ferment edit finish authenticated setup")
			await waitForText(terminal, "◈ Ferment: paused · finish authenticated setup", { timeoutMs: 5_000 })
			expect(chatRequests(fixture.fake.requests)).toHaveLength(1)
			trace.step("editing while paused did not start work")
			terminal.submit("/ferment resume")
			const request = await waitForChatRequest(fixture.fake.requests, 2)
			expect(fermentV2Snapshot(request)).toMatchObject({
				objective: "finish authenticated setup",
				status: "active",
			})
			await waitForText(terminal, "◈ Ferment: blocked · finish authenticated setup", { timeoutMs: 5_000 })
			trace.step("resume used the new objective and surfaced its blockage")
			terminal.submit("/ferment clear")
			await waitForText(terminal, "Ferment cleared.", { timeoutMs: 5_000 })
			expect(viewText(terminal).split("\n").slice(-4).join("\n")).not.toContain("◈")
		},
	)
})

test("Ferment leaves Plan mode, writes, and completes", async ({ terminal }) => {
	const outputFile = "plan-mode-ferment.txt"
	const acceptedFinal = "PLAN_MODE_FERMENT_COMPLETE"
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-v2-from-plan-mode",
			extraArgs: ["--plan=true"],
			// The classifier resolves the kimchi-dev ladder provider-exactly, so the
			// classifier model needs the dated slug under provider kimchi-dev (with
			// ai-enabler metadata, catalog refresh preserves that provider).
			providerId: "kimchi-dev",
			models: [
				{
					slug: "basic",
					displayName: "Fake Basic",
					provider: "ai-enabler",
					contextWindow: 200_000,
					maxTokens: 8192,
				},
				{
					slug: "deepseek-v4-flash-0731",
					displayName: "DeepSeek V4 Flash",
					provider: "ai-enabler",
					contextWindow: 200_000,
					maxTokens: 8192,
				},
			],
			responses: [
				// The verifier session: one executing bash check (stamped [e1]), then a met verdict citing it.
				verifierCheck("verifier-plan-mode-check", `test "$(cat ${outputFile})" = done`),
				verifierSubmit("met", "The file exists with the exact required content."),
				{
					stream: ["Creating the requested file."],
					toolCalls: [
						{
							id: "create-plan-mode-todo",
							index: 0,
							function: {
								name: "create_todos",
								arguments: JSON.stringify({
									todos: [{ content: "Create and verify plan-mode-ferment.txt", status: "in_progress" }],
								}),
							},
						},
						{
							id: "write-plan-mode-file",
							index: 1,
							function: {
								name: "write",
								arguments: JSON.stringify({ path: outputFile, content: "done" }),
							},
						},
					],
				},
				{
					stream: ['{"verdict":"safe","reason":"Writes the requested test artifact","riskScore":"low"}'],
				},
				{
					stream: ["Verifying the file."],
					toolCalls: [
						{
							id: "read-plan-mode-file",
							index: 0,
							function: { name: "read", arguments: JSON.stringify({ path: outputFile }) },
						},
						{
							id: "finish-plan-mode-todo",
							index: 1,
							function: {
								name: "mark_todo",
								arguments: JSON.stringify({
									id: 1,
									status: "completed",
									note: "Evidence: wrote and read plan-mode-ferment.txt with exact content done",
								}),
							},
						},
					],
				},
				{
					stream: ["The requested file is verified. Claiming completion."],
					toolCalls: [
						{
							id: "claim-plan-mode-ferment-complete",
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
			await waitForText(terminal, /plan(?: → shift\+tab)? · basic\b/, { timeoutMs: STARTUP_TIMEOUT_MS })
			terminal.submit(`/ferment create ${outputFile} containing exactly done and verify it`)
			await waitForText(terminal, "Ferment created.", { timeoutMs: 5_000 })
			await waitForText(terminal, /auto(?: → shift\+tab)? · basic\b/, { timeoutMs: 5_000 })
			await waitForText(terminal, acceptedFinal, { timeoutMs: 15_000 })
			await waitForText(terminal, "Ferment complete.", { timeoutMs: 5_000 })
			expect(readFileSync(join(fixture.workDir, outputFile), "utf-8")).toBe("done")
			expect(fullText(terminal)).not.toContain(
				"Ferment requires the Ferment and Todo tools to be enabled before it can run.",
			)
			expect(fullText(terminal)).not.toContain("Plan mode: tool write is not available")
			const verifierRequests = fixture.fake.requests.filter(isVerifierRequest)
			expect(verifierRequests).toHaveLength(2)
			trace.step("completion waited for the verifier's submitted verdict")
		},
	)
})

test("Ferment continues after automatic compaction and then completes", async ({ terminal }) => {
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
		// Trigger auto-compaction exactly once at this turn boundary. In 1.3.0
		// the run-prepare check estimates the full projected context (system
		// prompt included, ~10k tokens), so the old 7,500-token trigger now sits
		// *below* the constant floor and compacts at every turn instead of once.
		// The window (20k) keeps the floor under threshold (19k); this usage
		// crosses it while staying under the ferment budget (also 20k).
		usage: { prompt_tokens: 19_500, completion_tokens: 0 },
	}
	const compactionResponse: FakeResponseScript = {
		stream: [`${COMPACTION_SUMMARY_MARKER}: the Ferment plan is ready and implementation remains.`],
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
	const metEvaluationResponse: FakeResponseScript[] = [
		verifierCheck("verifier-compaction-check", "pwd"),
		verifierSubmit("met", "The implemented feature is verified."),
	]
	const finalAnswerResponse: FakeResponseScript = { stream: ["Feature A is complete."] }

	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-v2-mode",
			seedHome: (homeDir) => enableCompaction(homeDir, { reserveTokens: 1_000, keepRecentTokens: 1 }),
			// 20k window keeps the ~10k-token projection floor below threshold
			// (19k) so only the scripted 19.5k usage crosses: one compaction.
			models: [{ slug: "basic", displayName: "Fake Basic", contextWindow: 20_000, maxTokens: 1024 }],
			responses: [
				...metEvaluationResponse,
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
			expect(viewText(terminal)).not.toContain("◈ Ferment")
			trace.step("no Ferment status segment before a run exists, with the default resource enabled")

			terminal.submit("/ferment --tokens 20k implement feature A")
			await waitForText(terminal, "Ferment created.", { timeoutMs: 5_000 })

			const fermentV2 = fermentV2Snapshot(await waitForChatRequest(fixture.fake.requests, 1))
			expect(fermentV2).toMatchObject({
				objective: "implement feature A",
				status: "active",
				tokenBudget: 20_000,
			})
			trace.step("model received canonical Ferment context")
			await waitForText(terminal, "Implement feature A", { timeoutMs: 5_000 })
			// 1.3.0_rechecks compaction at run-prepare time, interposing the
			// compaction cycle between the planning stream's chunks — these
			// boundaries need the stream budget, not a conversational one.
			await waitForText(terminal, "The plan is ready; implementation still remains.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Compacted from", { timeoutMs: STREAM_TIMEOUT_MS })

			await waitForText(terminal, "Ferment complete.", { timeoutMs: 5_000 })
			terminal.submit("/ferment")
			await waitForText(terminal, "Evaluations: 1", { timeoutMs: 5_000 })
			await waitForText(terminal, "Last evaluation: met", { timeoutMs: 5_000 })
			const finalView = viewText(terminal)
			expect(finalView).not.toContain("Ferment not met")
			expect(finalView).not.toContain("fermenting time")
			expect(finalView).not.toContain("Ferment complete in")
			expect(finalView).not.toContain("Get Ferment")
			expect(finalView).not.toContain("Update Ferment")
			await new Promise((resolve) => setTimeout(resolve, 2_000))
			const requests = chatRequests(fixture.fake.requests)
			expect(requests).toHaveLength(8)
			expect(JSON.stringify(requests[2]?.body)).toContain("You are a context summarization assistant")
			expect(JSON.stringify(requests[3]?.body)).toContain(COMPACTION_SUMMARY_MARKER)
			// The stop after compaction had no completion claim, so the continuation came
			// from the deterministic host path, not a verifier run. The claim at the end
			// ran the verifier: one executing bash check plus the verdict.
			expect(requests.filter(isVerifierRequest)).toHaveLength(2)
			trace.step("Ferment compacted, continued deterministically from the summary, then completed on its claim")
		},
	)
})

test("Ferment continues after manual compaction interrupts a turn", async ({ terminal }) => {
	const manualCompactionSummaryMarker = "FERMENT_V2_MANUAL_COMPACTION_SUMMARY"
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-v2-mode-manual-compaction",
			seedHome: (homeDir) => enableCompaction(homeDir, { reserveTokens: 1_000, keepRecentTokens: 1 }),
			// Same 20k-window guard as the auto-compaction test: the /compact
			// below must be the only summarization request in the wire.
			models: [{ slug: "basic", displayName: "Fake Basic", contextWindow: 20_000, maxTokens: 1024 }],
			responses: [
				verifierCheck("verifier-manual-compaction-check", "pwd"),
				verifierSubmit("met", "The resumed turn completed the verified work."),
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
				{ stream: [`${manualCompactionSummaryMarker}: resume the active Ferment.`] },
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

			terminal.submit("/ferment --tokens 20k finish after manual compaction")
			await waitForChatRequest(fixture.fake.requests, 2)
			await waitForCookingAnimation(terminal)
			await new Promise((resolve) => setTimeout(resolve, 750))
			terminal.submit("/compact")
			// Same upstream pi compaction-cycle budget as the auto-compaction test above.
			await waitForText(terminal, "Work is underway before manual compaction.", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Compacted from", { timeoutMs: 5_000 })
			await waitForText(terminal, "Ferment complete.", { timeoutMs: 5_000 })

			terminal.submit("/ferment")
			await waitForText(terminal, "Status: complete", { timeoutMs: 5_000 })
			await waitForText(terminal, "Last evaluation: met", { timeoutMs: 5_000 })
			const requests = chatRequests(fixture.fake.requests)
			// Two implementer turns before compaction, the summary, two resumed turns,
			// then the verifier's bash check + verdict, then the final answer.
			expect(requests).toHaveLength(8)
			expect(
				fixture.fake.requests.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))[1]?.aborted,
			).toBe(true)
			expect(JSON.stringify(requests[2]?.body)).toContain("You are a context summarization assistant")
			expect(JSON.stringify(requests[3]?.body)).toContain(manualCompactionSummaryMarker)
			trace.step("manual compaction interrupted a turn, retained context, and Ferment resumed to completion")
		},
	)
})

test("Ferment edit fences stale output and Todos without cancelling the active response", async ({ terminal }) => {
	const finishedRevisionOne = "REVISION_ONE_RESPONSE_FINISHED"
	const retainedTodo = "Keep current plan"
	const staleTodo = "STALE_REVISION_ONE_PLAN"
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-v2-mode-edit-keeps-active-turn",
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
				{ stream: ["Revised objective instructions received after settlement."] },
			],
		},
		async (fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			terminal.write(`/todos add ${retainedTodo}`)
			await waitForText(terminal, `/todos add ${retainedTodo}`, { timeoutMs: 5_000 })
			terminal.submit("")
			await waitForText(terminal, `Added todo: ${retainedTodo}`, { timeoutMs: 5_000 })

			terminal.submit("/ferment original objective")
			await waitForText(terminal, "Ferment created.", { timeoutMs: 5_000 })
			await waitForChatRequest(fixture.fake.requests, 1)
			await waitForText(terminal, "Thinking", { timeoutMs: 5_000, full: false })

			terminal.submit("/ferment edit")
			await waitForText(terminal, "Edit Ferment", { timeoutMs: 3_000 })
			terminal.keyPress("u", { ctrl: true })
			terminal.submit("revised objective")
			await waitForText(terminal, "Ferment updated to revision 2.", { timeoutMs: 3_000 })
			expect(fullText(terminal)).not.toContain(finishedRevisionOne)
			await waitForText(terminal, "Thought for", { timeoutMs: 10_000 })
			const revisedRequest = await waitForChatRequest(fixture.fake.requests, 2)
			expect(fermentV2Snapshot(revisedRequest)).toMatchObject({
				objective: "revised objective",
				status: "active",
			})
			// The native tool loop sees the new context before the retractable edit control is dispatched at settlement.
			expect(JSON.stringify(revisedRequest.body)).not.toContain("The new objective supersedes the previous objective")
			const currentTodos = collectStrings(revisedRequest.body).find((value) => value.includes("## Current Todos"))
			expect(currentTodos).toContain(retainedTodo)
			expect(currentTodos).not.toContain(staleTodo)
			await waitForText(terminal, "Working on revised objective.", { timeoutMs: 5_000 })
			const editRequest = await waitForChatRequest(fixture.fake.requests, 3)
			expect(fermentV2Snapshot(editRequest)).toMatchObject({ objective: "revised objective", status: "active" })
			expect(JSON.stringify(editRequest.body)).toContain("The new objective supersedes the previous objective")
			expect(chatRequests(fixture.fake.requests).slice(0, 3).some(isVerifierRequest)).toBe(false)
			await waitForText(terminal, "Revised objective instructions received after settlement.", { timeoutMs: 5_000 })
			expect(fullText(terminal)).not.toContain(finishedRevisionOne)
			expect(
				fixture.fake.requests.find((request) => request.url.startsWith("/openai/v1/chat/completions"))?.aborted,
			).toBe(false)
			expect(fullText(terminal)).not.toContain("Operation aborted")
			expect(fullText(terminal)).not.toContain("Ferment paused because the agent turn was cancelled.")
			trace.step(
				"edit fenced stale output and Todos, refreshed native context, then delivered its control after settlement",
			)
		},
	)
})

test("Ferment edit updates the revision while a tool is still running", async ({ terminal }) => {
	const toolMarker = "REVISION_ONE_TOOL_FINISHED"
	// Keep this command below the two-second Bash handoff: this workflow
	// exercises an edit during a synchronous tool, without cohort reminders.
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-v2-mode-edit-during-tool",
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
										"sleep 1; printf '\\122\\105\\126\\111\\123\\111\\117\\116\\137\\117\\116\\105\\137\\124\\117\\117\\114\\137\\106\\111\\116\\111\\123\\110\\105\\104\\n'",
								}),
							},
						},
					],
				},
				{ stream: ["Working from revision two."] },
				{ stream: ["Revision two instructions received after settlement."] },
			],
		},
		async (fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })

			terminal.submit("/ferment original objective")
			await waitForText(terminal, "Starting revision one command.", { timeoutMs: 5_000 })
			await waitForText(terminal, "sleep 1", { timeoutMs: 5_000 })

			terminal.submit("/ferment edit revised objective")
			await waitForText(terminal, "Ferment updated to revision 2.", { timeoutMs: 1_500 })
			expect(fullText(terminal)).not.toContain(toolMarker)
			await waitForText(terminal, toolMarker, { timeoutMs: 10_000 })

			const revisedRequest = await waitForChatRequest(fixture.fake.requests, 2)
			expect(JSON.stringify(revisedRequest.body)).toContain(toolMarker)
			expect(fermentV2Snapshot(revisedRequest)).toMatchObject({
				objective: "revised objective",
				status: "active",
			})
			expect(JSON.stringify(revisedRequest.body)).not.toContain("The new objective supersedes the previous objective")
			expect(chatRequests(fixture.fake.requests).slice(0, 2).some(isVerifierRequest)).toBe(false)
			await waitForText(terminal, "Working from revision two.", { timeoutMs: 5_000 })
			const editRequest = await waitForChatRequest(fixture.fake.requests, 3)
			expect(fermentV2Snapshot(editRequest)).toMatchObject({ objective: "revised objective", status: "active" })
			expect(JSON.stringify(editRequest.body)).toContain("The new objective supersedes the previous objective")
			expect(chatRequests(fixture.fake.requests).slice(0, 3).some(isVerifierRequest)).toBe(false)
			await waitForText(terminal, "Revision two instructions received after settlement.", { timeoutMs: 5_000 })
			expect(fullText(terminal)).not.toContain("Operation aborted")
			expect(fullText(terminal)).not.toContain("Ferment paused because the agent turn was cancelled.")
			trace.step(
				"tool finished without cancellation, its next request used revision 2, and the edit control arrived after settlement",
			)
		},
	)
})

test("Ferment evaluates an explicit completion claim without extra nudges", async ({ terminal }) => {
	const firstHiddenCandidate = "CLAIM_CANDIDATE_MUST_STAY_HIDDEN_UNTIL_VERDICT"
	const secondHiddenCandidate = "REVISED_CLAIM_CANDIDATE"
	const acceptedFinal = "CLAIM_CANDIDATE_ACCEPTED"
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-v2-mode-gated-text-only-completion",
			models: [{ slug: "thinking-model", displayName: "Fake Thinking", reasoning: true }],
			extraArgs: ["--model", "thinking-model"],
			responses: [
				// Verifier run 1: an executing bash check, then a cited continue verdict.
				verifierCheck("verifier-claim-check-1", "pwd"),
				verifierSubmit("continue", "The verifier wants a concise final synthesis.", {
					finding: {
						clause: "Write a concise final synthesis",
						observed: "the synthesis is missing from the delivered work",
						expected: "Write a concise final synthesis",
					},
					textDelayMs: 5_500,
				}),
				// Verifier run 2: an executing bash check, then a cited met verdict.
				verifierCheck("verifier-claim-check-2", "pwd -P"),
				verifierSubmit("met", "The verified work and concise synthesis satisfy the objective.", {
					resolve: [{ id: "F1", resolution: "fixed", reproduction: "pwd -P" }],
				}),
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
					toolCalls: [
						{
							id: "claim-text-only-candidate",
							function: {
								name: "update_ferment_v2",
								arguments: JSON.stringify({ status: "complete", completion_confidence: "tested" }),
							},
						},
					],
				},
				{
					thinking: ["Reviewing the revised completion candidate."],
					stream: [secondHiddenCandidate],
					usage: { prompt_tokens: 20, completion_tokens: 5 },
					toolCalls: [
						{
							id: "reclaim-text-only-candidate",
							function: {
								name: "update_ferment_v2",
								arguments: JSON.stringify({ status: "complete", completion_confidence: "tested" }),
							},
						},
					],
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

			terminal.submit("/ferment finish the task")
			await waitForText(terminal, acceptedFinal, { timeoutMs: 20_000 })
			await waitForText(terminal, "Ferment complete.", { timeoutMs: 5_000 })
			await waitForText(terminal, "Prompt summary", { timeoutMs: 5_000 })
			const requests = chatRequests(fixture.fake.requests)
			expect(requests).toHaveLength(9)
			const continuation = JSON.stringify(requests[5]?.body)
			expect(continuation).toContain("Remaining task gap: F1 Write a concise final synthesis: expected")
			expect(continuation).toContain("observed the synthesis is missing from the delivered work")
			expect(continuation).not.toMatch(/independent evaluation|completion policy|the evaluator/i)
			expect(JSON.stringify(requests)).not.toContain("If you have finished, please summarize the result")
			expect(fullText(terminal)).not.toContain(firstHiddenCandidate)
			expect(fullText(terminal)).not.toContain(secondHiddenCandidate)
			expect(fullText(terminal).match(/Prompt summary/g)).toHaveLength(1)
			expect(fullText(terminal).match(/Worked for/g)).toHaveLength(1)
			trace.step("an explicit completion claim reached evaluation without extra nudges or empty-turn steers")
		},
	)
})

test("Ferment reveals the final answer only after evaluation accepts it", async ({ terminal }) => {
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
			env: { KIMCHI_ENABLE_RESOURCES: "extensions.pii-redaction" },
			// Keep this evaluation scenario above the SDK's 16K compaction reserve;
			// the fake model's default 8K window triggers unrelated compaction.
			models: [{ slug: "thinking-model", displayName: "Fake Thinking", reasoning: true, contextWindow: 200_000 }],
			extraArgs: ["--model", "thinking-model"],
			responses: [
				// Verifier run 1: a finding sends the work back for further verification.
				verifierCheck("verifier-gate-check-1", "pwd"),
				verifierSubmit("continue", "Verify the remaining verifier concern.", {
					finding: {
						clause: "Finish behind the evaluator gate",
						observed: "Verify the remaining verifier concern.",
						expected: "Finish behind the evaluator gate",
					},
					textDelayMs: 1_500,
				}),
				// Verifier run 2: bash check, then a cited met verdict.
				verifierCheck("verifier-gate-check-2", "pwd -P"),
				verifierSubmit("met", "The verified work satisfies the objective.", {
					resolve: [{ id: "F1", resolution: "fixed", reproduction: "pwd -P" }],
				}),
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
					stream: ["Finishing the gated completion Todo."],
					toolCalls: [
						{
							id: "finish-gated-completion-todo",
							function: {
								name: "mark_todo",
								arguments: JSON.stringify({
									id: 1,
									status: "completed",
									note: `Evidence: scripted verification completed by ${privateEmail}`,
								}),
							},
						},
					],
				},
				{
					stream: [firstHiddenCandidate],
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
					stream: ["Verifying the remaining evaluator concern."],
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
					stream: [secondHiddenCandidate],
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

			terminal.submit("/ferment finish behind the evaluator gate")
			await waitForText(terminal, "Thought for", { timeoutMs: 5_000 })
			expect(fullText(terminal)).not.toContain(visibleThinking)
			trace.step("active Ferment preserves the normal thinking block")
			await waitForChatRequest(fixture.fake.requests, 2)
			expect(fullText(terminal)).not.toContain(earlyHiddenCandidate)
			const firstEvaluatorRequest = await waitForChatRequest(fixture.fake.requests, 5)
			expect(isVerifierRequest(firstEvaluatorRequest)).toBe(true)
			// The verifier is transcript-free: the hidden completion candidate never
			// reaches it, and the Todo note it does receive is PII-redacted.
			expect(JSON.stringify(firstEvaluatorRequest.body)).not.toContain("UNVERIFIED_CANDIDATE_MUST_STAY_HIDDEN")
			expect(JSON.stringify(firstEvaluatorRequest.body)).not.toContain(privateEmail)
			expect(JSON.stringify(firstEvaluatorRequest.body)).toContain("[EMAIL_ADDRESS_1]")
			const cookingMessage = await waitForCookingAnimation(terminal)
			expect(fullText(terminal)).not.toContain(firstHiddenCandidate)
			trace.step("completion candidate stayed hidden while evaluation was pending")

			const continuationRequest = await waitForChatRequest(fixture.fake.requests, 7)
			expect(JSON.stringify(continuationRequest.body)).toContain(
				"If more work remains after Todos were settled, preserve those Todos and their evidence; extend the list with a concrete missing action or reopen the matching Todo instead of clearing or replacing the list.",
			)
			const resumedWorkRequest = await waitForChatRequest(fixture.fake.requests, 8)
			expect(JSON.stringify(resumedWorkRequest.body)).toContain("Finish behind the evaluator gate")
			expect(JSON.stringify(resumedWorkRequest.body)).toContain("Verify the remaining evaluator concern")
			// The rejected-completion narration is interstitial commentary, which
			// folds once the next tool call runs. Wait for the stable end state;
			// the request above already proves the rebuilt Todo moved through it.
			await waitForText(terminal, "Ferment complete.", { timeoutMs: 5_000 })
			trace.step("rejected completion rebuilt the settled Todo list before further work")

			await waitForText(terminal, acceptedFinal, { timeoutMs: 5_000 })
			await waitForText(terminal, "Ferment complete.", { timeoutMs: 5_000 })
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

test("Ferment preserves exact output when accepted final delivery resumes", async ({ terminal }) => {
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
			seedHome(_homeDir, workDir) {
				writeAcceptedFermentV2Session(join(workDir, sessionFile), workDir, exactOutput)
			},
		},
		async (fixture, trace) => {
			await waitForText(terminal, exactOutput, { timeoutMs: 5_000 })
			await waitForText(terminal, "Ferment complete.", { timeoutMs: 5_000 })
			const requests = chatRequests(fixture.fake.requests)
			expect(requests).toHaveLength(1)
			expect(requests.filter(isVerifierRequest)).toHaveLength(0)
			expect(JSON.stringify(requests[0]?.body)).toContain(
				"If the original objective requires exact output, return exactly that output with no preface or summary.",
			)
			expect(readFileSync(join(fixture.workDir, sessionFile), "utf-8")).toContain('"status":"complete"')
			trace.step("accepted replay delivered the exact payload without reevaluation")
		},
	)
})

test("Ferment pauses when an accepted final answer cannot be delivered", async ({ terminal }) => {
	const hiddenCandidate = "UNDELIVERED_CANDIDATE_MUST_STAY_HIDDEN"
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-v2-mode-final-delivery-error",
			responses: [
				verifierCheck("verifier-delivery-check", "pwd"),
				verifierSubmit("met", "The verified work satisfies the objective."),
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

			terminal.submit("/ferment finish before delivery")
			await waitForText(terminal, "Ferment paused because its final answer could not be delivered.", {
				timeoutMs: 10_000,
			})
			expect(fullText(terminal)).not.toContain(hiddenCandidate)
			expect(fullText(terminal)).not.toContain("Ferment complete.")

			terminal.submit("/ferment")
			await waitForText(terminal, "Status: paused", { timeoutMs: 5_000 })
			await waitForText(terminal, "Last evaluation: met", { timeoutMs: 5_000 })
			trace.step("accepted work stayed non-complete when the final answer stream failed")
		},
	)
})

test("Ferment pauses after the same unresolved gap repeats three times", async ({ terminal }) => {
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
							index: 0,
							function: { name: "bash", arguments: JSON.stringify({ command: "pwd" }) },
						},
						// Round 1 settles the Todo list so the completion claim passes its gate.
						...(index === 0
							? [
									{
										id: "settle-repeated-gap-todo",
										index: 1,
										function: {
											name: "create_todos",
											arguments: JSON.stringify({
												todos: [
													{
														content: "Verify the same requirement",
														status: "completed",
														note: "Evidence: scripted verification completed",
													},
												],
											}),
										},
									},
								]
							: []),
					],
				},
				{
					stream: [`Checked source ${index + 1}.`],
					toolCalls: [
						{
							id: `repeated-gap-claim-${index + 1}`,
							function: {
								name: "update_ferment_v2",
								arguments: JSON.stringify({ status: "complete", completion_confidence: "tested" }),
							},
						},
					],
				},
				verifierCheck(`verifier-repeated-gap-${index + 1}`, "pwd"),
				// The first review opens F1; later ones find it still failing, which keeps it open.
				index === 0
					? verifierSubmit("continue", repeatedGap, {
							finding: {
								clause: "Verify the same requirement",
								observed: "the requirement is still unverified",
								expected: "the requirement is verified",
							},
						})
					: verifierSubmit("continue", repeatedGap, { resolve: [{ id: "F1", resolution: "still_failing" }] }),
			] satisfies FakeResponseScript[],
	).flat()

	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-v2-mode-repeated-gap",
			responses,
		},
		async (fixture, trace) => {
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })

			terminal.submit("/ferment verify the same requirement")
			await waitForText(terminal, "Ferment paused after 3 stalled continuation turns.", {
				timeoutMs: 15_000,
			})
			terminal.submit("/ferment")
			await waitForText(terminal, "Status: paused", { timeoutMs: 5_000 })
			await waitForText(terminal, "Evaluations: 4", { timeoutMs: 5_000 })
			// Four verifier runs, each an executing bash check plus its verdict.
			expect(chatRequests(fixture.fake.requests).filter(isVerifierRequest)).toHaveLength(8)
			trace.step("three repeated verifier gaps paused substantive but ineffective retry work")
		},
	)
})

test("Ferment shows the reason when work is blocked", async ({ terminal }) => {
	const blockedReason = "Needs a user-owned API token."
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-v2-mode-blocked",
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

			terminal.submit("/ferment finish the authenticated setup")
			await waitForText(terminal, "Ferment blocked.", { timeoutMs: 5_000 })
			terminal.submit("/ferment")
			await waitForText(terminal, "Status: blocked", { timeoutMs: 5_000 })
			await waitForText(terminal, `Blocked reason: ${blockedReason}`, { timeoutMs: 5_000 })
			await new Promise((resolve) => setTimeout(resolve, 500))
			expect(chatRequests(fixture.fake.requests)).toHaveLength(1)
			trace.step("blocked Ferment reports its persisted reason without an evaluator call")
		},
	)
})

function enableCompaction(homeDir: string, compaction: { reserveTokens: number; keepRecentTokens: number }): void {
	const settingsPath = join(homeDir, ".config", "kimchi", "harness", "settings.json")
	const settings = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>
	settings.compaction = { enabled: true, ...compaction }
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
	if (!match) throw new Error(`No canonical Ferment context found in request: ${JSON.stringify(request.body)}`)
	return JSON.parse(match[1])
}

function collectStrings(value: unknown): string[] {
	if (typeof value === "string") return [value]
	if (Array.isArray(value)) return value.flatMap(collectStrings)
	if (value && typeof value === "object") return Object.values(value).flatMap(collectStrings)
	return []
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
		// upstream pi starts auto-compaction at run-prepare time, so the turn's
		// first display can be the compaction indicator before any cooking
		// frame appears; both prove the ferment turn is progressing.
		"Auto-compacting",
		"Compacting",
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
