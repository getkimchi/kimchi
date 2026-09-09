import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { markHarnessSteer } from "../steer-marker.js"
import { registerTodoStatePersistence, TODO_STATE_CUSTOM_TYPE } from "./context-state.js"
import { __resetTodoStore, applyWriteTodos, restoreTodoStoreFromDetails } from "./store.js"

type ExtensionHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>

const SESSION_ID = "context-state-test"

interface MessageLike {
	role?: string
	customType?: string
	content?: unknown
}

function createHarness(branch: MessageLike[] = []) {
	const handlers = new Map<string, ExtensionHandler[]>()
	const pi = {
		sendMessage: vi.fn(),
		on: vi.fn((event: string, handler: ExtensionHandler) => {
			const list = handlers.get(event) ?? []
			list.push(handler)
			handlers.set(event, list)
		}),
	} as unknown as ExtensionAPI

	registerTodoStatePersistence(pi)

	const ctx = {
		sessionManager: {
			getSessionId: () => SESSION_ID,
			getBranch: () => branch,
		},
	} as unknown as ExtensionContext

	async function fire(event: string, payload: unknown): Promise<unknown> {
		let result: unknown
		for (const handler of handlers.get(event) ?? []) {
			result = await handler(payload, ctx)
		}
		return result
	}

	type SentMessage = MessageLike & { display?: boolean; details?: { reason?: string } }

	function stateSyncCalls(): Array<{ message: SentMessage; options?: unknown }> {
		return vi
			.mocked(pi.sendMessage)
			.mock.calls.map(
				([message, options]) =>
					({ message: message as unknown as SentMessage, options }) as {
						message: SentMessage
						options?: unknown
					},
			)
			.filter(
				({ message }) => message.customType === TODO_STATE_CUSTOM_TYPE && message.details?.reason === "state_sync",
			)
	}

	return { pi, ctx, fire, stateSyncCalls }
}

