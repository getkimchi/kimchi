import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

function enableCommunication(homeDir: string): void {
	const path = join(homeDir, ".config", "kimchi", "harness", "settings.json")
	const settings = JSON.parse(readFileSync(path, "utf-8"))
	settings.resources = { ...settings.resources, "extensions.agent-communication": true }
	writeFileSync(path, `${JSON.stringify(settings)}\n`, "utf-8")
}

for (const mode of ["waiting", "prequeued", "foreground"] as const) {
	const prequeued = mode === "prequeued"
	const foreground = mode === "foreground"
	const name = {
		waiting: "parent answers a worker question while waiting for that worker to finish",
		prequeued: "parent answers a question already queued before it waits",
		foreground: "parent answers a foreground worker before it finishes",
	}[mode]
	test(name, async ({ terminal }) => {
		const call = (id: string, name: string, args: Record<string, unknown>) => ({
			id,
			function: { name, arguments: JSON.stringify(args) },
		})
		await runKimchiSession(
			terminal,
			{
				artifactName: `agent-communication-${mode}-question`,
				seedHome: (homeDir, workDir) => {
					enableCommunication(homeDir)
					if (prequeued) {
						const extensionsDir = join(homeDir, ".config", "kimchi", "harness", "extensions")
						mkdirSync(extensionsDir, { recursive: true })
						writeFileSync(
							join(extensionsDir, "wait-for-question.ts"),
							`
	import { existsSync } from "node:fs"
	import { join } from "node:path"
	export default function(pi) {
	 pi.on("tool_call", async (event, ctx) => {
	  if (event.toolCallId !== "wait-for-child") return
	  const deadline = Date.now() + 10000
	  while (!existsSync(join(ctx.cwd, "SENT"))) {
	   if (Date.now() > deadline) throw new Error("Worker did not send its question")
	   await new Promise(resolve => setTimeout(resolve, 20))
	  }
	 })
	}
	`,
						)
					}
					const agentsDir = join(workDir, ".kimchi", "agents")
					mkdirSync(agentsDir, { recursive: true })
					writeFileSync(
						join(agentsDir, "waiting-child.md"),
						"---\ndescription: waiting child\nprompt_mode: append\nextensions: true\nskills: false\n---\nAsk the parent which option to use. Finish after its reply.",
					)
				},
				models: [{ slug: "basic", displayName: "Fake Basic", input: ["text"] }],
				responses: [
					{
						toolCalls: [
							call("start-waiting-child", "Agent", {
								prompt: "Wait for ASK, ask which option to use, then wait for ANSWER before finishing.",
								description: "waiting child",
								subagent_type: "waiting-child",
								communication: "parent",
								run_in_background: !foreground,
							}),
						],
					},
					...(foreground
						? []
						: [
								{
									toolCalls: [call("wait-for-child", "get_subagent_result", { agent_id: "__AGENT_ID__", wait: true })],
								},
							]),
					{
						toolCalls: [
							call("answer-waiting-child", "reply_to_agent_message", {
								message_id: "__MESSAGE_ID__",
								answer: "Use option A.",
								max_turns: 3,
								max_duration: 30,
							}),
							call("release-waiting-child", "write", { path: "ANSWER", content: "A" }),
						],
					},
					{ stream: ["PARENT-ANSWERED-DURING-WAIT"] },
					{
						forSubagent: true,
						toolCalls: [call("await-ask", "bash", { command: "while [ ! -f ASK ]; do sleep 0.05; done" })],
					},
					{
						forSubagent: true,
						toolCalls: [
							call("ask-during-wait", "send_agent_message", {
								recipient: { type: "parent" },
								payload: {
									kind: "question",
									question: "Which option should the waiting worker use?",
									impact: "Required to finish the work.",
									canContinue: false,
								},
							}),
						],
					},
					{
						forSubagent: true,
						toolCalls: [
							call("await-answer", "bash", {
								command: "printf ready > SENT; while [ ! -f ANSWER ]; do sleep 0.05; done",
							}),
						],
					},
					{ forSubagent: true, stream: ["WORKER-FINISHED-AFTER-ANSWER"] },
				],
			},
			async (fixture, trace) => {
				terminal.submit("Start the worker and wait for its result")
				await waitForText(terminal, foreground ? "waiting child" : "Get Subagent Result", {
					timeoutMs: STREAM_TIMEOUT_MS,
				})
				trace.step("parent is waiting for the running worker")
				writeFileSync(join(fixture.workDir, "ASK"), "ask now")
				await waitForText(terminal, "PARENT-ANSWERED-DURING-WAIT", { timeoutMs: STREAM_TIMEOUT_MS })
				await waitForText(terminal, "WORKER-FINISHED-AFTER-ANSWER", { timeoutMs: STREAM_TIMEOUT_MS })
				const requests = fixture.fake.requests
					.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
					.map((request) => JSON.stringify(request.body))
				const answered = requests.find((body) => body.includes('"tool_call_id":"answer-waiting-child"'))
				expect(answered).toContain("queued_for_running_session")
				expect(answered).toContain(
					foreground ? "Agent sent to background to handle a pending message." : "Status: running",
				)
				expect(answered).toContain("Which option should the waiting worker use?")
				expect(answered).not.toContain("WORKER-FINISHED-AFTER-ANSWER")
				expect(readFileSync(join(fixture.workDir, "ANSWER"), "utf-8")).toBe("A")
				trace.step("parent answered before worker completion and the worker finished")
			},
		)
	})
}

