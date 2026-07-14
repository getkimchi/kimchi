/**
 * E2E TUI test: --ferment-oneshot survives two consecutive text-only stops
 * during draft scoping and eventually completes scoping via a real
 * scope_ferment tool call.
 *
 * Before the fix, `MAX_CONSECUTIVE_REACTIVE_NUDGES = 1` meant the second
 * text-only stop exhausted the retry budget and the session stalled with no
 * plan persisted. The lifecycle obligation guard (budget: 2, keyed by
 * obligation) gives the model a third opportunity, and this test proves a
 * valid `scope_ferment` call on that third attempt actually persists the plan.
 *
 * Regression: do not treat prose mentioning the tool ("Calling scope_ferment
 * now") as success — the third response must contain a real tool call.
 */

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { TUI_TEST_CONFIG, runKimchiSession } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("--ferment-oneshot survives two text-only stops and completes scoping on the third attempt", async ({
	terminal,
}) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "ferment-oneshot-scope-nudge",
			gitInit: true,
			extraArgs: ["--ferment-oneshot=true"],
			responses: [
				// Response 1: text-only stop (no tool calls) — the exact stall pattern.
				{ stream: ["I'll start by gathering the requirements for this task.\n"] },
				// Response 2: prose announces intent to call scope_ferment but
				// returns NO tool call — the exact "calling scope_ferment now"
				// failure mode from the bug report.
				{ stream: ["Calling scope_ferment now.\n"] },
				// Response 3: a valid scope_ferment tool call with a minimal
				// complete plan and exactly P1/P2/P3 gates. The __FERMENT_ID__
				// placeholder is substituted by the fake server from the request
				// body.
				{
					stream: ["Saving the plan now.\n"],
					toolCalls: [
						{
							id: "call_scope_1",
							index: 0,
							type: "function",
							function: {
								name: "scope_ferment",
								arguments: JSON.stringify({
									ferment_id: "__FERMENT_ID__",
									title: "Hello World CLI",
									goal: "Build a hello-world CLI tool",
									success_criteria: ["Running the CLI prints 'Hello, World!'"],
									constraints: ["Must be a single executable"],
									assumptions: "Node.js is available.",
									phases: [
										{
											name: "Implement CLI",
											goal: "Create the hello-world CLI",
											steps: [
												{
													description: "Write the CLI entry point",
													verify: "node index.js",
												},
											],
										},
									],
									gates: [
										{
											id: "P1",
											verdict: "pass",
											rationale: "Step has a verify command",
											evidence: "node index.js prints output",
										},
										{
											id: "P2",
											verdict: "omitted",
											rationale: "Single phase, no ordering concerns",
											evidence: "n/a",
										},
										{
											id: "P3",
											verdict: "pass",
											rationale: "CLI output is observable",
											evidence: "node index.js exit code 0",
										},
									],
								}),
							},
						},
					],
				},
				// Response 4: a brief follow-up so the post-scoping turn has
				// content and the test can assert the session did not terminate.
				{ stream: ["Plan saved. Ready to activate the phase.\n"] },
			],
		},
		async (fixture, trace) => {
			// Stage 1: ready prompt.
			await waitForText(terminal, "ask anything or type / for commands", { timeoutMs: STARTUP_TIMEOUT_MS })
			trace.step("ready prompt visible")

			// Stage 2: submit a request — bootstraps a draft ferment under
			// automated policy in oneshot mode.
			terminal.submit("Build a hello-world CLI")
			trace.step("submitted oneshot request — draft ferment bootstrapped")

			// Stage 3: the first (text-only) response streams out.
			await waitForText(terminal, "gathering the requirements", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("first text-only stop response streamed")

			// Stage 4: the lifecycle guard injects retry 1, the second
			// (text-only) response streams out — proving the guard did not
			// suppress the continuation.
			await waitForText(terminal, "Calling scope_ferment now", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("second text-only stop response streamed — guard retry 1 fired")

			// Stage 5: the lifecycle guard injects retry 2, the third response
			// actually calls scope_ferment. The tool result should appear in
			// the terminal, proving the tool call succeeded.
			await waitForText(terminal, "Saving the plan now", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("third response with scope_ferment tool call streamed")

			// Stage 6: the post-scoping follow-up response streams — proves the
			// session did not terminate after response 2 or 3.
			await waitForText(terminal, "Plan saved", { timeoutMs: STREAM_TIMEOUT_MS })
			trace.step("post-scoping follow-up streamed — session survived")

			// Stage 7: assert the fake server received at least three POST
			// completion requests — the initial turn plus two guard retries.
			const chatPosts = fixture.fake.requests.filter((r) => r.method === "POST" && r.url.includes("/chat/completions"))
			expect(chatPosts.length).toBeGreaterThanOrEqual(3)
			trace.step("at least three chat-completion POSTs recorded — two guard retries fired")

			// Stage 8: assert the third response actually invoked scope_ferment.
			// We check the recorded requests for a tool_call to scope_ferment —
			// do NOT treat prose mentioning the tool as success.
			const scopeToolCallBodies = chatPosts.filter((r) => {
				const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body ?? "")
				return body.includes('"scope_ferment"') && body.includes('"tool_calls"')
			})
			expect(scopeToolCallBodies.length).toBeGreaterThanOrEqual(1)
			trace.step("scope_ferment tool call was actually sent — not just prose")

			// Stage 9: prove the tool succeeded by reading the persisted Ferment,
			// rather than inferring success from the model's scripted follow-up.
			const fermentsDir = join(fixture.workDir, ".kimchi", "ferments")
			const deadline = Date.now() + STREAM_TIMEOUT_MS
			let planned: Record<string, unknown> | undefined
			while (Date.now() < deadline) {
				try {
					for (const file of readdirSync(fermentsDir).filter((name) => name.endsWith(".json"))) {
						const artifact = JSON.parse(readFileSync(join(fermentsDir, file), "utf-8")) as Record<string, unknown>
						if (artifact.status === "planned" && Array.isArray(artifact.phases) && artifact.phases.length > 0) {
							planned = artifact
							break
						}
					}
				} catch {
					// The artifact directory may not exist until scope_ferment persists.
				}
				if (planned) break
				await new Promise((resolve) => setTimeout(resolve, 250))
			}
			expect(planned).toBeDefined()
			expect((planned?.phases as Array<Record<string, unknown>>)[0]?.name).toBe("Implement CLI")
			trace.step("scope_ferment succeeded — planned Ferment with persisted phase found")
		},
	)
})
