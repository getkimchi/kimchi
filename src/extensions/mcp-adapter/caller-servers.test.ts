import { afterEach, describe, expect, it } from "vitest"
import {
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

describe("caller-servers registry (session-id-keyed)", () => {
	describe("setCallerMcpServers / consumeCallerMcpServers", () => {
		it("consume returns servers for the given sessionId and drains on next call", () => {
			setCallerMcpServers("s1", { foo: stdioEntry })
			expect(consumeCallerMcpServers("s1")).toEqual({ foo: stdioEntry })
			expect(consumeCallerMcpServers("s1")).toEqual({})
		})

		it("consume on unknown sessionId returns {}", () => {
			expect(consumeCallerMcpServers("nonexistent")).toEqual({})
		})

		it("set with empty object → consume returns {}", () => {
			setCallerMcpServers("s1", {})
			expect(consumeCallerMcpServers("s1")).toEqual({})
		})

		it("two sessions consume independently with no cross-contamination", () => {
			setCallerMcpServers("s1", { a: stdioEntry })
			setCallerMcpServers("s2", { b: httpEntry })
			expect(consumeCallerMcpServers("s1")).toEqual({ a: stdioEntry })
			expect(consumeCallerMcpServers("s2")).toEqual({ b: httpEntry })
			expect(consumeCallerMcpServers("s1")).toEqual({})
			expect(consumeCallerMcpServers("s2")).toEqual({})
		})
	})

	describe("peekCallerMcpServers", () => {
		it("returns the entry without draining", () => {
			setCallerMcpServers("s1", { foo: stdioEntry })
			expect(peekCallerMcpServers("s1")).toEqual({ foo: stdioEntry })
			expect(peekCallerMcpServers("s1")).toEqual({ foo: stdioEntry })
			// Still consumable after peek
			expect(consumeCallerMcpServers("s1")).toEqual({ foo: stdioEntry })
		})

		it("returns undefined on unknown sessionId", () => {
			expect(peekCallerMcpServers("nonexistent")).toBeUndefined()
		})
	})

	describe("removePendingEntry", () => {
		it("removes a pending entry that has not been consumed", () => {
			setCallerMcpServers("s1", { foo: stdioEntry })
			removePendingEntry("s1")
			expect(peekCallerMcpServers("s1")).toBeUndefined()
			expect(consumeCallerMcpServers("s1")).toEqual({})
		})

		it("is a no-op if the entry was already consumed", () => {
			setCallerMcpServers("s1", { foo: stdioEntry })
			consumeCallerMcpServers("s1")
			// Already consumed — should not throw
			removePendingEntry("s1")
			expect(peekCallerMcpServers("s1")).toBeUndefined()
		})

		it("only removes the specified session, not others", () => {
			setCallerMcpServers("s1", { a: stdioEntry })
			setCallerMcpServers("s2", { b: httpEntry })
			removePendingEntry("s1")
			expect(peekCallerMcpServers("s1")).toBeUndefined()
			expect(consumeCallerMcpServers("s2")).toEqual({ b: httpEntry })
		})

		it("is a no-op on unknown sessionId", () => {
			// Should not throw
			removePendingEntry("nonexistent")
		})
	})

	describe("clearCallerMcpServers", () => {
		it("clears all entries", () => {
			setCallerMcpServers("s1", { a: stdioEntry })
			setCallerMcpServers("s2", { b: httpEntry })
			clearCallerMcpServers()
			expect(peekCallerMcpServers("s1")).toBeUndefined()
			expect(peekCallerMcpServers("s2")).toBeUndefined()
		})
	})

	describe("concurrent session isolation", () => {
		it("out-of-order consumption: session B can consume before session A", () => {
			// Simulate the race: A is set first, B second, but B consumes first
			setCallerMcpServers("A", { first: stdioEntry })
			setCallerMcpServers("B", { second: httpEntry })

			// B consumes first — gets B's servers, not A's
			expect(consumeCallerMcpServers("B")).toEqual({ second: httpEntry })

			// A consumes second — gets A's servers, not B's
			expect(consumeCallerMcpServers("A")).toEqual({ first: stdioEntry })

			// Both drained
			expect(consumeCallerMcpServers("A")).toEqual({})
			expect(consumeCallerMcpServers("B")).toEqual({})
		})
	})
})
