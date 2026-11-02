import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText, waitForTurnToSettle } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"
import { chatRequests, systemPromptOf } from "./support/wire-requests.js"

test.use(TUI_TEST_CONFIG)

// Deterministic long-running command: prints a line, then sleeps well past
// the initial handoff (2s under the e2e fixture) so the first result yields a background handle,
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
			const systemPrompt = systemPromptOf(chatRequests(fixture)[0])
			expect(systemPrompt).toContain("harness-owned safety limit")
			expect(systemPrompt).not.toContain("the bash tool's `timeout` parameter")
			expect(systemPrompt).not.toContain("default 60s")
			const messages = fixture.fake.requests.flatMap(
				(r) => (r.body as { messages?: { role?: string; content?: unknown }[] } | undefined)?.messages ?? [],
			)
			const textOf = (content: unknown): string => (typeof content === "string" ? content : JSON.stringify(content))
			const contains = (needle: string, role?: string) =>
				messages.some((m) => textOf(m.content).includes(needle) && (role === undefined || m.role === role))
			expect(contains("[Background bash process ended", "tool")).toBe(true)
			expect(contains("[Background bash process ended", "user")).toBe(false)
			// The handoff result names the live log and teaches the watch
			// pattern, so the model can grep instead of polling or re-running.
			expect(contains(" full log: ", "tool")).toBe(true)
			expect(contains("until grep -qE", "tool")).toBe(true)
			// 4 LLM requests: spawn, concurrent read, wait, final.
			expect(fixture.fake.requests.length).toBeGreaterThanOrEqual(4)
		},
	)
})

// Workflow 4: the model attempts to finish with a live background process.
// A user-facing session (the TUI) queues NO forced-disposition reminder —
// the run settles immediately with the process still running, and no
// reminder spin is possible. The unattended rate-limit contract stays
// covered at unit level (bash-control-extension.test.ts) and through the
// headless contract session (agent-session-contract.test.ts).
test("background bash: an unresolved stop settles the run without a forced reminder (user-facing session)", async ({
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
				// Turn 2: the model attempts to finish WITHOUT resolving the process —
				// a user-facing session queues no reminder, so the run settles with
				// the process still running.
				{ stream: ["All done!"] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Run a long command then finish without stopping it")

			// Completion attempt with a tracked process.
			await waitForText(terminal, "All done!", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("completion attempt with a tracked process")

			// The run settles straight away — no continuation, no reminder spin.
			await waitForText(terminal, "ask anything or type", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("run settled with the process still running (no reminder)")

			// No reminder was ever queued for the provider.
			await waitForTurnToSettle(fixture.fake.requests)
			// The last request may be a title-generation side request (no
			// conversation history): count in the last AGENT request.
			const agentRequests = fixture.fake.requests.filter((r) =>
				JSON.stringify((r.body as { messages?: unknown[] } | undefined)?.messages ?? []).includes(
					"Run a long command then finish without stopping it",
				),
			)
			const lastMessages = (agentRequests.at(-1)?.body as { messages?: unknown[] } | undefined)?.messages ?? []
			const lastHistory = JSON.stringify(lastMessages)
			expect(
				lastHistory.split("Task completion requires a disposition for unresolved background bash processes").length - 1,
			).toBe(0)
			// No reminder spin: only the scripted agent turns (spawn,
			// unresolved stop) hit the main queue. Side traffic (title, catalog,
			// classifiers) is excluded because it carries no tools.
			const mainRequests = fixture.fake.requests.filter((r) =>
				Array.isArray(((r as { body?: { tools?: unknown[] } }).body ?? (r as { tools?: unknown[] }))?.tools),
			)
			expect(mainRequests.length).toBeLessThanOrEqual(3)
		},
	)
})

// Cohort workflows (multi-command staggering, streaming-safe exit delivery,
// bounded checkpoints, wait cancellation) live in ./bash-background-cohort.test.ts.
