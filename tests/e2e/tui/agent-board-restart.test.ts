import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, viewText, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("a resumed parent recovers the changed contract and latest worker progress", async ({ terminal }) => {
	const call = (id: string, name: string, args: Record<string, unknown>) => ({
		id,
		function: { name, arguments: JSON.stringify(args) },
	})
	await runKimchiSession(
		terminal,
		{
			artifactName: "agent-board-restart",
			extraArgs: ["--session", "saved-board.jsonl"],
			seedHome: (homeDir, workDir) => {
				const settingsPath = join(homeDir, ".config/kimchi/harness/settings.json")
				const settings = JSON.parse(readFileSync(settingsPath, "utf8"))
				settings.resources = { ...settings.resources, "extensions.agent-communication": true }
				writeFileSync(settingsPath, JSON.stringify(settings))
				writeFileSync(join(workDir, "contract.json"), '{"revision":2,"unit":"milliseconds"}\n')
				const journal = SessionManager.create(workDir, workDir)
				journal.appendMessage({
					role: "user",
					content: "Continue the event bridge after the contract changes.",
					timestamp: 1,
				})
				journal.appendMessage({
					role: "assistant",
					content: [{ type: "text", text: "Work paused after the contract investigation." }],
					api: "openai-completions",
					provider: "fake-openai",
					model: "basic",
					stopReason: "stop",
					timestamp: 2,
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				})
				const common = {
					rootSessionId: journal.getSessionId(),
					groupId: "saved-group",
					authorAgentId: "finished-worker",
				}
				for (const entry of [
					{
						...common,
						id: "bd-pending",
						kind: "work",
						title: "Pending investigation",
						body: "superseded-progress",
						postedAt: 3,
						snapshotKey: "worker:todos",
					},
					{
						...common,
						id: "bd-contract",
						kind: "finding",
						title: "Contract changed to milliseconds",
						body: "Decision: revision 2 uses milliseconds. Evidence: contract.json. Check it before changing the consumer.",
						postedAt: 4,
					},
					{
						...common,
						id: "bd-complete",
						kind: "work",
						title: "Investigation complete",
						body: "Evidence: revision 2 inspected; consumer update remains.",
						postedAt: 5,
						snapshotKey: "worker:todos",
					},
				])
					journal.appendCustomEntry("agent-board:entry:v1", entry)
				const sessionFile = journal.getSessionFile()
				if (!sessionFile) throw new Error("Expected a persisted fixture session")
				renameSync(sessionFile, join(workDir, "saved-board.jsonl"))
			},
			responses: [
				{ toolCalls: [call("read-saved-board", "read_agent_board", { group_id: "saved-group" })] },
				{
					match: (request) => {
						const body = JSON.stringify(request.body)
						return (
							body.includes("bd-contract") &&
							body.includes("consumer update remains") &&
							!body.includes("superseded-progress")
						)
					},
					toolCalls: [
						call("check-contract", "bash", {
							command:
								'python3 -c \'import json; c=json.load(open("contract.json")); assert c == {"revision":2,"unit":"milliseconds"}; print("Revised contract verified")\'',
						}),
					],
				},
				{
					match: (request) => JSON.stringify(request.body).includes("Revised contract verified"),
					stream: ["RESUMED: milliseconds contract verified; investigation complete, consumer update remains."],
				},
			],
		},
		async (_fixture, trace) => {
			terminal.submit("Recover the worker finding and progress, then check its evidence")
			await waitForText(terminal, "RESUMED: milliseconds contract verified", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(viewText(terminal)).toContain("consumer update remains")
			trace.step("resumed parent read retained worker evidence and verified the changed contract")
		},
	)
})
