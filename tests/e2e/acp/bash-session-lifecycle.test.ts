import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"
import { STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt, waitFor, waitForSessionUpdate } from "./support/scenarios.js"

for (const otherSession of [false, true]) {
	it(
		`closes and reloads a Bash session after creating another session: ${otherSession}`,
		async () => {
			const fixture = await startAcpFixture({
				artifactName: `bash-session-lifecycle-${otherSession}`,
				responses: [
					{
						toolCalls: [
							{
								id: "spawn-a",
								function: {
									name: "bash",
									arguments: JSON.stringify({ command: 'echo "$$" > lifecycle.pid; sleep 600 & wait' }),
								},
							},
						],
					},
					{ stream: Array.from({ length: 40 }, () => "Drafting in session A. "), textDelayMs: 250 },
					...(otherSession
						? [
								{
									toolCalls: [
										{
											id: "read-b",
											function: { name: "read", arguments: JSON.stringify({ path: "independent.txt" }) },
										},
									],
								},
								{ stream: ["Session B has no background work."] },
							]
						: []),
					{
						toolCalls: [
							{
								id: "read-reloaded",
								function: { name: "read", arguments: JSON.stringify({ path: "independent.txt" }) },
							},
						],
					},
					{ stream: ["Reloaded session A has no background work."] },
				],
			})
			let pid: number | undefined
			try {
				writeFileSync(join(fixture.workDir, "independent.txt"), "independent work")
				const a = await newSession(fixture, fixture.workDir)
				const running = fixture.conn.prompt({
					sessionId: a,
					prompt: [{ type: "text", text: "Start long Bash work and draft" }],
				})
				await waitForSessionUpdate(
					fixture,
					a,
					(update) =>
						update.sessionUpdate === "agent_message_chunk" &&
						update.content.type === "text" &&
						update.content.text.includes("Drafting in session A"),
				)
				pid = Number(readFileSync(join(fixture.workDir, "lifecycle.pid"), "utf8").trim())
				expect(pid).toBeGreaterThan(0)
				await fixture.conn.cancel({ sessionId: a })
				expect((await running).stopReason).toBe("cancelled")
				process.kill(pid, 0)
				if (otherSession) {
					const b = await newSession(fixture, fixture.workDir)
					expect((await prompt(fixture, b, "Inspect session B's Bash cohort")).stopReason).toBe("end_turn")
					expect(
						fixture.fake.requests.filter((request) => request.url.endsWith("/chat/completions")).at(-1)?.body,
					).toMatchObject({
						tools: expect.arrayContaining([
							expect.objectContaining({ function: expect.objectContaining({ name: "bash_control" }) }),
						]),
					})
					expect(
						JSON.stringify(
							fixture.fake.requests.filter((request) => request.url.endsWith("/chat/completions")).at(-1)?.body,
						),
					).not.toContain("lifecycle.pid")
				}
				process.kill(pid, 0)
				await fixture.conn.unstable_closeSession({ sessionId: a })
				await waitFor(
					() => {
						try {
							process.kill(pid ?? 0, 0)
							return true
						} catch (error) {
							if (error instanceof Error && "code" in error && error.code === "ESRCH") return false
							throw error
						}
					},
					(alive) => !alive,
					5000,
				)
				await fixture.conn.loadSession({ sessionId: a, cwd: fixture.workDir, mcpServers: [] })
				expect((await prompt(fixture, a, "Inspect the resumed Bash cohort")).stopReason).toBe("end_turn")
				expect(
					fixture.fake.requests.filter((request) => request.url.endsWith("/chat/completions")).at(-1)?.body,
				).toMatchObject({
					tools: expect.arrayContaining([
						expect.objectContaining({ function: expect.objectContaining({ name: "bash_control" }) }),
					]),
				})
				expect(
					JSON.stringify(
						fixture.fake.requests.filter((request) => request.url.endsWith("/chat/completions")).at(-1)?.body,
					),
				).not.toContain("Task completion requires a disposition")
			} finally {
				await fixture.stop()
				if (pid) {
					try {
						process.kill(-pid, "SIGKILL")
					} catch {
						/* Already drained. */
					}
				}
			}
		},
		STARTUP_TIMEOUT_MS,
	)
}

