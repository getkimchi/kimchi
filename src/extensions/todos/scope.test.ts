import { describe, expect, it } from "vitest"
import { getTodoScopeKey, normalizeTodoScope, parseTodoScopeKey, registerTodoScopeKind } from "./scope.js"
import type { TodoScope } from "./types.js"

describe("todo scope helpers", () => {
	it("normalizes missing and global scopes", () => {
		expect(normalizeTodoScope(undefined)).toEqual({ kind: "global" })
		expect(normalizeTodoScope(null)).toEqual({ kind: "global" })
		expect(normalizeTodoScope("global")).toEqual({ kind: "global" })
		expect(normalizeTodoScope({ kind: "global" })).toEqual({ kind: "global" })
		expect(normalizeTodoScope({ type: "global" })).toEqual({ kind: "global" })
	})

	it("falls back to global for unknown tool input", () => {
		expect(normalizeTodoScope("unknown")).toEqual({ kind: "global" })
		expect(normalizeTodoScope({ kind: "unknown" })).toEqual({ kind: "global" })
		expect(normalizeTodoScope(12)).toEqual({ kind: "global" })
	})

	it("builds and parses the global scope key", () => {
		expect(getTodoScopeKey({ kind: "global" })).toBe("global")
		expect(parseTodoScopeKey("global")).toEqual({ kind: "global" })
		expect(() => parseTodoScopeKey("bad:key")).toThrowError(/Invalid todo scope key/)
	})

	it("supports registered scope-kind handlers", () => {
		registerTodoScopeKind({
			kind: "custom",
			normalize: (raw) => {
				const id = typeof raw.id === "string" ? raw.id.trim() : ""
				return id ? ({ kind: "custom", id } as unknown as TodoScope) : undefined
			},
			toKey: (scope) => `custom:${encodeURIComponent((scope as unknown as { id: string }).id)}`,
			fromKey: ([id]) => (id ? ({ kind: "custom", id } as unknown as TodoScope) : undefined),
		})

		const scope = normalizeTodoScope({ kind: "custom", id: "a/b" }) as unknown as { kind: string; id: string }
		expect(scope).toEqual({ kind: "custom", id: "a/b" })
		expect(getTodoScopeKey(scope as unknown as TodoScope)).toBe("custom:a%2Fb")
		expect(parseTodoScopeKey("custom:a%2Fb")).toEqual({ kind: "custom", id: "a/b" })
	})
})
