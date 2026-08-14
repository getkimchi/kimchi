// ACP integration: toolCallId uniqueness and namespacing.
//
// Pi's toolCall.id values are only unique within a compaction segment. The ACP
// surface must rewrite them to session-unique ids that satisfy the ACP contract
// "Unique identifier for a tool call within a session." This test drives a real
// binary end-to-end and asserts the wire shape the client observes.

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

/** True for `[ACP]` UI fallback warnings, which come from a non-streaming code path. */
function isAcpWarning(update: unknown): boolean {
	const u = update as { content?: { type?: string; text?: string } }
	return u.content?.type === "text" && (u.content.text?.startsWith("[ACP]") ?? false)
}

describe("ACP integration — toolCallId uniqueness", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "tool-call-id",
			responses: [
				{
					stream: ["Running echo."],
					toolCalls: [
						{
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: "echo first" }),
							},
						},
					],
				},
			],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("rewrites upstream toolCallIds to kt.<name>.<index>", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		const result = await prompt(fixture, sessionId, "Run echo first")
		expect(result.stopReason, "turn stop reason").toBe("end_turn")

		const toolCalls = fixture.client.sessionUpdates.filter(
			(u) => u.sessionId === sessionId && u.update.sessionUpdate === "tool_call" && !isAcpWarning(u.update),
		)
		const toolCallUpdates = fixture.client.sessionUpdates.filter(
			(u) => u.sessionId === sessionId && u.update.sessionUpdate === "tool_call_update" && !isAcpWarning(u.update),
		)

		expect(toolCalls, "exactly one tool_call notification").toHaveLength(1)
		expect(toolCallUpdates.length, "at least one tool_call_update notification").toBeGreaterThanOrEqual(1)

		const acpId = (toolCalls[0].update as { toolCallId: string }).toolCallId
		expect(toolCalls).toEqual([
			expect.objectContaining({
				sessionId,
				update: expect.objectContaining({
					sessionUpdate: "tool_call",
					toolCallId: expect.stringMatching(/^kt\.bash\.\d+$/),
					_meta: { piToolCallId: "call_fake" },
				}),
			}),
		])
		expect(toolCallUpdates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sessionId,
					update: expect.objectContaining({
						sessionUpdate: "tool_call_update",
						toolCallId: acpId,
						_meta: { piToolCallId: "call_fake" },
					}),
				}),
			]),
		)
	})
})

describe("ACP integration — permission request toolCallId correlation", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "tool-call-id-permission",
			responses: [
				{
					stream: ["Touching file."],
					toolCalls: [
						{
							id: "call_permission",
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: "touch /tmp/kimchi-acp-tool-call-id-marker.txt" }),
							},
						},
					],
				},
			],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("uses the same ACP toolCallId in the permission request and tool_call notification", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)
		const result = await prompt(fixture, sessionId, "Touch a marker file")
		expect(result.stopReason, "turn stop reason").toBe("end_turn")

		const permissionRequests = fixture.client.permissionRequests.filter((r) => r.sessionId === sessionId)
		const toolCalls = fixture.client.sessionUpdates.filter(
			(u) => u.sessionId === sessionId && u.update.sessionUpdate === "tool_call" && !isAcpWarning(u.update),
		)

		expect(permissionRequests, "exactly one permission request").toHaveLength(1)
		expect(toolCalls, "exactly one tool_call notification").toHaveLength(1)

		const permissionToolCallId = (permissionRequests[0].toolCall as { toolCallId?: string }).toolCallId
		const notificationToolCallId = (toolCalls[0].update as { toolCallId?: string }).toolCallId

		expect(permissionToolCallId, "permission request id is rewritten").toMatch(/^kt\.bash\.\d+$/)
		expect(notificationToolCallId, "tool_call id matches permission request id").toBe(permissionToolCallId)
		expect(permissionRequests[0]).toEqual(
			expect.objectContaining({
				sessionId,
				toolCall: expect.objectContaining({
					toolCallId: permissionToolCallId,
					_meta: { piToolCallId: "call_permission" },
				}),
			}),
		)
		expect(toolCalls[0]).toEqual(
			expect.objectContaining({
				sessionId,
				update: expect.objectContaining({
					sessionUpdate: "tool_call",
					toolCallId: permissionToolCallId,
					_meta: { piToolCallId: "call_permission" },
				}),
			}),
		)
	})
})

describe("ACP integration — reused upstream toolCallId disambiguation", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		// Both responses omit an explicit toolCall id, so FakeOpenAiServer reuses
		// its default "call_fake" id for both. This simulates Pi reusing an id
		// after compaction.
		fixture = await startAcpFixture({
			artifactName: "tool-call-id-reuse",
			responses: [
				{
					stream: ["First call."],
					toolCalls: [
						{
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: "echo first" }),
							},
						},
					],
				},
				{
					stream: ["Second call."],
					toolCalls: [
						{
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: "echo second" }),
							},
						},
					],
				},
			],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("allocates distinct ACP ids when the upstream id is reused across turns", async () => {
		const sessionId = await newSession(fixture, fixture.workDir)

		const first = await prompt(fixture, sessionId, "Run echo first")
		expect(first.stopReason, "first turn stop reason").toBe("end_turn")

		const second = await prompt(fixture, sessionId, "Run echo second")
		expect(second.stopReason, "second turn stop reason").toBe("end_turn")

		const toolCalls = fixture.client.sessionUpdates.filter(
			(u) => u.sessionId === sessionId && u.update.sessionUpdate === "tool_call" && !isAcpWarning(u.update),
		)

		expect(toolCalls, "two tool_call notifications").toHaveLength(2)
		expect(toolCalls).toEqual([
			expect.objectContaining({
				sessionId,
				update: expect.objectContaining({
					sessionUpdate: "tool_call",
					toolCallId: expect.stringMatching(/^kt\.bash\.\d+$/),
					_meta: { piToolCallId: "call_fake" },
				}),
			}),
			expect.objectContaining({
				sessionId,
				update: expect.objectContaining({
					sessionUpdate: "tool_call",
					toolCallId: expect.stringMatching(/^kt\.bash\.\d+$/),
					_meta: { piToolCallId: "call_fake" },
				}),
			}),
		])
		const firstId = (toolCalls[0].update as { toolCallId: string }).toolCallId
		const secondId = (toolCalls[1].update as { toolCallId: string }).toolCallId
		expect(firstId).not.toBe(secondId)
	})
})

