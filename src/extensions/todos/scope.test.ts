import { describe, expect, it } from "vitest"
import {
	getTodoScopeKey,
	normalizeTodoScope,
	parseTodoScopeKey,
	registerTodoScopeKind,
	validateExplicitTodoScope,
} from "./scope.js"
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

	describe("validateExplicitTodoScope", () => {
		it("returns empty result for omitted/empty input (signals auto-routing)", () => {
			expect(validateExplicitTodoScope(undefined)).toEqual({})
			expect(validateExplicitTodoScope(null)).toEqual({})
			expect(validateExplicitTodoScope("")).toEqual({})
			expect(validateExplicitTodoScope("{}")).toEqual({})
			expect(validateExplicitTodoScope({})).toEqual({})
		})

		it("accepts valid global scope", () => {
			expect(validateExplicitTodoScope("global")).toEqual({ scope: { kind: "global" } })
			expect(validateExplicitTodoScope({ kind: "global" })).toEqual({ scope: { kind: "global" } })
		})

		it("accepts valid ferment scope", () => {
			expect(validateExplicitTodoScope({ kind: "ferment", phaseId: "phase-2" })).toEqual({
				scope: { kind: "ferment", phaseId: "phase-2" },
			})
		})

		it("accepts valid ferment-step scope", () => {
			expect(validateExplicitTodoScope({ kind: "ferment-step", phaseId: "phase-2", stepId: "step-3" })).toEqual({
				scope: { kind: "ferment-step", phaseId: "phase-2", stepId: "step-3" },
			})
		})

		it("rejects unknown string scope with corrective message", () => {
			const result = validateExplicitTodoScope("phase-1")
			expect(result.scope).toBeUndefined()
			expect(result.error).toContain("Unknown todo scope 'phase-1'")
		})

		it("rejects unknown kind", () => {
			const result = validateExplicitTodoScope({ kind: "unknown" })
			expect(result.scope).toBeUndefined()
			expect(result.error).toContain("Unknown todo scope kind 'unknown'")
		})

		it("rejects ferment scope with missing phaseId", () => {
			const result = validateExplicitTodoScope({ kind: "ferment" })
			expect(result.scope).toBeUndefined()
			expect(result.error).toContain("phaseId")
		})

		it("rejects ferment-step scope with missing stepId", () => {
			const result = validateExplicitTodoScope({ kind: "ferment-step", phaseId: "phase-1" })
			expect(result.scope).toBeUndefined()
			expect(result.error).toContain("stepId")
		})

		it("rejects scope missing kind entirely", () => {
			const result = validateExplicitTodoScope({ phaseId: "phase-1" })
			expect(result.scope).toBeUndefined()
			expect(result.error).toContain("missing 'kind'")
		})

		it("rejects non-string non-object input", () => {
			const result = validateExplicitTodoScope(42)
			expect(result.scope).toBeUndefined()
			expect(result.error).toContain("expected an object or string")
		})
	})
})
