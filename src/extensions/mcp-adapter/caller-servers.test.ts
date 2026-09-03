import { afterEach, describe, expect, it } from "vitest"
import {
	type CallerServerEntry,
	clearCallerMcpServers,
	consumeCallerMcpServers,
	peekCallerMcpServers,
	removePendingEntry,
	setCallerMcpServers,
} from "./caller-servers.js"
import type { ServerEntry } from "./types.js"

afterEach(() => {
	clearCallerMcpServers()
})

const stdioEntry: ServerEntry = { command: "/path", args: [] }
const httpEntry: ServerEntry = { url: "https://example.com" }

describe("caller-servers queue", () => {
	describe("setCallerMcpServers / consumeCallerMcpServers", () => {
		it("consume returns pushed servers and drains on next call", () => {
			setCallerMcpServers({ foo: stdioEntry })
			expect(consumeCallerMcpServers()).toEqual({ foo: stdioEntry })
			expect(consumeCallerMcpServers()).toEqual({})
		})

		it("consume on empty queue returns {}", () => {
			expect(consumeCallerMcpServers()).toEqual({})
		})

		it("set with empty object → consume returns {}", () => {
			setCallerMcpServers({})
			expect(consumeCallerMcpServers()).toEqual({})
		})

		it("second set after first drains independently", () => {
			setCallerMcpServers({ a: stdioEntry })
			setCallerMcpServers({ b: httpEntry })
			expect(consumeCallerMcpServers()).toEqual({ a: stdioEntry })
			expect(consumeCallerMcpServers()).toEqual({ b: httpEntry })
			expect(consumeCallerMcpServers()).toEqual({})
		})
	})

	describe("peekCallerMcpServers", () => {
		it("returns the head without draining", () => {
			setCallerMcpServers({ foo: stdioEntry })
			expect(peekCallerMcpServers()).toEqual({ foo: stdioEntry })
			expect(peekCallerMcpServers()).toEqual({ foo: stdioEntry })
			// Still consumable after peek
			expect(consumeCallerMcpServers()).toEqual({ foo: stdioEntry })
		})

		it("returns undefined on empty queue", () => {
			expect(peekCallerMcpServers()).toBeUndefined()
		})
	})

	describe("removePendingEntry", () => {
		it("removes a pending entry that has not been consumed", () => {
			const entry: CallerServerEntry = setCallerMcpServers({ foo: stdioEntry })
			removePendingEntry(entry)
			expect(peekCallerMcpServers()).toBeUndefined()
			expect(consumeCallerMcpServers()).toEqual({})
		})

		it("is a no-op if the entry was already consumed", () => {
			const entry: CallerServerEntry = setCallerMcpServers({ foo: stdioEntry })
			expect(consumeCallerMcpServers()).toEqual({ foo: stdioEntry })
			// Already consumed — should not throw or drain the next entry
			removePendingEntry(entry)
			expect(peekCallerMcpServers()).toBeUndefined()
		})

		it("only removes the specified entry, not others", () => {
			const entry1: CallerServerEntry = setCallerMcpServers({ a: stdioEntry })
			setCallerMcpServers({ b: httpEntry })
			removePendingEntry(entry1)
			// entry1 removed, entry2 still in queue
			expect(consumeCallerMcpServers()).toEqual({ b: httpEntry })
			expect(consumeCallerMcpServers()).toEqual({})
		})

		it("does not remove a different entry with the same content (reference identity)", () => {
			const entry1: CallerServerEntry = setCallerMcpServers({ same: stdioEntry })
			setCallerMcpServers({ same: stdioEntry })
			removePendingEntry(entry1)
			// entry1 removed by reference, second entry (same content) remains
			expect(consumeCallerMcpServers()).toEqual({ same: stdioEntry })
			expect(consumeCallerMcpServers()).toEqual({})
		})
	})

	describe("clearCallerMcpServers", () => {
		it("clears all entries", () => {
			setCallerMcpServers({ a: stdioEntry })
			setCallerMcpServers({ b: httpEntry })
			clearCallerMcpServers()
			expect(consumeCallerMcpServers()).toEqual({})
			expect(peekCallerMcpServers()).toBeUndefined()
		})
	})

	describe("FIFO ordering", () => {
		it("preserves push order across multiple sessions", () => {
			setCallerMcpServers({ first: stdioEntry })
			setCallerMcpServers({ second: httpEntry })
			setCallerMcpServers({ third: stdioEntry })

			expect(consumeCallerMcpServers()).toEqual({ first: stdioEntry })
			expect(consumeCallerMcpServers()).toEqual({ second: httpEntry })
			expect(consumeCallerMcpServers()).toEqual({ third: stdioEntry })
		})
	})
})
