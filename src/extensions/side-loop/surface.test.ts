import { describe, expect, it } from "vitest"
import { readSurfaceMessage, resolve, type SurfaceMessage, SurfaceStore } from "./surface.js"

const create = (id: string): SurfaceMessage => ({
	op: "create",
	surface: { id, kind: "custom", title: id, components: [], data: { ci: { summary: "1/2" } } },
})

describe("SurfaceStore", () => {
	it("creates newest-first, merges updates and deletes", () => {
		const store = new SurfaceStore()
		const seen: number[] = []
		store.subscribe((list) => seen.push(list.length))
		store.apply(create("a"), 1)
		store.apply(create("b"), 2)
		store.apply({ op: "update", id: "a", data: { state: "open" } }, 3)
		expect(store.list().map((s) => s.id)).toEqual(["b", "a"])
		expect(store.get("a")).toMatchObject({
			data: { ci: { summary: "1/2" }, state: "open" },
			createdAt: 1,
			updatedAt: 3,
		})
		store.apply({ op: "delete", id: "b" })
		expect(store.list().map((s) => s.id)).toEqual(["a"])
		expect(seen).toEqual([1, 2, 2, 1])
	})

	it("resolves bound values against the data model", () => {
		expect(resolve({ path: "/ci/summary" }, { ci: { summary: "1/2" } })).toBe("1/2")
		expect(resolve("literal", {})).toBe("literal")
	})
})

describe("readSurfaceMessage rejects malformed bus messages", () => {
	it.each([
		["not an object", "create"],
		["unknown op", { op: "replace", id: "a" }],
		["create without components", { op: "create", surface: { id: "a", title: "A" } }],
		["update without id", { op: "update", data: {} }],
	])("%s", (_name, payload) => {
		expect(readSurfaceMessage(payload)).toBeUndefined()
	})

	it("maps an unknown kind to custom", () => {
		const message = readSurfaceMessage({ op: "create", surface: { id: "a", title: "A", kind: "evil", components: [] } })
		expect(message).toMatchObject({ op: "create", surface: { kind: "custom" } })
	})
})
