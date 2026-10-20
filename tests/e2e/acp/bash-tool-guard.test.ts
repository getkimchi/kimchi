// ACP e2e — bash-tool-guard steer behavior on the protocol surface.
//
// The guard extension is registered once in cli.ts and shared by the TUI
// and ACP surfaces; these tests pin the same contract on ACP: file reads
// via bash no longer steer (read/edit/write are classification-only), and
// backgrounding steers with the rewritten background text. Steers are sent
// display:false, so the assertions target the fake backend's continuation
// request body — the request carrying the tool result — not terminal text.

import { expect, it } from "vitest"
import { STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt, waitForSessionUpdate } from "./support/scenarios.js"

function requestContainsToolResult(body: unknown, toolCallId: string): boolean {
	if (!body || typeof body !== "object") return false
	const messages = (body as Record<string, unknown>).messages
	if (!Array.isArray(messages)) return false
	return messages.some(
		(message) =>
			Boolean(message && typeof message === "object") &&
			(message as Record<string, unknown>).role === "tool" &&
			(message as Record<string, unknown>).tool_call_id === toolCallId,
	)
}

function continuationWithToolResult(
	requests: Array<{ url: string; body: unknown }>,
	toolCallId: string,
): { url: string; body: unknown } | undefined {
	return requests
		.filter((request) => request.url.endsWith("/chat/completions"))
		.find((request) => requestContainsToolResult(request.body, toolCallId))
}

it(
	"file reads via bash produce no guard steer (ACP)",
	async () => {
		const fixture = await startAcpFixture({
			artifactName: "bash-tool-guard-file-read-no-steer",
			responses: [
				{
					toolCalls: [
						{
							id: "call_read",
							function: { name: "bash", arguments: JSON.stringify({ command: "cat /etc/os-release" }) },
						},
					],
				},
				{ stream: ["Checks complete."] },
			],
		})
		try {
			const sessionId = await newSession(fixture, fixture.workDir)
			const result = await prompt(fixture, sessionId, "Check the OS release file")
			expect(result.stopReason, "turn stop reason").toBe("end_turn")
			await waitForSessionUpdate(
				fixture,
				sessionId,
				(update) =>
					update.sessionUpdate === "agent_message_chunk" &&
					update.content.type === "text" &&
					update.content.text.includes("Checks complete."),
			)

			const continuation = continuationWithToolResult(fixture.fake.requests, "call_read")
			expect(continuation).toBeDefined()
			expect(JSON.stringify(continuation?.body)).not.toContain("Bash-tool guard")
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS,
)

it(
	"backgrounding produces the background guard steer (ACP)",
	async () => {
		const fixture = await startAcpFixture({
			artifactName: "bash-tool-guard-background-steer",
			responses: [
				{
					toolCalls: [
						{
							id: "call_bg",
							function: { name: "bash", arguments: JSON.stringify({ command: "sleep 60 &" }) },
						},
					],
				},
				{ stream: ["Backgrounding handled."] },
			],
		})
		try {
			const sessionId = await newSession(fixture, fixture.workDir)
			const result = await prompt(fixture, sessionId, "Kick off the long-running workload")
			expect(result.stopReason, "turn stop reason").toBe("end_turn")
			await waitForSessionUpdate(
				fixture,
				sessionId,
				(update) =>
					update.sessionUpdate === "agent_message_chunk" &&
					update.content.type === "text" &&
					update.content.text.includes("Backgrounding handled."),
			)

			const continuation = continuationWithToolResult(fixture.fake.requests, "call_bg")
			expect(continuation).toBeDefined()
			const body = JSON.stringify(continuation?.body)
			expect(body).toContain("detaches the process from the bash tool's lifecycle")
			expect(body).toContain("bash_control stop_handles")
		} finally {
			await fixture.stop()
		}
	},
	STARTUP_TIMEOUT_MS,
)
