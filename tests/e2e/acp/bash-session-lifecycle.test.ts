import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, it } from "vitest"
import { STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt, waitFor, waitForSessionUpdate } from "./support/scenarios.js"

for (const otherSession of [false, true]) {
	// Known bug: creating B overwrites the singleton Bash state used by A's
	// shutdown handler, leaving A's real process alive. The control case passes.
	const lifecycleTest = otherSession ? it.fails : it
	lifecycleTest(
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
					expect(fixture.fake.requests.at(-1)?.body).toMatchObject({
						tools: expect.not.arrayContaining([
							expect.objectContaining({ function: expect.objectContaining({ name: "bash_control" }) }),
						]),
					})
					expect(JSON.stringify(fixture.fake.requests.at(-1)?.body)).not.toContain("lifecycle.pid")
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
				expect(fixture.fake.requests.at(-1)?.body).toMatchObject({
					tools: expect.not.arrayContaining([
						expect.objectContaining({ function: expect.objectContaining({ name: "bash_control" }) }),
					]),
				})
				expect(JSON.stringify(fixture.fake.requests.at(-1)?.body)).not.toContain(
					"Task completion requires a disposition",
				)
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
