import { execFileSync } from "node:child_process"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "vitest"
import type { FakeResponseScript } from "../tui/support/fake-openai-server.js"
import { startAcpFixture } from "./support/acp-fixture.js"
import { prompt } from "./support/scenarios.js"

test("saves and restores a named candidate over ACP", async () => {
	const restore: FakeResponseScript = {
		toolCalls: [{ id: "checkpoint-restore", function: { name: "workspace_checkpoint", arguments: "{}" } }],
	}
	const fixture = await startAcpFixture({
		artifactName: "acp-workspace-checkpoints",
		extraArgs: ["--max-session-duration", "300"],
		seedHome: (_home, workDir) => {
			execFileSync("git", ["init", "-q"], { cwd: workDir })
		},
		responses: [
			{
				toolCalls: [
					{
						id: "checkpoint-save",
						function: {
							name: "workspace_checkpoint",
							arguments: '{"action":"save","label":"tested candidate","validated":true}',
						},
					},
				],
			},
			{ stream: ["Saved the candidate."] },
			{
				toolCalls: [
					{ id: "checkpoint-list", function: { name: "workspace_checkpoint", arguments: '{"action":"list"}' } },
				],
			},
			restore,
			{ stream: ["Saved candidate restored."] },
		],
	})
	try {
		const session = await fixture.conn.request("session/new", {
			cwd: fixture.workDir,
			mcpServers: [],
		})
		const candidate = join(fixture.workDir, "candidate.txt")
		const unrelated = join(fixture.workDir, "unrelated.txt")
		writeFileSync(candidate, "candidate\n")
		expect((await prompt(fixture, session.sessionId, "Save the current candidate")).stopReason).toBe("end_turn")
		const serializedRequests = JSON.stringify(fixture.fake.requests.map((request) => request.body))
		const match = serializedRequests.match(/Checkpoint: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/)
		if (!match?.[1]) throw new Error("No saved checkpoint ID reached the provider")
		const restoreCall = restore.toolCalls?.[0]
		if (!restoreCall) throw new Error("Missing restore call in test script")
		restoreCall.function.arguments = JSON.stringify({ action: "restore", id: match[1] })
		writeFileSync(candidate, "changed after the candidate\n")
		writeFileSync(unrelated, "keep me\n")

		const result = await prompt(fixture, session.sessionId, "List checkpoints and restore the chosen candidate")
		expect(result.stopReason).toBe("end_turn")
		expect(result.chunks).toContain("Saved candidate restored.")
		expect(readFileSync(candidate, "utf8")).toBe("candidate\n")
		expect(readFileSync(unrelated, "utf8")).toBe("keep me\n")
	} finally {
		await fixture.stop()
	}
}, 60_000)