// Helpers for writing a hand-crafted session JSONL that contains a compaction
// entry. Kimchi's session files live under ~/.config/kimchi/harness/sessions/<cwd-encoded>/.
function encodeCwdDir(cwd: string): string {
	return `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`
}

function writeSessionFile(homeDir: string, sessionId: string, cwd: string, entries: unknown[]): void {
	const sessionDir = join(homeDir, ".config", "kimchi", "harness", "sessions", encodeCwdDir(cwd))
	mkdirSync(sessionDir, { recursive: true })
	const fileName = `2026-05-09T00-00-00.000Z_${sessionId}.jsonl`
	const lines = entries.map((e) => JSON.stringify(e)).join("\n")
	writeFileSync(join(sessionDir, fileName), `${lines}\n`)
}

describe("ACP integration — toolCallId across compaction boundary", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		// No fake LLM responses needed: we load a persisted session and only
		// assert on the replayed notifications.
		fixture = await startAcpFixture({
			artifactName: "tool-call-id-compaction",
			responses: [],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("assigns distinct ACP ids to tool calls whose upstream id is reused across a compaction entry", async () => {
		const sessionId = "compaction-tool-id-reuse"
		const cwd = fixture.workDir

		// Both the pre-compaction and post-compaction assistant messages carry a
		// bash toolCall with the same upstream id "call_fake". This mirrors Pi
		// reusing an id after it compacted the earlier segment away.
		writeSessionFile(fixture.homeDir, sessionId, cwd, [
			{
				type: "session",
				version: 3,
				id: sessionId,
				timestamp: "2026-05-09T00:00:00Z",
				cwd,
			},
			{
				type: "model_change",
				id: "mc1",
				parentId: null,
				timestamp: "2026-05-09T00:00:00Z",
				provider: "openai",
				modelId: "gpt-4",
			},
			{
				type: "message",
				id: "u1",
				parentId: "mc1",
				timestamp: "2026-05-09T00:00:00Z",
				message: { role: "user", content: "pre" },
			},
			{
				type: "message",
				id: "a1",
				parentId: "u1",
				timestamp: "2026-05-09T00:00:01Z",
				message: {
					role: "assistant",
					provider: "openai",
					model: "gpt-4",
					content: [
						{
							type: "toolCall",
							id: "call_fake",
							name: "bash",
							arguments: { command: "echo pre" },
						},
					],
				},
			},
			{
				type: "message",
				id: "tr1",
				parentId: "a1",
				timestamp: "2026-05-09T00:00:02Z",
				message: {
					role: "toolResult",
					toolCallId: "call_fake",
					toolName: "bash",
					content: [{ type: "text", text: "pre" }],
					isError: false,
				},
			},
			{
				type: "compaction",
				id: "c1",
				parentId: "tr1",
				timestamp: "2026-05-09T00:00:03Z",
				summary: "compacted pre segment",
				firstKeptEntryId: "u1",
				tokensBefore: 100,
			},
			{
				type: "message",
				id: "u2",
				parentId: "c1",
				timestamp: "2026-05-09T00:00:04Z",
				message: { role: "user", content: "post" },
			},
			{
				type: "message",
				id: "a2",
				parentId: "u2",
				timestamp: "2026-05-09T00:00:05Z",
				message: {
					role: "assistant",
					provider: "openai",
					model: "gpt-4",
					content: [
						{
							type: "toolCall",
							id: "call_fake",
							name: "bash",
							arguments: { command: "echo post" },
						},
					],
				},
			},
			{
				type: "message",
				id: "tr2",
				parentId: "a2",
				timestamp: "2026-05-09T00:00:06Z",
				message: {
					role: "toolResult",
					toolCallId: "call_fake",
					toolName: "bash",
					content: [{ type: "text", text: "post" }],
					isError: false,
				},
			},
		])

		await fixture.conn.loadSession({ sessionId, cwd, mcpServers: [] })

		const toolCalls = fixture.client.sessionUpdates.filter(
			(u) => u.sessionId === sessionId && u.update.sessionUpdate === "tool_call" && !isAcpWarning(u.update),
		)

		expect(toolCalls, "two tool_call notifications replayed").toHaveLength(2)
		expect(toolCalls).toEqual([
			expect.objectContaining({
				sessionId,
				update: expect.objectContaining({
					sessionUpdate: "tool_call",
					toolCallId: expect.stringMatching(/^kt\.bash\.\d+$/),
					_meta: { piToolCallId: "call_fake" },
				}),
			}),
			expect.objectContaining({
				sessionId,
				update: expect.objectContaining({
					sessionUpdate: "tool_call",
					toolCallId: expect.stringMatching(/^kt\.bash\.\d+$/),
					_meta: { piToolCallId: "call_fake" },
				}),
			}),
		])
		const firstId = (toolCalls[0].update as { toolCallId: string }).toolCallId
		const secondId = (toolCalls[1].update as { toolCallId: string }).toolCallId
		expect(firstId).not.toBe(secondId)
	})
})
