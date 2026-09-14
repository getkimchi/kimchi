import type { ExtensionAPI, ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { createContext } from "./__mocks__/context.js"
import { registerStateBlockPersistence } from "./state-block-persistence.js"

const CUSTOM_TYPE = "test-state"
const RETRACTION = "## State cleared"
const TEST_SESSION_ID = "test-session"

type ExtensionHandler = (event: unknown, ctx: ExtensionContext) => unknown | Promise<unknown>

function stateEntry(content: string): Record<string, unknown> {
	return { type: "custom_message", customType: CUSTOM_TYPE, content, id: "e1", parentId: null, timestamp: "" }
}

function abortedAssistantEntry(): Record<string, unknown> {
	return { type: "message", message: { role: "assistant", content: [], stopReason: "aborted" } }
}

function userEntry(): Record<string, unknown> {
	return { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } }
}

interface HarnessOptions {
	initialBranch?: Record<string, unknown>[]
}

/** Registrar harness: a mutable in-memory store whose render mirrors the
 *  wrappers' semantics (empty store + previous ⇒ retraction), a branch the
 *  test can mutate to model compaction cuts, and a notify captured from
 *  `subscribe` so tests drive change signals directly. */
function createHarness(options: HarnessOptions = {}) {
	let store: string | undefined
	let branch: Record<string, unknown>[] = options.initialBranch ?? []
	const handlers = new Map<string, ExtensionHandler[]>()
	let notify: ((key?: string) => void) | undefined

	const pi = {
		sendMessage: vi.fn(),
		on: vi.fn((event: string, handler: ExtensionHandler) => {
			const list = handlers.get(event) ?? []
			list.push(handler)
			handlers.set(event, list)
		}),
	} as unknown as ExtensionAPI

	const ctx = createContext({
		sessionManager: {
			getSessionId: () => TEST_SESSION_ID,
			getBranch: () => branch as unknown as SessionEntry[],
		},
	})

	registerStateBlockPersistence(pi, {
		customType: CUSTOM_TYPE,
		render: (_key, previous) =>
			store !== undefined ? `## State\n${store}` : previous !== undefined ? RETRACTION : undefined,
		subscribe: (n) => {
			notify = n
		},
	})

	async function fire(event: string, payload: unknown = {}): Promise<unknown> {
		let result: unknown
		for (const handler of handlers.get(event) ?? []) {
			result = await handler(payload, ctx)
		}
		return result
	}

	function persisted(): string[] {
		return vi
			.mocked(pi.sendMessage)
			.mock.calls.map(([m]) => (m as { content?: unknown }).content)
			.filter((c): c is string => typeof c === "string")
	}

	return {
		fire,
		notify: () => {
			if (!notify) throw new Error("subscribe not wired")
			notify()
		},
		setStore: (value: string | undefined) => {
			store = value
		},
		setBranch: (entries: Record<string, unknown>[]) => {
			branch = entries
		},
		persisted,
	}
}

async function startSession(h: ReturnType<typeof createHarness>): Promise<void> {
	await h.fire("session_start", { reason: "new" })
}

describe("registerStateBlockPersistence — compaction re-emit", () => {
	it("re-persists the same bytes at the next settle after compaction cut the newest copy", async () => {
		const h = createHarness()
		await startSession(h)
		h.setStore("item A")
		h.notify()
		expect(h.persisted()).toEqual(["## State\nitem A"])

		// Compaction summarizes the block: entry leaves the branch.
		h.setBranch([])
		await h.fire("session_compact", { reason: "threshold" })
		expect(h.persisted()).toHaveLength(1) // no mid-run send

		await h.fire("agent_start")
		await h.fire("agent_end")
		await h.fire("agent_settled")
		expect(h.persisted()).toEqual(["## State\nitem A", "## State\nitem A"])
	})

	it("does nothing when the newest copy survived compaction", async () => {
		const h = createHarness()
		await startSession(h)
		h.setStore("item A")
		h.notify()
		h.setBranch([stateEntry("## State\nitem A")])
		await h.fire("session_compact", { reason: "manual" })

		await h.fire("agent_start")
		await h.fire("agent_end")
		await h.fire("agent_settled")
		expect(h.persisted()).toHaveLength(1)
	})

	it("marks nothing when there was never persisted state", async () => {
		const h = createHarness()
		await startSession(h)
		await h.fire("session_compact", { reason: "threshold" })
		await h.fire("agent_start")
		await h.fire("agent_end")
		await h.fire("agent_settled")
		expect(h.persisted()).toHaveLength(0)
	})

	it("re-persists the retraction after compaction cut the cleared marker", async () => {
		const h = createHarness()
		await startSession(h)
		h.setStore("item A")
		h.notify()
		h.setStore(undefined)
		h.notify()
		expect(h.persisted()).toEqual(["## State\nitem A", RETRACTION])

		h.setBranch([])
		await h.fire("session_compact", { reason: "overflow" })
		await h.fire("agent_start")
		await h.fire("agent_end")
		await h.fire("agent_settled")
		expect(h.persisted()).toEqual(["## State\nitem A", RETRACTION, RETRACTION])
	})

	it("defers past an aborted settle and re-emits at the next healthy settle", async () => {
		const h = createHarness()
		await startSession(h)
		h.setStore("item A")
		h.notify()
		h.setBranch([])
		await h.fire("session_compact", { reason: "threshold" })

		// Aborted run (e.g. /compact mid-stream): flush must skip.
		h.setBranch([abortedAssistantEntry()])
		await h.fire("agent_start")
		await h.fire("agent_end")
		await h.fire("agent_settled")
		expect(h.persisted()).toHaveLength(1)

		// Next healthy settle re-emits.
		h.setBranch([userEntry()])
		await h.fire("agent_start")
		await h.fire("agent_end")
		await h.fire("agent_settled")
		expect(h.persisted()).toHaveLength(2)
	})

	it("back-to-back compactions before a settle produce exactly one re-emit", async () => {
		const h = createHarness()
		await startSession(h)
		h.setStore("item A")
		h.notify()
		h.setBranch([])
		await h.fire("session_compact", { reason: "threshold" })
		await h.fire("session_compact", { reason: "threshold" })

		await h.fire("agent_start")
		await h.fire("agent_end")
		await h.fire("agent_settled")
		expect(h.persisted()).toHaveLength(2)
	})

	it("a store change between compact and settle satisfies the re-emit (single write)", async () => {
		const h = createHarness()
		await startSession(h)
		h.setStore("item A")
		h.notify()
		h.setBranch([])
		await h.fire("session_compact", { reason: "threshold" })

		await h.fire("agent_start")
		h.setStore("item B")
		h.notify() // busy → coalesced into pendingFlush
		await h.fire("agent_end")
		await h.fire("agent_settled")
		expect(h.persisted()).toEqual(["## State\nitem A", "## State\nitem B"])

		// And nothing extra at the following settle.
		await h.fire("agent_start")
		await h.fire("agent_end")
		await h.fire("agent_settled")
		expect(h.persisted()).toHaveLength(2)
	})
})
