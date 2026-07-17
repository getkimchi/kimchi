// ACP integration: todo state is isolated between concurrent keyed sessions.
//
// The store was previously a single global object, so two sessions running in
// the same process could see (and overwrite) each other's todos. This test
// creates two sessions, writes distinct todo lists in each, mutates one, and
// asserts that the other is unchanged.

import type { ClientCapabilities } from "@agentclientprotocol/sdk"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { ADVERTISED_CAPABILITIES } from "../../../src/modes/acp/capabilities.js"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

const FULL_CAPABILITIES: ClientCapabilities = {
	fs: { readTextFile: false, writeTextFile: false },
	elicitation: { form: {} },
}

const PI_META = { "kimchi.dev": { ...ADVERTISED_CAPABILITIES } } as const

interface TodoLike {
	content: string
	status: string
}

function textResponse(text: string) {
	return { stream: [text] }
}

function todoToolCall(name: "create_todos" | "update_todos", contents: TodoLike[]) {
	return {
		stream: ["Updating todos."],
		toolCalls: [
			{
				function: {
					name,
					arguments: JSON.stringify({
						todos: contents.map((todo, index) => ({
							id: index + 1,
							content: todo.content,
							status: todo.status,
						})),
					}),
				},
			},
		],
	}
}

function todoContentsFromUpdate(update: unknown): TodoLike[] {
	const rawOutput = (update as { rawOutput?: { details?: { todos?: Array<TodoLike & { id?: number }> } } }).rawOutput
	return (rawOutput?.details?.todos ?? []).map(({ content, status }) => ({ content, status }))
}

function todoContents(fixture: AcpFixture, sessionId: string): TodoLike[] {
	const updates = fixture.client.sessionUpdates.filter(
		(u) =>
			u.sessionId === sessionId &&
			u.update.sessionUpdate === "tool_call_update" &&
			Array.isArray((u.update as { content?: unknown[] }).content),
	)
	const latest = updates[updates.length - 1]
	if (!latest) return []
	return todoContentsFromUpdate(latest.update)
}

describe("ACP integration — todo session isolation", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "todo-session-isolation",
			responses: [
				// Session A turn 1: create two todos.
				todoToolCall("create_todos", [
					{ content: "alpha for A", status: "pending" },
					{ content: "beta for A", status: "in_progress" },
				]),
				textResponse("Created todos for session A."),
				// Session B turn 1: create two different todos.
				todoToolCall("create_todos", [
					{ content: "alpha for B", status: "pending" },
					{ content: "beta for B", status: "pending" },
				]),
				textResponse("Created todos for session B."),
				// Session A turn 2: mark alpha completed.
				todoToolCall("update_todos", [
					{ content: "alpha for A", status: "completed" },
					{ content: "beta for A", status: "in_progress" },
				]),
				textResponse("Updated todos for session A."),
			],
			clientCapabilities: FULL_CAPABILITIES,
			clientMeta: PI_META,
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("keeps each session's todos separate across concurrent sessions", async () => {
		const sessionA = await newSession(fixture, fixture.workDir)
		const turnA1 = await prompt(fixture, sessionA, "Create todos for session A")
		expect(turnA1.stopReason).toBe("end_turn")

		const aAfterCreate = todoContents(fixture, sessionA)
		expect(aAfterCreate.map((t) => t.content)).toEqual(["alpha for A", "beta for A"])

		const sessionB = await newSession(fixture, fixture.workDir)
		const turnB1 = await prompt(fixture, sessionB, "Create todos for session B")
		expect(turnB1.stopReason).toBe("end_turn")

		const bAfterCreate = todoContents(fixture, sessionB)
		expect(bAfterCreate.map((t) => t.content)).toEqual(["alpha for B", "beta for B"])

		// Mutate session A and verify session B did not change.
		const turnA2 = await prompt(fixture, sessionA, "Mark alpha completed")
		expect(turnA2.stopReason).toBe("end_turn")

		const aAfterUpdate = todoContents(fixture, sessionA)
		expect(aAfterUpdate).toEqual([
			{ content: "alpha for A", status: "completed" },
			{ content: "beta for A", status: "in_progress" },
		])

		const bAfterAUpdate = todoContents(fixture, sessionB)
		expect(bAfterAUpdate).toEqual([
			{ content: "alpha for B", status: "pending" },
			{ content: "beta for B", status: "pending" },
		])
	})
})
