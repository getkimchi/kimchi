// ACP integration — parent-owned recovery of local native child sessions.

import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ClientCapabilities } from "@agentclientprotocol/sdk/unstable"
import { afterEach, describe, expect, it } from "vitest"
import type { FakeResponseRequest } from "../tui/support/fake-openai-server.js"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt, waitFor } from "./support/scenarios.js"

const CHILD_TASK = "Read child-source.txt and return the persisted child marker."
const CHILD_SOURCE = "persisted-child-source"
const CHILD_RESULT = "persisted-child-result"
const PARENT_REQUEST = "Delegate the durable child investigation."

function requestBody(request: FakeResponseRequest): string {
	return JSON.stringify(request.body ?? {})
}

async function createChild(parent: AcpFixture, _capabilities: ClientCapabilities | undefined) {
	const parentId = await newSession(parent, parent.workDir)
	const result = await prompt(parent, parentId, PARENT_REQUEST)
	expect(result.stopReason).toBe("end_turn")
	const announcement = parent.client.sessionUpdates.find(({ update }) => update.sessionUpdate === "subagent_update")
	if (announcement?.update.sessionUpdate !== "subagent_update") throw new Error("Missing child announcement")
	const childId = announcement.update.sessionId
	const task = parent.client.sessionUpdates.find(
		({ sessionId, update }) => sessionId === childId && update.sessionUpdate === "session_message",
	)
	if (task?.update.sessionUpdate !== "session_message") throw new Error("Missing initial child task")
	const toolCall = parent.client.sessionUpdates.find(
		({ sessionId, update }) => sessionId === childId && update.sessionUpdate === "tool_call",
	)
	if (toolCall?.update.sessionUpdate !== "tool_call") throw new Error("Missing child tool call")
	return {
		parentId,
		childId,
		taskMessageId: task.update.messageId,
		toolCallId: toolCall.update.toolCallId,
		originalTool: toolCall.update,
	}
}

function appendOfflineModelChange(fixture: AcpFixture, childId: string, provider: string): void {
	const sessionsDir = join(fixture.homeDir, ".config/kimchi/harness/sessions")
	const file = readdirSync(sessionsDir, { recursive: true })
		.map((entry) => join(sessionsDir, entry.toString()))
		.find((candidate) => {
			if (!candidate.endsWith(".jsonl")) return false
			const header = JSON.parse(readFileSync(candidate, "utf-8").split("\n", 1)[0] ?? "{}") as { id?: string }
			return header.id === childId
		})
	if (!file) throw new Error(`Missing durable transcript for ${childId}`)
	expect(readFileSync(file, "utf-8"), "live ACP tool IDs are persisted in the child JSONL").toContain(
		'"customType":"kimchi:subagent-tool-id"',
	)
	const entries = readFileSync(file, "utf-8")
		.trimEnd()
		.split("\n")
		.map((line) => JSON.parse(line) as { id?: string })
	const parentId = entries.at(-1)?.id
	if (!parentId) throw new Error("Durable child transcript has no leaf entry")
	appendFileSync(
		file,
		`\n${JSON.stringify({
			type: "model_change",
			id: "offline-child-model-change",
			parentId,
			timestamp: new Date().toISOString(),
			provider,
			modelId: "offline-model",
		})}\n`,
	)
}

function childConfig(fixture: AcpFixture, childId: string) {
	return fixture.client.sessionUpdates
		.filter(({ sessionId, update }) => sessionId === childId && update.sessionUpdate === "config_option_update")
		.at(-1)
}

function childState(fixture: AcpFixture, childId: string) {
	return fixture.client.sessionUpdates
		.filter(({ update }) => update.sessionUpdate === "subagent_update" && update.sessionId === childId)
		.at(-1)
}