test("parent verifies a finished worker, completes its TODO and closes its resolved question", async ({ terminal }) => {
	const call = (id: string, name: string, args: Record<string, unknown>) => ({
		id,
		function: { name, arguments: JSON.stringify(args) },
	})
	await runKimchiSession(
		terminal,
		{
			artifactName: "agent-communication-steered-reconciliation",
			seedHome: (homeDir, workDir) => {
				enableCommunication(homeDir)
				const agentsDir = join(workDir, ".kimchi", "agents")
				mkdirSync(agentsDir, { recursive: true })
				writeFileSync(
					join(agentsDir, "marker-reader.md"),
					"---\ndescription: marker reader\nprompt_mode: append\nextensions: true\nskills: false\n---\nRead INPUT.txt and report its marker.",
				)
				writeFileSync(join(workDir, "INPUT.txt"), "verified-marker\n")
			},
			models: [{ slug: "basic", displayName: "Fake Basic", input: ["text"] }],
			responses: [
				{
					toolCalls: [
						call("create-marker-todo", "create_todos", {
							todos: [{ content: "Verify worker marker", status: "in_progress" }],
						}),
					],
				},
				{
					toolCalls: [
						call("start-marker-reader", "Agent", {
							prompt: "Read INPUT.txt and report the exact marker.",
							description: "marker reader",
							subagent_type: "marker-reader",
							communication: "parent",
							max_turns: 1,
						}),
					],
				},
				{
					forSubagent: true,
					toolCalls: [
						call("worker-read-marker", "read", { path: "INPUT.txt" }),
						call("worker-marker-question", "send_agent_message", {
							recipient: { type: "parent" },
							payload: {
								kind: "question",
								question: "Does the marker match?",
								impact: "Verification",
								canContinue: true,
							},
						}),
					],
				},
				{ forSubagent: true, stream: ["INPUT.txt contains verified-marker."] },
				{
					toolCalls: [call("wait-for-marker", "get_subagent_result", { agent_id: "__AGENT_ID__", wait: true })],
				},
				{
					stream: ["Worker finished; checking its question and artifact."],
					toolCalls: [
						call("reconcile-before-check", "reconcile_agent_result", {
							agent_id: "__AGENT_ID__",
							todo_id: 1,
							note: "Worker reported the marker.",
						}),
					],
				},
				{ toolCalls: [call("parent-read-marker", "read", { path: "INPUT.txt" })] },
				{
					toolCalls: [
						call("reconcile-after-check", "reconcile_agent_result", {
							agent_id: "__AGENT_ID__",
							todo_id: 1,
							note: "Parent read confirms the worker reported verified-marker correctly.",
							verification_tool_call_id: "parent-read-marker",
						}),
					],
				},
				{
					toolCalls: [
						call("stale-marker-reply", "reply_to_agent_message", {
							message_id: "__MESSAGE_ID__",
							answer: "Already verified. No work remains.",
							max_turns: 1,
							max_duration: 30,
						}),
					],
				},
				{ stream: ["MARKER-REVIEW-DONE"] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Delegate the marker read, verify it and reconcile its TODO")
			await waitForText(terminal, "MARKER-REVIEW-DONE", { timeoutMs: STREAM_TIMEOUT_MS })
			const requests = fixture.fake.requests
				.filter((request) => request.url.startsWith("/openai/v1/chat/completions"))
				.map((request) => JSON.stringify(request.body))
			expect(requests.some((body) => body.includes("Closed questions:"))).toBe(true)
			expect(requests.some((body) => body.includes("thread_closed"))).toBe(true)
			expect(requests.some((body) => body.includes("Host-mediated answer to your message"))).toBe(false)
			trace.step("worker finished after its soft limit and parent checked the marker")
			terminal.write("/todos")
			await waitForText(terminal, "/todos")
			terminal.submit("")
			await waitForText(terminal, "1/1 done · 0 active", { timeoutMs: STREAM_TIMEOUT_MS, full: false })
			expect(viewText(terminal)).toContain("Verify worker marker")
			trace.step("verified worker result completed the existing TODO")
		},
	)
})

test("communicating child asks through parent, resumes after reply, and shows its final result", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "agent-communication-question-reply-resume",
			seedHome: (_homeDir, workDir) => {
				enableCommunication(_homeDir)
				const agentsDir = join(workDir, ".kimchi", "agents")
				mkdirSync(agentsDir, { recursive: true })
				writeFileSync(
					join(agentsDir, "communicating-child.md"),
					"---\ndescription: communicating child\nprompt_mode: append\nextensions: true\nskills: false\n---\nAsk the user one focused question, then wait for the parent reply.",
					"utf-8",
				)
			},
			models: [{ slug: "basic", displayName: "Fake Basic", input: ["text"] }],
			responses: [
				{
					toolCalls: [
						{
							id: "call_background_child",
							function: {
								name: "Agent",
								arguments: JSON.stringify({
									prompt: "Ask one user question, then stop and await the parent's reply.",
									description: "communicating child",
									subagent_type: "communicating-child",
									communication: "parent",
									run_in_background: true,
								}),
							},
						},
					],
				},
				{ stream: ["background child started"] },
				{
					stream: ["answering the child"],
					textDelayMs: 300,
					toolCalls: [
						{
							id: "call_reply_to_child",
							function: {
								name: "reply_to_agent_message",
								arguments: JSON.stringify({
									message_id: "__MESSAGE_ID__",
									answer: "Use option A.",
									max_turns: 2,
									max_duration: 30,
								}),
							},
						},
					],
				},
				{
					forSubagent: true,
					stream: ["child asks: which option should I use?"],
					toolCalls: [
						{
							id: "call_child_question",
							function: {
								name: "send_agent_message",
								arguments: JSON.stringify({
									recipient: { type: "user" },
									payload: {
										kind: "question",
										question: "Which option should I use?",
										impact: "Changes the implementation scope.",
										options: ["A", "B"],
										recommendedDefault: "A",
										canContinue: false,
									},
								}),
							},
						},
					],
				},
				{ forSubagent: true, stream: ["child settled and awaiting the answer"] },
				{ forSubagent: true, stream: ["final report: child received option A"] },
			],
		},
		async (_fixture, trace) => {
			terminal.submit("start a communicating child")
			await waitForText(terminal, "Which option should I use?", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("child question is visible through the parent notification")

			await waitForText(terminal, /requestedAudience=user/, { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("parent notification carries the user audience")

			await waitForText(terminal, "final report: child received option A", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("bounded continuation returns the child final result")
			expect(viewText(terminal)).toContain("final report: child received option A")
		},
	)
})

test("a worker TODO update reaches its peer through the coordination board", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "agent-communication-board-workflow",
			seedHome: (_homeDir, workDir) => {
				enableCommunication(_homeDir)
				const agentsDir = join(workDir, ".kimchi", "agents")
				mkdirSync(agentsDir, { recursive: true })
				writeFileSync(
					join(agentsDir, "board-worker.md"),
					"---\ndescription: board worker\nprompt_mode: append\nextensions: true\nskills: false\n---\nFollow the task instructions exactly.",
					"utf-8",
				)
				writeFileSync(join(workDir, "README.txt"), "board test fixture\n", "utf-8")
			},
			models: [{ slug: "basic", displayName: "Fake Basic", input: ["text"] }],
			responses: [
				{
					toolCalls: [
						{
							id: "call_spawn_alpha",
							function: {
								name: "Agent",
								arguments: JSON.stringify({
									prompt: "ALPHA task: complete a TODO with a checked result and list contacts, then settle.",
									description: "board worker alpha",
									subagent_type: "board-worker",
									communication: "group",
									run_in_background: true,
								}),
							},
						},
						{
							id: "call_spawn_beta",
							function: {
								name: "Agent",
								arguments: JSON.stringify({
									prompt: "BETA task: read the coordination board, then settle showing the board entry.",
									description: "board worker beta",
									subagent_type: "board-worker",
									communication: "group",
									run_in_background: true,
								}),
							},
						},
					],
				},
				{ stream: ["coordinator: agents spawned"] },
				{
					match: (request) => {
						const body = JSON.stringify(request.body ?? {})
						return body.includes("BETA-DONE") && !body.includes("ALPHA-DONE")
					},
					textDelayMs: 1000,
					stream: ["coordinator: BETA finished"],
				},
				{
					match: (request) => {
						const body = JSON.stringify(request.body ?? {})
						return body.includes("BETA-DONE") && body.includes("ALPHA-DONE")
					},
					stream: ["PROBE-BOARD-DONE: board workflow complete"],
				},
				{
					forSubagent: true,
					match: (request) => {
						const body = JSON.stringify(request.body ?? {})
						return body.includes("ALPHA task") && !body.includes("call_alpha_post")
					},
					textDelayMs: 1500,
					stream: ["ALPHA: preparing to post"],
					toolCalls: [
						{
							id: "call_alpha_post",
							function: {
								name: "create_todos",
								arguments: JSON.stringify({
									todos: [{ content: "Check source marker", status: "in_progress", note: "superseded-marker" }],
								}),
							},
						},
					],
				},
				{
					forSubagent: true,
					match: (request) => {
						const body = JSON.stringify(request.body ?? {})
						return (
							body.includes("ALPHA task") && body.includes("call_alpha_post") && !body.includes("call_alpha_update")
						)
					},
					toolCalls: [
						{
							id: "call_alpha_update",
							function: {
								name: "update_todos",
								arguments: JSON.stringify({
									todos: [
										{ id: 1, content: "Check source marker", status: "completed", note: "Evidence: source-marker-42" },
									],
								}),
							},
						},
					],
				},
				{
					forSubagent: true,
					match: (request) => {
						const body = JSON.stringify(request.body ?? {})
						return (
							body.includes("ALPHA task") && body.includes("call_alpha_update") && !body.includes("call_alpha_ready")
						)
					},
					stream: ["ALPHA: posted and listing contacts"],
					toolCalls: [
						{
							id: "call_alpha_ready",
							function: {
								name: "write",
								arguments: JSON.stringify({ path: "alpha-ready.txt", content: "ready" }),
							},
						},
					],
				},
				{
					forSubagent: true,
					match: (request) =>
						JSON.stringify(request.body).includes("ALPHA task") &&
						JSON.stringify(request.body).includes("call_alpha_ready"),
					stream: ["ALPHA-DONE: board posted"],
				},
				{
					forSubagent: true,
					match: (request) => {
						const body = JSON.stringify(request.body ?? {})
						return body.includes("BETA task") && !body.includes("call_beta_wait")
					},
					textDelayMs: 1500,
					stream: ["BETA: will read the board"],
					toolCalls: [
						{
							id: "call_beta_wait",
							function: {
								name: "bash",
								arguments: JSON.stringify({
									command: "for i in {1..100}; do test -f alpha-ready.txt && exit 0; sleep 0.05; done; exit 1",
								}),
							},
						},
					],
				},
				{
					forSubagent: true,
					match: (request) => {
						const body = JSON.stringify(request.body)
						return body.includes("BETA task") && body.includes("call_beta_wait") && !body.includes("call_beta_read")
					},
					toolCalls: [{ id: "call_beta_read", function: { name: "read_agent_board", arguments: "{}" } }],
				},

				{
					forSubagent: true,
					match: (request) => {
						const body = JSON.stringify(request.body ?? {})
						return (
							body.includes("BETA task") &&
							body.includes("call_beta_read") &&
							body.includes("TODO progress: 1/1 completed") &&
							body.includes("source-marker-42") &&
							!body.includes("superseded-marker") &&
							!body.includes("BETA-DONE")
						)
					},
					stream: ["BETA-DONE: read TODO progress and source-marker-42"],
				},
				{
					forSubagent: true,
					match: (request) =>
						JSON.stringify(request.body).includes("BETA task") &&
						JSON.stringify(request.body).includes("call_beta_read"),
					stream: ["BETA-DONE: missing snapshot"],
				},
			],
		},
		async (_fixture, trace) => {
			terminal.submit("start a board workflow with two workers")
			await waitForText(terminal, "PROBE-BOARD-DONE: board workflow complete", { timeoutMs: 120_000 })
			trace.step("board workflow completed through the terminal")
			// Assert on user-visible terminal state only: the per-worker completion
			// markers and the coordinator's workflow-complete line. Tool results
			// (post receipts, read_agent_board rows) render collapsed in the TUI;
			// receipt-level correctness is covered by probe-c and unit tests.
			const view = viewText(terminal)
			expect(view).toContain("ALPHA-DONE: board posted")
			expect(view).toContain("BETA-DONE: read TODO progress and source-marker-42")
			expect(view).toContain("PROBE-BOARD-DONE: board workflow complete")
		},
	)
})
