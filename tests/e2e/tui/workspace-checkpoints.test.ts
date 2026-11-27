import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import type { FakeResponseScript } from "./support/fake-openai-server.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("saves and restores a named candidate through the workspace checkpoint tool", async ({ terminal }) => {
	const restore: FakeResponseScript = {
		toolCalls: [{ id: "checkpoint-restore", function: { name: "workspace_checkpoint", arguments: "{}" } }],
	}
	await runKimchiSession(
		terminal,
		{
			artifactName: "workspace-checkpoints",
			gitInit: true,
			extraArgs: ["--max-session-duration", "300"],
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
		},
		async (fixture, trace) => {
			const candidate = join(fixture.workDir, "candidate.txt")
			const unrelated = join(fixture.workDir, "unrelated.txt")
			writeFileSync(candidate, "candidate\n")
			terminal.submit("Save the current candidate")
			await waitForText(terminal, "Saved the candidate.", { timeoutMs: STREAM_TIMEOUT_MS })
			const serializedRequests = JSON.stringify(fixture.fake.requests.map((request) => request.body))
			const match = serializedRequests.match(
				/Checkpoint: ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/,
			)
			if (!match?.[1]) throw new Error("No saved checkpoint ID reached the provider")
			const restoreCall = restore.toolCalls?.[0]
			if (!restoreCall) throw new Error("Missing restore call in test script")
			restoreCall.function.arguments = JSON.stringify({ action: "restore", id: match[1] })
			writeFileSync(candidate, "changed after the candidate\n")
			writeFileSync(unrelated, "keep me\n")
			trace.step("saved checkpoint ID returned and workspace changed")

			terminal.submit("List checkpoints and restore the chosen candidate")
			await waitForText(terminal, "Workspace Checkpoint", { timeoutMs: STREAM_TIMEOUT_MS })
			await waitForText(terminal, "Saved candidate restored.", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(readFileSync(candidate, "utf8")).toBe("candidate\n")
			expect(readFileSync(unrelated, "utf8")).toBe("keep me\n")
			trace.step("explicit candidate restored and unrelated work preserved")
		},
	)
})
