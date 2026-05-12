import { beforeEach, describe, expect, it, vi } from "vitest"
import type { CoordinationStore, WorkItem, WorkItemCreateInput } from "./types.js"

/**
 * Stub mock CoordinationStore — implements the interface with trivial defaults.
 * Used to drive out the real contract via RED (failing) tests.
 */
function createStubStore(): CoordinationStore {
	return {
		create: vi.fn(() => undefined as unknown as WorkItem),
		claim: vi.fn(() => undefined),
		complete: vi.fn(() => undefined),
		block: vi.fn(() => undefined),
		unblock: vi.fn(() => undefined),
		archive: vi.fn(() => undefined),
		delete: vi.fn(() => false),
		get: vi.fn(() => undefined),
		list: vi.fn(() => []),
		promoteReady: vi.fn(() => 0),
		getDir: vi.fn(() => "/stub/coordination"),
	}
}

describe("CoordinationStore contract (RED — stub must fail)", () => {
	let store: CoordinationStore

	beforeEach(() => {
		store = createStubStore()
	})

	describe("create", () => {
		it("returns a WorkItem with generated id and timestamps", () => {
			const input: WorkItemCreateInput = {
				title: "Write tests",
				body: "Cover the CoordinationStore interface",
				ferment_id: "f_123",
			}
			const item = store.create(input)

			expect(item).toBeDefined()
			expect(item.id).toMatch(/^wi_/)
			expect(item.title).toBe(input.title)
			expect(item.body).toBe(input.body)
			expect(item.ferment_id).toBe(input.ferment_id)
			expect(item.schema_version).toBe(1)
			expect(item.created_at).toBeTruthy()
			expect(item.updated_at).toBeTruthy()
			expect(item.parents).toEqual([])
		})

		it("accepts optional phase_id, agent_role and parents", () => {
			const input: WorkItemCreateInput = {
				title: "Optional fields",
				body: "",
				ferment_id: "f_123",
				phase_id: "p1",
				agent_role: "worker",
				parents: ["wi_abc"],
			}
			const item = store.create(input)

			expect(item.phase_id).toBe("p1")
			expect(item.agent_role).toBe("worker")
			expect(item.parents).toEqual(["wi_abc"])
		})
	})

	describe("claim", () => {
		it("returns claimed WorkItem with claimed_by and claimed_at set", () => {
			const claimed = store.claim("wi_123", "agent-42")

			expect(claimed).toBeDefined()
			expect((claimed as WorkItem).claimed_by).toBe("agent-42")
			expect((claimed as WorkItem).claimed_at).toBeTruthy()
		})

		it("returns undefined when item is not in ready state", () => {
			const claimed = store.claim("wi_not_ready", "agent-1")
			expect(claimed).toBeUndefined()
		})
	})

	describe("complete", () => {
		it("sets result_summary and moves item to done", () => {
			const completed = store.complete("wi_123", "All tests passing")

			expect(completed).toBeDefined()
			expect((completed as WorkItem).result_summary).toBe("All tests passing")
		})
	})

	describe("block", () => {
		it("sets block_reason and returns updated item", () => {
			const blocked = store.block("wi_123", "Waiting for API key")

			expect(blocked).toBeDefined()
			expect((blocked as WorkItem).block_reason).toBe("Waiting for API key")
		})
	})

	describe("unblock", () => {
		it("clears block_reason and returns updated item", () => {
			const unblocked = store.unblock("wi_123")

			expect(unblocked).toBeDefined()
			expect((unblocked as WorkItem).block_reason).toBeUndefined()
		})
	})

	describe("archive", () => {
		it("returns archived item with updated timestamp", () => {
			const archived = store.archive("wi_123")

			expect(archived).toBeDefined()
			expect((archived as WorkItem).updated_at).toBeTruthy()
		})
	})

	describe("delete", () => {
		it("returns true for existing item", () => {
			const result = store.delete("wi_123")
			expect(result).toBe(true)
		})

		it("returns false for missing item", () => {
			const result = store.delete("wi_missing")
			expect(result).toBe(false)
		})
	})

	describe("get", () => {
		it("returns a WorkItem by id across all states", () => {
			const item = store.get("wi_123")
			expect(item).toBeDefined()
			expect((item as WorkItem).id).toBe("wi_123")
		})
	})

	describe("list", () => {
		it("returns all items when no state filter given", () => {
			const items = store.list()
			expect(items.length).toBeGreaterThan(0)
		})

		it("returns only items matching the state filter", () => {
			const items = store.list("done")
			expect(items.every((i) => i.id.startsWith("wi_"))).toBe(true)
		})
	})

	describe("promoteReady", () => {
		it("returns the count of items promoted from todo to ready", () => {
			const count = store.promoteReady()
			expect(typeof count).toBe("number")
			expect(count).toBeGreaterThanOrEqual(0)
		})
	})

	describe("getDir", () => {
		it("returns an absolute path string", () => {
			const dir = store.getDir()
			expect(dir).toMatch(/^\/.+/)
		})
	})
})