describe("ACP integration — parent-driven subagent replay", () => {
	const temporaryDirectories: string[] = []
	afterEach(async () => {
		for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
	})

	it(
		"restores the native child transcript and configuration after a process restart",
		async () => {
			const first = await startAcpFixture({
				artifactName: "subagent-replay-first",
				clientCapabilities: { subagents: {} },
				keepDirsOnStop: true,
				models: [
					{ slug: "basic", displayName: "Parent model" },
					{ slug: "offline-model", displayName: "Recovered child model", reasoning: true },
				],
				defaultModel: "basic",
				responses: [
					{
						match: (request) => requestBody(request).includes(PARENT_REQUEST),
						toolCalls: [
							{
								id: "durable-parent-spawn",
								function: {
									name: "Agent",
									arguments: JSON.stringify({
										prompt: CHILD_TASK,
										description: "Durable child",
										subagent_type: "general-purpose",
									}),
								},
							},
						],
					},
					{
						forSubagent: true,
						match: (request) => requestBody(request).includes(CHILD_TASK),
						toolCalls: [
							{
								id: "durable-child-read",
								function: { name: "read", arguments: JSON.stringify({ path: "child-source.txt" }) },
							},
						],
					},
					{ forSubagent: true, stream: [CHILD_RESULT] },
					{ stream: ["Parent accepted the child result."] },
				],
			})
			temporaryDirectories.push(first.homeDir, first.workDir)
			writeFileSync(join(first.workDir, "child-source.txt"), CHILD_SOURCE, "utf-8")
			const original = await createChild(first, { subagents: {} })
			const originalChildState = childState(first, original.childId)
			expect(originalChildState?.update).toMatchObject({ state: { state: "idle", stopReason: "end_turn" } })
			const initialConfig = childConfig(first, original.childId)
			if (initialConfig?.update.sessionUpdate !== "config_option_update") throw new Error("Missing live child config")
			const initialModel = initialConfig.update.configOptions.find((option) => option.id === "model")?.currentValue
			if (typeof initialModel !== "string") throw new Error("Missing live child model")
			const provider = initialModel.split("/", 1)[0]
			if (!provider) throw new Error("Missing live child provider")
			appendOfflineModelChange(first, original.childId, provider)
			await first.stop()

			const second = await startAcpFixture({
				artifactName: "subagent-replay-recovered",
				clientCapabilities: { subagents: {} },
				models: [
					{ slug: "basic", displayName: "Parent model" },
					{ slug: "offline-model", displayName: "Recovered child model", reasoning: true },
				],
				defaultModel: "basic",
				homeDirOverride: first.homeDir,
				workDirOverride: first.workDir,
				responses: [],
			})
			try {
				await second.conn.request("session/load", {
					sessionId: original.parentId,
					cwd: second.workDir,
					mcpServers: [],
				})
				const config = await waitFor(
					() => childConfig(second, original.childId),
					(value) => value !== undefined,
					45_000,
				)
				if (config?.update.sessionUpdate !== "config_option_update") throw new Error("Missing child configuration")
				const model = config.update.configOptions.find((option) => option.id === "model")
				expect(model?.currentValue).toBe(`${provider}/offline-model`)
				expect(childState(second, original.childId)?.update).toMatchObject({
					state: { state: "idle", stopReason: "end_turn" },
					capabilities: {},
				})
				const replayedTask = second.client.sessionUpdates.find(
					({ sessionId, update }) => sessionId === original.childId && update.sessionUpdate === "session_message",
				)
				if (replayedTask?.update.sessionUpdate !== "session_message") throw new Error("Missing replayed task")
				expect(replayedTask.update.messageId).toBe(original.taskMessageId)
				expect(replayedTask.update.senderSessionId).toBe(original.parentId)
				expect(replayedTask.update.recipientSessionId).toBe(original.childId)
				const text = second.client.sessionUpdates.filter(
					({ sessionId, update }) => sessionId === original.childId && update.sessionUpdate === "agent_message_chunk",
				)
				expect(
					text
						.map(({ update }) =>
							update.sessionUpdate === "agent_message_chunk" && update.content.type === "text"
								? update.content.text
								: "",
						)
						.join(""),
				).toContain(CHILD_RESULT)
				const replayedTool = second.client.sessionUpdates.find(
					({ sessionId, update }) => sessionId === original.childId && update.sessionUpdate === "tool_call",
				)
				if (replayedTool?.update.sessionUpdate !== "tool_call") throw new Error("Missing replayed tool")
				expect(
					replayedTool.update.toolCallId,
					JSON.stringify({ live: original.originalTool, replayed: replayedTool.update }),
				).toBe(original.toolCallId)
				await expect(
					second.conn.request("session/load", {
						sessionId: original.childId,
						cwd: second.workDir,
						mcpServers: [],
					}),
				).rejects.toMatchObject({ code: -32602 })
			} finally {
				await second.stop()
			}
		},
		STARTUP_TIMEOUT_MS * 3,
	)

	it(
		"does not reconstruct or expose child history for a legacy client",
		async () => {
			const workDir = mkdtempSync(join(tmpdir(), "kimchi-acp-subagent-legacy-replay-"))
			temporaryDirectories.push(workDir)
			writeFileSync(join(workDir, "child-source.txt"), CHILD_SOURCE, "utf-8")
			const first = await startAcpFixture({
				artifactName: "subagent-replay-legacy-source",
				clientCapabilities: { subagents: {} },
				keepDirsOnStop: true,
				workDirOverride: workDir,
				responses: [
					{
						match: (request) => requestBody(request).includes(PARENT_REQUEST),
						toolCalls: [
							{
								id: "legacy-parent-spawn",
								function: {
									name: "Agent",
									arguments: JSON.stringify({
										prompt: CHILD_TASK,
										description: "Legacy child",
										subagent_type: "general-purpose",
									}),
								},
							},
						],
					},
					{
						forSubagent: true,
						match: (request) => requestBody(request).includes(CHILD_TASK),
						toolCalls: [
							{
								id: "legacy-child-read",
								function: { name: "read", arguments: JSON.stringify({ path: "child-source.txt" }) },
							},
						],
					},
					{ forSubagent: true, stream: [CHILD_RESULT] },
					{ stream: ["Done."] },
				],
			})
			temporaryDirectories.push(first.homeDir)
			const original = await createChild(first, { subagents: {} })
			await first.stop()

			const second = await startAcpFixture({
				artifactName: "subagent-replay-legacy-client",
				clientCapabilities: {},
				homeDirOverride: first.homeDir,
				workDirOverride: first.workDir,
				responses: [],
			})
			try {
				await second.conn.request("session/load", {
					sessionId: original.parentId,
					cwd: second.workDir,
					mcpServers: [],
				})
				await new Promise((resolve) => setTimeout(resolve, 200))
				for (const { sessionId, update } of second.client.sessionUpdates) {
					expect(sessionId).toBe(original.parentId)
					expect(update.sessionUpdate).not.toBe("subagent_update")
					expect(update.sessionUpdate).not.toBe("session_message")
					expect(update.sessionUpdate).not.toBe("session_message_chunk")
				}
				expect(childConfig(second, original.childId)).toBeUndefined()
			} finally {
				await second.stop()
			}
		},
		STARTUP_TIMEOUT_MS * 3,
	)
})