describe("registerTodoStatePersistence", () => {
	beforeEach(() => {
		__resetTodoStore()
	})

	it("persists exactly one hidden state block per actual store change", async () => {
		const harness = createHarness()
		await harness.fire("session_start", { reason: "new" })

		applyWriteTodos({ todos: [{ content: "first task", status: "pending" }] }, SESSION_ID)
		expect(harness.stateSyncCalls()).toHaveLength(1)

		const [call] = harness.stateSyncCalls()
		expect(call?.message.role).toBeUndefined() // role is added upstream when persisting
		expect(call?.message.display).toBe(false)
		expect(call?.options).toEqual({ deliverAs: "steer" })
		const content = call?.message.content as string
		expect(content).toMatch(/^<system-reminder>\n/)
		expect(content).toContain("## Current Todos")
		expect(content).toContain("first task")

		// Identical re-write: no additional persist.
		applyWriteTodos({ todos: [{ id: 1, content: "first task", status: "pending" }] }, SESSION_ID)
		expect(harness.stateSyncCalls()).toHaveLength(1)

		// A real change persists exactly one more block.
		applyWriteTodos({ todos: [{ id: 1, content: "first task", status: "in_progress" }] }, SESSION_ID)
		expect(harness.stateSyncCalls()).toHaveLength(2)
	})

	it("persists nothing when the rendered block would be empty and nothing was ever persisted", async () => {
		const harness = createHarness()
		await harness.fire("session_start", { reason: "new" })

		applyWriteTodos({ todos: [] }, SESSION_ID)
		expect(harness.stateSyncCalls()).toHaveLength(0)
	})

	it("persists a retraction marker when the list is cleared after a block", async () => {
		const harness = createHarness()
		await harness.fire("session_start", { reason: "new" })

		applyWriteTodos({ todos: [{ content: "gone soon", status: "pending" }] }, SESSION_ID)
		expect(harness.stateSyncCalls()).toHaveLength(1)

		// History is append-only: clearing the list must retract the visible
		// block, otherwise the strip-only view keeps showing stale todos.
		applyWriteTodos({ todos: [] }, SESSION_ID)
		expect(harness.stateSyncCalls()).toHaveLength(2)
		const retraction = harness.stateSyncCalls()[1]?.message.content as string
		expect(retraction).toContain("## Current Todos")
		expect(retraction).toContain("cleared")
		expect(retraction).not.toContain("gone soon")

		// Repeated clears dedupe against the fixed marker.
		applyWriteTodos({ todos: [] }, SESSION_ID)
		expect(harness.stateSyncCalls()).toHaveLength(2)
	})

	it("does not re-persist on resume when history already holds the current block", async () => {
		restoreTodoStoreFromDetails(
			[
				{
					schemaVersion: 1,
					scope: { kind: "global" },
					todos: [{ id: 1, content: "resumed task", status: "pending" }],
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
			],
			SESSION_ID,
		)
		const persistedContent = markHarnessSteer(
			(await import("./state-markdown.js")).renderTodoStateMarkdown(SESSION_ID) ?? "",
		)

		const harness = createHarness([
			{ role: "user", content: [{ type: "text", text: "hello" }] },
			{ role: "custom", customType: TODO_STATE_CUSTOM_TYPE, content: persistedContent, display: false },
		] as MessageLike[])
		await harness.fire("session_start", { reason: "resume" })

		// The store write path replays the same content → dedupe against history.
		applyWriteTodos({ todos: [{ id: 1, content: "resumed task", status: "pending" }] }, SESSION_ID)
		expect(harness.stateSyncCalls()).toHaveLength(0)
	})

	it("persists when the resumed store differs from the newest history block", async () => {
		const harness = createHarness([
			{ role: "custom", customType: TODO_STATE_CUSTOM_TYPE, content: markHarnessSteer("stale block") },
		] as MessageLike[])
		await harness.fire("session_start", { reason: "resume" })

		applyWriteTodos({ todos: [{ content: "new task", status: "pending" }] }, SESSION_ID)
		expect(harness.stateSyncCalls()).toHaveLength(1)
	})

	it("context handler never appends state blocks (no tail push)", async () => {
		const harness = createHarness()
		await harness.fire("session_start", { reason: "new" })

		applyWriteTodos({ todos: [{ content: "present task", status: "pending" }] }, SESSION_ID)

		const result = (await harness.fire("context", { messages: [] })) as { messages: MessageLike[] } | undefined
		expect(result).toBeUndefined()
	})

	it("context handler keeps only the newest persisted block", async () => {
		const newest = markHarnessSteer("## Current Todos\n\n**Global** (0/1 done · 1 active)\n- ○ newest")
		const messages: MessageLike[] = [
			{ role: "user", content: "u1" },
			{ role: "custom", customType: TODO_STATE_CUSTOM_TYPE, content: markHarnessSteer("older block") },
			{ role: "assistant", content: "asst" },
			{ role: "custom", customType: TODO_STATE_CUSTOM_TYPE, content: markHarnessSteer("middle block") },
			{ role: "user", content: "u2" },
			{ role: "custom", customType: TODO_STATE_CUSTOM_TYPE, content: newest },
			{ role: "user", content: "u3" },
		]

		const harness = createHarness()
		const result = (await harness.fire("context", { messages })) as { messages: MessageLike[] }

		const retained = result.messages.filter((m) => m.customType === TODO_STATE_CUSTOM_TYPE)
		expect(retained).toHaveLength(1)
		expect(retained[0]?.content).toBe(newest)
		// Positions of non-state messages are preserved exactly.
		expect(result.messages.filter((m) => m.customType !== TODO_STATE_CUSTOM_TYPE)).toEqual([
			messages[0],
			messages[2],
			messages[4],
			messages[6],
		])
	})

	it("context handler leaves a single state block untouched", async () => {
		const messages: MessageLike[] = [
			{ role: "user", content: "u1" },
			{ role: "custom", customType: TODO_STATE_CUSTOM_TYPE, content: markHarnessSteer("only block") },
			{ role: "user", content: "u2" },
		]

		const harness = createHarness()
		const result = (await harness.fire("context", { messages })) as unknown
		expect(result).toBeUndefined()
	})
})
