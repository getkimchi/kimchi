import { expect, it } from "vitest"
import { STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

it(
	"preserves Bash identity and final output when a command fails",
	async () => {
		const command = "printf 'last output\\n'; exit 7"
		const fixture = await startAcpFixture({
			artifactName: "bash-display-error",
			responses: [
				{
					toolCalls: [
						{ function: { name: "bash", arguments: JSON.stringify({ command, description: "Check failure output" }) } },
					],
				},
				{ stream: ["The command failed with exit 7."] },
			],
		})
		try {
			const sessionId = await newSession(fixture, fixture.workDir)
			expect((await prompt(fixture, sessionId, "Run the failure check")).stopReason).toBe("end_turn")
			const updates = fixture.client.sessionUpdates.map(({ update }) => update)
			expect(updates).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						sessionUpdate: "tool_call",
						kind: "execute",
						rawInput: expect.objectContaining({ command, description: "Check failure output" }),
					}),
					expect.objectContaining({
						sessionUpdate: "tool_call_update",
						status: "failed",
						rawOutput: expect.objectContaining({
							details: expect.objectContaining({
								exited: true,
								exitCode: 7,
								display: expect.objectContaining({
									command,
									description: "Check failure output",
									output: "last output\n",
									state: "exited",
									exitCode: 7,
								}),
							}),
						}),
					}),
				]),
			)
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS,
)
