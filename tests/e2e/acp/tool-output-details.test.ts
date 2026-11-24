import { fileURLToPath } from "node:url"
import type * as acp from "@agentclientprotocol/sdk"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

const MANUAL_DETAILS_TOOL_EXTENSION = fileURLToPath(
	new URL("./support/test-manual-details-tool-extension.js", import.meta.url),
)
type ToolCallUpdate = Extract<acp.SessionUpdate, { sessionUpdate: "tool_call_update" }>

function unrelatedToolOutput(fixture: AcpFixture, startIndex = 0): ToolCallUpdate["rawOutput"] {
	const match = fixture.client.sessionUpdates
		.slice(startIndex)
		.find(
			({ update }) =>
				update.sessionUpdate === "tool_call_update" &&
				JSON.stringify(update.rawOutput ?? {}).includes("unrelated-manual-result"),
		)
	if (match?.update.sessionUpdate !== "tool_call_update") {
		throw new Error(`missing unrelated non-MCP tool output: ${JSON.stringify(fixture.client.sessionUpdates)}`)
	}
	return match.update.rawOutput
}

describe("ACP integration — unrelated tool result details", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "tool-output-unrelated-manual-details",
			// A default client does not opt into MCP OAuth turn coordination.
			extensionPath: MANUAL_DETAILS_TOOL_EXTENSION,
			responses: [
				{
					stream: ["Running an unrelated tool."],
					toolCalls: [{ function: { name: "test_manual_details", arguments: "{}" } }],
				},
			],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("preserves a non-MCP manual handoff live and on replay", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		expect((await prompt(fixture, sessionId, "Run the unrelated manual-details tool")).stopReason).toBe("end_turn")
		const liveDetails = unrelatedToolOutput(fixture)?.details

		const replayStart = fixture.client.sessionUpdates.length
		await fixture.conn.request("session/load", { sessionId, cwd: fixture.workDir, mcpServers: [] })
		const replayDetails = unrelatedToolOutput(fixture, replayStart)?.details

		const expectedDetails = { handoff: "manual", preserved: "yes" }
		expect({ live: liveDetails, replay: replayDetails }).toEqual({
			live: expectedDetails,
			replay: expectedDetails,
		})
	})
})
