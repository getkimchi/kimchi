import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText, waitForTurnToSettle } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

// Deterministic long-running command: prints a line, then sleeps well past
// the ~2s initial handoff so the first result yields a background handle,
// and exits on its own shortly after.
const LONG_COMMAND = "echo started && sleep 15"

// Workflow 1: start a slow command, do independent work (read), then block
// with one bounded wait that resolves on the command's natural exit.
test("background bash: slow command + independent read + final outcome via one bounded wait", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "bash-background-concurrent-read-exit",
			responses: [
				// Turn 1: the model starts a long-running background bash command.
				{
					stream: ["Starting a long-running command."],
					toolCalls: [
						{
							id: "call_bash",
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: LONG_COMMAND }),
							},
						},
					],
				},
				// Turn 2: the model does independent work (read) while the
				// process continues — this must NOT be blocked.
				{
					stream: ["Reading a file while the command runs."],
					toolCalls: [
						{
							id: "call_read",
							function: {
								name: "read",
								arguments: JSON.stringify({ path: "README.md" }),
							},
						},
					],
				},
				// Turn 3: nothing else to do — one bounded wait blocks until the
				// command exits (before the 300s default checkpoint).
				{
					stream: ["Nothing more to do; waiting for the command."],
					toolCalls: [
						{
							id: "call_wait",
							function: {
								name: "bash_control",
								arguments: JSON.stringify({ wait: true }),
							},
						},
					],
				},
				// Turn 4: the wait returned with the command's final outcome.
				{ stream: ["The command finished with its output."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Run a long command, read a file while it runs, then wait for its outcome")

			// The initial handoff arrives (~2s): the bash tool call resolves at the
			// bounded handoff window ("Took 2.xs") instead of blocking for the
			// command's full 15s runtime. The TUI collapses the first lines of the
			// result block, so the call's duration line is the visible signal.
			await waitForText(terminal, /Took 2\.\d+s/, { timeoutMs: STREAM_TIMEOUT_MS * 2 })
			trace.step("initial background handoff visible")

			// The read tool call runs while the process is still tracked — it
			// must not be hard-blocked.
			await waitForText(terminal, "Reading a file while the command runs", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("read tool executed concurrently")

			// The bounded wait blocks until the natural exit (~15s), then the
			// model continues with the final outcome in hand.
			await waitForText(terminal, "waiting for the command", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("bounded wait issued")
			await waitForText(terminal, "The command finished with its output", {
				timeoutMs: STREAM_TIMEOUT_MS * 3,
			})
			trace.step("wait resolved on exit")

			// Channel-aware assertions: the exit arrived INSIDE the wait's
			// tool result (role tool), not as a standalone notification
			// message (role user), and exactly once.
			await waitForTurnToSettle(fixture.fake.requests)
			const messages = fixture.fake.requests.flatMap(
				(r) => (r.body as { messages?: { role?: string; content?: unknown }[] } | undefined)?.messages ?? [],
			)
			const textOf = (content: unknown): string => (typeof content === "string" ? content : JSON.stringify(content))
			const contains = (needle: string, role?: string) =>
				messages.some((m) => textOf(m.content).includes(needle) && (role === undefined || m.role === role))
			expect(contains("[Background bash process ended", "tool")).toBe(true)
			expect(contains("[Background bash process ended", "user")).toBe(false)
			// 4 LLM requests: spawn, concurrent read, wait, final.
			expect(fixture.fake.requests.length).toBeGreaterThanOrEqual(4)
		},
	)
})

// Workflow 4: the model attempts to finish twice with unresolved managed
// work — each attempt gets a continuation; only the resolved attempt
// settles the run.
test("background bash: repeated completion attempts with a live process each require a disposition", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "bash-background-completion-guard-repeated",
			responses: [
				// Turn 1: the model starts a long-running background bash command.
				{
					stream: ["Starting a long-running command."],
					toolCalls: [
						{
							id: "call_bash",
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: "echo started && sleep 60" }),
							},
						},
					],
				},
				// Turn 2: the model attempts to finish WITHOUT resolving the process.
				{ stream: ["All done!"] },
				// Turn 3 (driven by the completion continuation): the model stops
				// again, still without resolving — the guard fires again.
				{ stream: ["Still done — nothing else is needed."] },
				// Turn 4 (second continuation): the model finally stops the process.
				{
					stream: ["Fine — stopping the process."],
					toolCalls: [
						{
							id: "call_stop",
							function: {
								name: "bash_control",
								arguments: JSON.stringify({
									stop_handles: ["__BASH_HANDLE__"],
									wait: false,
								}),
							},
						},
					],
				},
				// Turn 5: the model finishes for real, with everything resolved.
				{ stream: ["Now everything is resolved."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Run a long command then finish twice without stopping it")

			// The initial handoff arrives (~2s): the bash tool call resolves at
			// the bounded handoff window instead of blocking for the full 60s.
			await waitForText(terminal, /Took 2\.\d+s/, { timeoutMs: STREAM_TIMEOUT_MS * 2 })
			trace.step("initial background handoff visible")

			// First completion attempt with a tracked process.
			await waitForText(terminal, "All done!", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("first completion attempt with a tracked process")

			// The continuation fires; the model tries to finish AGAIN without
			// resolving — a second continuation must fire (no lifetime
			// suppression on a stable handle set).
			await waitForText(terminal, "Still done", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("second unresolved completion attempt")

			// The model stops the process and finishes for real.
			await waitForText(terminal, "stopping the process", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("continuation caused the process to be stopped")
			await waitForText(terminal, "Now everything is resolved", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("session settled after resolution")

			// Both unresolved attempts produced a continuation; the resolved
			// run settled with the stop applied. The LAST request's history
			// carries each continuation exactly once (earlier requests also
			// replay them, so the full history cannot be counted directly).
			await waitForTurnToSettle(fixture.fake.requests)
			const lastMessages = (fixture.fake.requests.at(-1)?.body as { messages?: unknown[] } | undefined)?.messages ?? []
			const lastHistory = JSON.stringify(lastMessages)
			expect(
				lastHistory.split("Task completion requires a disposition for unresolved background bash processes").length - 1,
			).toBe(2)
			expect(lastHistory).toContain("Still running")
			// 5 LLM requests: spawn, two unresolved stops, stop, final.
			expect(fixture.fake.requests.length).toBeGreaterThanOrEqual(5)
		},
	)
})

// Cohort workflows (multi-command staggering, streaming-safe exit delivery,
// bounded checkpoints, wait cancellation) live in ./bash-background-cohort.test.ts.
