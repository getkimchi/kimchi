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

test("parent verifies a worker that finished after a soft-limit warning and completes its TODO", async ({
	terminal,
}) => {
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
					toolCalls: [call("worker-read-marker", "read", { path: "INPUT.txt" })],
				},
				{ forSubagent: true, stream: ["INPUT.txt contains verified-marker."] },
				{
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
				{ stream: ["MARKER-REVIEW-DONE"] },
			],
		},
		async (_fixture, trace) => {
			terminal.submit("Delegate the marker read, verify it and reconcile its TODO")
			await waitForText(terminal, "MARKER-REVIEW-DONE", { timeoutMs: STREAM_TIMEOUT_MS })
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
									todos: [{ content: "Check source marker", status: "completed", note: "Evidence: source-marker-42" }],
								}),
							},
						},
					],
				},
				{
					forSubagent: true,
					match: (request) => {
						const body = JSON.stringify(request.body ?? {})
						return body.includes("ALPHA task") && body.includes("call_alpha_post") && !body.includes("ALPHA-DONE")
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