it(
	"inspects the owning cohort, closes it, and delivers the surviving session's exit exactly once",
	async () => {
		const fixture = await startAcpFixture({
			artifactName: "bash-two-live-sessions",
			responses: [
				{
					toolCalls: [
						{
							id: "spawn-a",
							function: { name: "bash", arguments: JSON.stringify({ command: 'echo "$$" > a.pid; sleep 600 & wait' }) },
						},
					],
				},
				{ stream: Array.from({ length: 40 }, () => "First draft in A. "), textDelayMs: 250 },
				{
					toolCalls: [
						{
							id: "spawn-b",
							function: {
								name: "bash",
								arguments: JSON.stringify({
									command:
										'echo "$$" > b.pid; while [ ! -f exit-b ]; do sleep 0.01; done; echo B-"OWNED-EXIT"; touch b-exited',
								}),
							},
						},
					],
				},
				{ stream: Array.from({ length: 40 }, () => "First draft in B. "), textDelayMs: 250 },
				{ toolCalls: [{ id: "inspect-a", function: { name: "bash_control", arguments: "{}" } }] },
				{ stream: Array.from({ length: 40 }, () => "Second draft in A. "), textDelayMs: 250 },
				{
					stream: ["Independent work in B. ", "Still reading in B. "],
					textDelayMs: 500,
					toolCalls: [
						{ id: "read-b", function: { name: "read", arguments: JSON.stringify({ path: "independent.txt" }) } },
					],
				},
				{ stream: ["Session B received its own exit."] },
			],
		})
		const pids: number[] = []
		try {
			writeFileSync(join(fixture.workDir, "independent.txt"), "independent work in B")
			const a = await newSession(fixture, fixture.workDir)
			const initialA = fixture.conn.prompt({ sessionId: a, prompt: [{ type: "text", text: "Start A's process" }] })
			await waitForSessionUpdate(
				fixture,
				a,
				(update) =>
					update.sessionUpdate === "agent_message_chunk" &&
					update.content.type === "text" &&
					update.content.text.includes("First draft in A"),
			)
			pids.push(Number(readFileSync(join(fixture.workDir, "a.pid"), "utf8").trim()))
			expect(pids[0]).toBeGreaterThan(0)
			await fixture.conn.cancel({ sessionId: a })
			expect((await initialA).stopReason).toBe("cancelled")
			const b = await newSession(fixture, fixture.workDir)
			const initialB = fixture.conn.prompt({ sessionId: b, prompt: [{ type: "text", text: "Start B's process" }] })
			await waitForSessionUpdate(
				fixture,
				b,
				(update) =>
					update.sessionUpdate === "agent_message_chunk" &&
					update.content.type === "text" &&
					update.content.text.includes("First draft in B"),
			)
			pids.push(Number(readFileSync(join(fixture.workDir, "b.pid"), "utf8").trim()))
			expect(pids[1]).toBeGreaterThan(0)
			await fixture.conn.cancel({ sessionId: b })
			expect((await initialB).stopReason).toBe("cancelled")
			const inspecting = fixture.conn.prompt({
				sessionId: a,
				prompt: [{ type: "text", text: "Inspect only A's cohort" }],
			})
			await waitForSessionUpdate(
				fixture,
				a,
				(update) =>
					update.sessionUpdate === "agent_message_chunk" &&
					update.content.type === "text" &&
					update.content.text.includes("Second draft in A"),
			)
			const requestA = JSON.stringify(
				fixture.fake.requests.filter((request) => request.url.endsWith("/chat/completions")).at(-1)?.body,
			)
			expect(requestA).toContain("Inspection of 1 background bash process")
			expect(requestA).toContain("a.pid")
			expect(requestA).not.toContain("b.pid")
			await fixture.conn.cancel({ sessionId: a })
			expect((await inspecting).stopReason).toBe("cancelled")
			await fixture.conn.unstable_closeSession({ sessionId: a })
			expect(() => process.kill(pids[0], 0)).toThrow()
			process.kill(pids[1], 0)
			const workingB = fixture.conn.prompt({
				sessionId: b,
				prompt: [{ type: "text", text: "Read independently while B exits" }],
			})
			await waitForSessionUpdate(
				fixture,
				b,
				(update) =>
					update.sessionUpdate === "agent_message_chunk" &&
					update.content.type === "text" &&
					update.content.text.includes("Independent work in B"),
			)
			writeFileSync(join(fixture.workDir, "exit-b"), "")
			await waitFor(() => existsSync(join(fixture.workDir, "b-exited")), Boolean)
			expect((await workingB).stopReason).toBe("end_turn")
			const finalB = JSON.stringify(
				fixture.fake.requests.filter((request) => request.url.endsWith("/chat/completions")).at(-1)?.body,
			)
			expect(finalB.split("B-OWNED-EXIT")).toHaveLength(2)
			expect(finalB).not.toContain("a.pid")
			expect(finalB).not.toContain("Task completion requires a disposition")
		} finally {
			await fixture.stop()
			for (const pid of pids) {
				try {
					process.kill(-pid, "SIGKILL")
				} catch {
					/* Already drained. */
				}
			}
		}
	},
	STARTUP_TIMEOUT_MS,
)
