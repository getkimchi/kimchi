import { afterEach, describe, expect, it, vi } from "vitest"
import {
	__resetAboveEditorOccupancy,
	acquireAboveEditorSlot,
	isAboveEditorOccupied,
	onAboveEditorOccupancyChange,
} from "./above-editor-occupancy.js"

afterEach(() => {
	__resetAboveEditorOccupancy()
})

describe("above-editor occupancy", () => {
	it("starts unoccupied", () => {
		expect(isAboveEditorOccupied()).toBe(false)
	})

	it("marks occupied while a slot is held and clears on release", () => {
		const release = acquireAboveEditorSlot("todos")
		expect(isAboveEditorOccupied()).toBe(true)
		release()
		expect(isAboveEditorOccupied()).toBe(false)
	})

	it("stays occupied until the last occupant releases", () => {
		const releaseTodos = acquireAboveEditorSlot("todos")
		const releaseAgents = acquireAboveEditorSlot("agents")
		expect(isAboveEditorOccupied()).toBe(true)
		releaseTodos()
		expect(isAboveEditorOccupied()).toBe(true)
		releaseAgents()
		expect(isAboveEditorOccupied()).toBe(false)
	})

	it("ref-counts the same key", () => {
		const first = acquireAboveEditorSlot("todos")
		const second = acquireAboveEditorSlot("todos")
		first()
		expect(isAboveEditorOccupied()).toBe(true)
		second()
		expect(isAboveEditorOccupied()).toBe(false)
	})

	it("ignores double release", () => {
		const release = acquireAboveEditorSlot("todos")
		release()
		release()
		expect(isAboveEditorOccupied()).toBe(false)
	})

	it("notifies on acquire and release of the first/last occupant", () => {
		const listener = vi.fn()
		onAboveEditorOccupancyChange(listener)

		const release = acquireAboveEditorSlot("todos")
		expect(listener).toHaveBeenCalledTimes(1)

		const releaseSame = acquireAboveEditorSlot("todos")
		expect(listener).toHaveBeenCalledTimes(1)

		release()
		expect(listener).toHaveBeenCalledTimes(1)

		releaseSame()
		expect(listener).toHaveBeenCalledTimes(2)
	})
})
