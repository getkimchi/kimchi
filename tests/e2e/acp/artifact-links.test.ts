// ACP integration: generated-artifact links.
//
// When a turn produces an allowlisted, user-openable file (write/edit path or
// path mentioned in bash output), the turn's flush emits a `resource_link`
// chunk carrying `_meta["kimchi.dev"].type = "artifact"` so clients can render
// an "Open <name>" action. This test drives the real binary end-to-end and
// asserts the wire shape the client observes.

import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

type ArtifactChunk = {
	messageId?: string
	content: { type: string; uri?: string; name?: string; mimeType?: string }
	meta: Record<string, unknown>
}

function artifactChunks(fixture: AcpFixture, sessionId: string): ArtifactChunk[] {
	return fixture.client.sessionUpdates.flatMap((u) => {
		if (u.sessionId !== sessionId || u.update.sessionUpdate !== "agent_message_chunk") return []
		const update = u.update as {
			messageId?: string
			content?: { type?: string; uri?: string; name?: string; mimeType?: string }
			_meta?: { "kimchi.dev"?: Record<string, unknown> }
		}
		const meta = update._meta?.["kimchi.dev"]
		if (meta?.type !== "artifact" || update.content?.type !== "resource_link") return []
		return [
			{
				messageId: update.messageId,
				content: update.content as ArtifactChunk["content"],
				meta,
			},
		]
	})
}

describe("ACP integration — generated artifact links", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "artifact-links",
			extraArgs: ["--yolo"],
			responses: [
				{
					stream: ["Creating the report."],
					toolCalls: [
						{
							function: {
								name: "write",
								arguments: JSON.stringify({ path: "report.md", content: "# Report\n" }),
							},
						},
					],
				},
				{ stream: ["The report is ready."] },
			],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("emits a resource_link chunk with artifact meta for a written file", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		const result = await prompt(fixture, sessionId, "Write report.md")
		expect(result.stopReason, "turn stop reason").toBe("end_turn")

		const chunks = artifactChunks(fixture, sessionId)
		expect(chunks, "exactly one artifact chunk").toHaveLength(1)
		expect(chunks[0].content).toMatchObject({
			type: "resource_link",
			name: "report.md",
			uri: pathToFileURL(join(fixture.workDir, "report.md")).href,
			mimeType: "text/markdown",
		})
		// Attached to the replicated text block id, not a fresh message id.
		const textIds = fixture.client.sessionUpdates
			.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "agent_message_chunk")
			.map((u) => (u.update as { messageId?: string }).messageId)
		expect(textIds).toContain(chunks[0].messageId)
	})
})
