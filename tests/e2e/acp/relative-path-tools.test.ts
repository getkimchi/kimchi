// ACP integration: relative tool paths resolve against the session cwd.
//
// The ACP server is a long-lived process whose own working directory is
// unrelated to any session. Tool arguments with relative paths must therefore
// resolve against `ExtensionContext.cwd` (from session/new), not process.cwd().
// Before the fix, a `read` of "marker.txt" resolved against the harness
// process cwd and failed with ENOENT even though the file exists in the
// session's project root.

import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

describe("ACP integration — relative tool paths resolve against session cwd", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "relative-path-tools",
			responses: [
				{
					stream: ["Reading the marker."],
					toolCalls: [
						{
							function: {
								name: "read",
								arguments: JSON.stringify({ path: "marker.txt" }),
							},
						},
					],
				},
			],
		})
		writeFileSync(join(fixture.workDir, "marker.txt"), "marker-content")
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("reads a relative file in the session workdir instead of failing with ENOENT", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		const result = await prompt(fixture, sessionId, "Read marker.txt")
		expect(result.stopReason, "turn stop reason").toBe("end_turn")

		const updates = fixture.client.sessionUpdates.filter(
			(u) => u.sessionId === sessionId && u.update.sessionUpdate === "tool_call_update",
		)
		expect(updates.length, "at least one tool_call_update for the read").toBeGreaterThanOrEqual(1)

		const serialized = JSON.stringify(updates)
		expect(serialized, "tool result contains the file contents").toContain("marker-content")
		expect(serialized, "tool result is not an ENOENT failure").not.toContain("ENOENT")
	})
})
