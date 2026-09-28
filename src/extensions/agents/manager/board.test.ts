import { SessionManager } from "@earendil-works/pi-coding-agent"
import { describe, expect, it } from "vitest"
import { BOARD_ENTRY_BODY_MAX, BoardStore, PER_BOARD_CAP } from "./board.js"

describe("automatic progress snapshots", () => {
	it("recovers the revised contract and latest progress from the owning session branch", () => {
		const journal = SessionManager.inMemory()
		const root = journal.getSessionId()
		const original = new BoardStore()
		const initial = original.post(root, "group", "worker", "finding", "Contract v1", "Use seconds", 1).entry
		const progress = original.post(root, "group", "worker", "work", "Pending", "Check revision", 2, "todos").entry
		const revised = original.post(
			root,
			"group",
			"worker",
			"finding",
			"Contract v2",
			"Use milliseconds; evidence: contract.json",
			3,
		).entry
		const complete = original.post(
			root,
			"group",
			"worker",
			"work",
			"Complete",
			"Evidence: contract check passed",
			4,
			"todos",
		).entry
		for (const entry of [initial, progress, revised, complete]) journal.appendCustomEntry("agent-board:entry:v1", entry)
		const recovered = new BoardStore()
		recovered.restoreRoot(root, journal.getBranch())
		expect(recovered.read(root, "group")).toEqual([initial, revised, complete])
		expect(recovered.read(root, "group", { sinceId: initial.id })).toEqual([revised, complete])
		expect(recovered.getSummary(root, "group")).toEqual(original.getSummary(root, "group"))
	})

	it("drops abandoned-branch findings, ignores foreign or malformed entries and restores idempotently", () => {
		const journal = SessionManager.inMemory()
		const root = journal.getSessionId()
		const store = new BoardStore()
		const entry = store.post(root, "group", "worker", "finding", "Original contract", "seconds", 1).entry
		const checkpoint = journal.appendCustomEntry("agent-board:entry:v1", entry)
		journal.appendCustomEntry("agent-board:entry:v1", entry)
		for (const data of [
			null,
			{ ...entry, id: "bd-foreign", rootSessionId: "foreign" },
			{ ...entry, id: "bd-kind", kind: "instruction" },
			{ ...entry, id: "bd-time", postedAt: Number.NaN },
			{ ...entry, id: "bd-long", body: "x".repeat(BOARD_ENTRY_BODY_MAX + 1) },
		]) {
			journal.appendCustomEntry("agent-board:entry:v1", data)
		}
		store.restoreRoot(root, journal.getBranch())
		expect(store.read(root, "group")).toEqual([entry])
		const changed = { ...entry, id: "bd-revision", body: "milliseconds", postedAt: 2 }
		journal.appendCustomEntry("agent-board:entry:v1", changed)
		store.restoreRoot(root, journal.getBranch())
		expect(store.read(root, "group")).toEqual([entry, changed])
		journal.branch(checkpoint)
		store.restoreRoot(root, journal.getBranch())
		store.restoreRoot(root, journal.getBranch())
		expect(store.read(root, "group")).toEqual([entry])
		store.restoreRoot("foreign", journal.getBranch())
		expect(store.getSummariesForRoot("foreign")).toEqual([])
	})

	it("applies live retention limits when restoring a long journal", () => {
		const journal = SessionManager.inMemory()
		const root = journal.getSessionId()
		const original = new BoardStore()
		for (let i = 0; i < PER_BOARD_CAP + 10; i++) {
			journal.appendCustomEntry(
				"agent-board:entry:v1",
				original.post(root, "group", "worker", "finding", `Finding ${i}`, `Evidence ${i}`, i).entry,
			)
		}
		const recovered = new BoardStore()
		recovered.restoreRoot(root, journal.getBranch())
		expect(recovered.read(root, "group", { limit: PER_BOARD_CAP })).toEqual(
			original.read(root, "group", { limit: PER_BOARD_CAP }),
		)
		expect(recovered.getSummary(root, "group").total).toBe(PER_BOARD_CAP)
	})

	it("retains distinct findings when their title and body contain delimiters", () => {
		const store = new BoardStore()
		const first = store.post("root", "group", "a", "finding", "contract|v1", "client", 1).entry
		const second = store.post("root", "group", "a", "finding", "contract", "v1|client", 2)
		expect(second.deduped).toBeUndefined()
		expect(second.entry.id).not.toBe(first.id)
		expect(store.read("root", "group")).toEqual([first, second.entry])
		expect(store.post("root", "group", "a", "finding", "contract", "v1|client", 3).entry).toEqual(second.entry)
	})

	it("preserves code formatting through posting, reading and session recovery", () => {
		const journal = SessionManager.inMemory()
		const root = journal.getSessionId()
		const store = new BoardStore()
		const body = 'Evidence:\n```python\nif enabled:\n    print("two  spaces")\nrelease()\n```\n'
		const { entry } = store.post(root, "group", "worker", "finding", "Cleanup scope", body, 1)
		expect(entry.body).toBe(body)
		expect(store.read(root, "group")[0]?.body).toBe(body)
		journal.appendCustomEntry("agent-board:entry:v1", entry)
		const recovered = new BoardStore()
		recovered.restoreRoot(root, journal.getBranch())
		expect(recovered.read(root, "group")[0]?.body).toBe(body)
	})

	it("keeps indentation corrections distinct while deduplicating exact repeats", () => {
		const store = new BoardStore()
		const before = "if enabled:\n    use()\nrelease()"
		const after = "if enabled:\n    use()\n    release()"
		const first = store.post("root", "group", "worker", "finding", "Cleanup scope", before, 1)
		const corrected = store.post("root", "group", "worker", "finding", "Cleanup scope", after, 2)
		expect(corrected.deduped).toBeUndefined()
		expect(corrected.entry.id).not.toBe(first.entry.id)
		expect(store.read("root", "group").map((entry) => entry.body)).toEqual([before, after])
		expect(store.post("root", "group", "worker", "finding", "Cleanup scope", after, 3).deduped).toBe(true)
	})

	it("keeps identical manual posts and distinct snapshot scopes separate", () => {
		const store = new BoardStore()
		store.post("root", "group", "a", "work", "same", "same", 1)
		store.post("root", "group", "a", "work", "same", "same", 2, "session:global")
		store.post("root", "group", "a", "work", "same", "same", 3, "session:phase")
		expect(store.read("root", "group")).toHaveLength(3)
	})

	it("leaves snapshots in other groups and roots intact", () => {
		const store = new BoardStore()
		const group = store.post("root", "other", "a", "work", "other group", "pending", 1, "session:global").entry
		const root = store.post("other", "group", "a", "work", "other root", "pending", 2, "session:global").entry
		store.post("root", "group", "a", "work", "this group", "pending", 3, "session:global")
		store.post("root", "group", "a", "work", "this group", "complete", 4, "session:global")
		expect(store.read("root", "other")).toEqual([group])
		expect(store.read("other", "group")).toEqual([root])
		expect(store.read("root", "group")).toHaveLength(1)
	})

	it("replaces only the same author's snapshot and recovers an old cursor", () => {
		const store = new BoardStore()
		const old = store.post("root", "group", "a", "work", "pending", "old evidence", 1, "session:global").entry
		const finding = store.post("root", "group", "a", "finding", "contract", "verified format", 2).entry
		const manual = store.post("root", "group", "a", "work", "manual", "keep this", 3).entry
		const peer = store.post("root", "group", "b", "work", "pending", "peer", 4, "session:global").entry
		const otherScope = store.post("root", "group", "a", "work", "phase", "phase work", 5, "session:phase").entry
		const latest = store.post("root", "group", "a", "work", "complete", "new evidence", 6, "session:global")
		expect(latest.evicted).toEqual(old)
		expect(latest.entry.id).not.toBe(old.id)
		expect(store.read("root", "group", { sinceId: old.id })).toEqual([finding, manual, peer, otherScope, latest.entry])
		expect(store.getSummary("root", "group")).toMatchObject({ total: 5, latest: [{ id: latest.entry.id }, {}, {}] })
	})

	it("keeps findings through repeated updates and allows a return to earlier progress", () => {
		const store = new BoardStore()
		const finding = store.post("root", "group", "a", "finding", "decision", "retain evidence", 1).entry
		store.post("root", "group", "a", "work", "pending", "pending", 2, "session:global")
		for (let i = 0; i < 210; i++) {
			store.post("root", "group", "a", "work", `update ${i}`, `check ${i}`, 3 + i, "session:global")
		}
		const reopened = store.post("root", "group", "a", "work", "pending", "pending", 214, "session:global")
		expect(reopened.deduped).toBeUndefined()
		expect(store.read("root", "group")).toEqual([finding, reopened.entry])
		expect(store.post("root", "group", "a", "work", "pending", "pending", 215, "session:global").deduped).toBe(true)
		store.cleanupRoot("root")
		expect(store.read("root", "group")).toEqual([])
		expect(
			store.post("root", "group", "a", "work", "pending", "pending", 216, "session:global").deduped,
		).toBeUndefined()
	})
})
