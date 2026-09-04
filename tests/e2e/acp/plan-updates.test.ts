// ACP integration: todo writes surface as stable-v1 `plan` session updates.
//
// IDEs (Zed natively) render `sessionUpdate: "plan"` as a live checklist.
// This test drives create_todos / update_todos / clear_todos tool calls via a
// scripted model and asserts the plan snapshots the client receives: full-
// replacement semantics, the mapped entry lifecycle (incl. activeForm content
// and the [blocked] marker), scope metadata under Plan._meta, empty entries
// on clear, and per-session isolation of the notification stream.

import type { ClientCapabilities } from "@agentclientprotocol/sdk"
import { afterEach, describe, expect, it } from "vitest"
import { ADVERTISED_CAPABILITIES } from "../../../src/modes/acp/capabilities.js"
import { type AcpFixture, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

const FULL_CAPABILITIES: ClientCapabilities = {
	fs: { readTextFile: false, writeTextFile: false },
	elicitation: { form: {} },
}

const PI_META = { "kimchi.dev": { ...ADVERTISED_CAPABILITIES } } as const

function textResponse(text: string) {
	return { stream: [text] }
}

function todoToolCall(name: string, args: Record<string, unknown>) {
	return {
		stream: ["Working todos."],
		toolCalls: [{ function: { name, arguments: JSON.stringify(args) } }],
	}
}

interface PlanEntryLike {
	content: string
	status: string
}

function planSnapshots(fixture: AcpFixture, sessionId: string): Array<{ entries: PlanEntryLike[]; _meta?: unknown }> {
	return fixture.client.sessionUpdates
		.filter((u) => u.sessionId === sessionId && u.update.sessionUpdate === "plan")
		.map((u) => u.update as { entries: PlanEntryLike[]; _meta?: unknown })
}

describe("ACP integration — plan updates from todo writes", () => {
	let fixture: AcpFixture

	async function startWith(responses: Array<Record<string, unknown>>, extraArgs: string[] = []): Promise<void> {
		fixture = await startAcpFixture({
			artifactName: "plan-updates",
			responses,
			clientCapabilities: FULL_CAPABILITIES,
			clientMeta: PI_META,
			extraArgs,
		})
	}

	afterEach(async () => {
		await fixture.stop()
	})

	it("emits replacement plan snapshots across create, update, and clear", async () => {
		await startWith([
			// Turn 1: create two todos, one in progress with an activeForm.
			todoToolCall("create_todos", {
				todos: [
					{ id: 1, content: "wire emission", status: "in_progress", activeForm: "wiring emission" },
					{ id: 2, content: "deploy", status: "blocked", note: "waiting on ops" },
				],
			}),
			textResponse("Todos created."),
			// Turn 2: complete the first, unblock the second into in_progress.
			todoToolCall("update_todos", {
				todos: [
					{ id: 1, content: "wire emission", status: "completed" },
					{ id: 2, content: "deploy", status: "in_progress", activeForm: "deploying" },
				],
			}),
			textResponse("Todos updated."),
			// Turn 3: clear the list entirely.
			todoToolCall("clear_todos", {}),
			textResponse("Todos cleared."),
		])
		const sessionId = await newSession(fixture, fixture.workDir)

		expect((await prompt(fixture, sessionId, "Create the todo list")).stopReason).toBe("end_turn")

		const afterCreate = planSnapshots(fixture, sessionId)
		expect(afterCreate).toHaveLength(1)
		expect(afterCreate[0].entries).toEqual([
			{ content: "wiring emission", priority: "medium", status: "in_progress" },
			{ content: "[blocked] deploy — waiting on ops", priority: "medium", status: "pending" },
		])
		// Scope metadata rides Plan._meta; spec-compliant clients ignore it.
		expect(afterCreate[0]._meta).toEqual({ "kimchi.dev": { scope: { kind: "global" } } })

		expect((await prompt(fixture, sessionId, "Advance the todo list")).stopReason).toBe("end_turn")

		const afterUpdate = planSnapshots(fixture, sessionId)
		expect(afterUpdate).toHaveLength(2)
		// Full replacement, not a patch: the client swaps the whole list.
		expect(afterUpdate[1].entries).toEqual([
			{ content: "wire emission", priority: "medium", status: "completed" },
			{ content: "deploying", priority: "medium", status: "in_progress" },
		])

		expect((await prompt(fixture, sessionId, "Clear the todo list")).stopReason).toBe("end_turn")

		const afterClear = planSnapshots(fixture, sessionId)
		expect(afterClear).toHaveLength(3)
		expect(afterClear[2].entries).toEqual([])
	})

	it("scopes plan notifications to the owning session", async () => {
		await startWith([
			todoToolCall("create_todos", {
				todos: [{ id: 1, content: "session B task", status: "pending" }],
			}),
			textResponse("Session B todos created."),
		])
		const sessionA = await newSession(fixture, fixture.workDir)
		const sessionB = await newSession(fixture, fixture.workDir)

		expect((await prompt(fixture, sessionB, "Create todos for session B")).stopReason).toBe("end_turn")

		const plansB = planSnapshots(fixture, sessionB)
		expect(plansB).toHaveLength(1)
		expect(plansB[0].entries).toEqual([{ content: "session B task", priority: "medium", status: "pending" }])
		expect(planSnapshots(fixture, sessionA)).toHaveLength(0)
	})

	it("emits regular Todo updates while the session is in plan mode", async () => {
		await startWith(
			[
				todoToolCall("create_todos", {
					todos: [{ id: 1, content: "research the change", status: "in_progress" }],
				}),
				textResponse("Planning todos created."),
			],
			["--plan"],
		)
		const sessionId = await newSession(fixture, fixture.workDir)

		expect((await prompt(fixture, sessionId, "Track the planning work")).stopReason).toBe("end_turn")

		expect(planSnapshots(fixture, sessionId)).toEqual([
			{
				sessionUpdate: "plan",
				entries: [{ content: "research the change", priority: "medium", status: "in_progress" }],
				_meta: { "kimchi.dev": { scope: { kind: "global" } } },
			},
		])
	})
})
