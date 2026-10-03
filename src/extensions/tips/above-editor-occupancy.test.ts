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

	it("notifies only on empty↔occupied transitions of the strip", () => {
		const listener = vi.fn()
		onAboveEditorOccupancyChange(listener)

		const releaseTodos = acquireAboveEditorSlot("todos")
		expect(listener).toHaveBeenCalledTimes(1)

		const releaseAgents = acquireAboveEditorSlot("agents")
		expect(listener).toHaveBeenCalledTimes(1)

		const releaseTodosAgain = acquireAboveEditorSlot("todos")
		expect(listener).toHaveBeenCalledTimes(1)

		releaseTodos()
		expect(listener).toHaveBeenCalledTimes(1)
		releaseTodosAgain()
		expect(listener).toHaveBeenCalledTimes(1)

		releaseAgents()
		expect(listener).toHaveBeenCalledTimes(2)
	})

	it("supports multiple listeners", () => {
		const first = vi.fn()
		const second = vi.fn()
		const unsubFirst = onAboveEditorOccupancyChange(first)
		onAboveEditorOccupancyChange(second)

		const release = acquireAboveEditorSlot("todos")
		expect(first).toHaveBeenCalledTimes(1)
		expect(second).toHaveBeenCalledTimes(1)

		unsubFirst()
		release()
		expect(first).toHaveBeenCalledTimes(1)
		expect(second).toHaveBeenCalledTimes(2)
	})

	it("keeps the release handle usable when a listener throws", () => {
		onAboveEditorOccupancyChange(() => {
			throw new Error("listener boom")
		})

		const release = acquireAboveEditorSlot("todos")
		expect(isAboveEditorOccupied()).toBe(true)
		expect(() => release()).not.toThrow()
		expect(isAboveEditorOccupied()).toBe(false)
	})
})
