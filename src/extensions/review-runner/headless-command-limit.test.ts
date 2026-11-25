import { describe, expect, it } from "vitest"
import { acquireHeadlessCommandSlot } from "./headless-command-limit.js"

describe("headless command limit", () => {
	it("runs only one command in a panel group and releases the next in FIFO order", async () => {
		const order: string[] = []
		const releaseFirst = await acquireHeadlessCommandSlot("one-panel")
		const second = acquireHeadlessCommandSlot("one-panel").then((release) => {
			order.push("second")
			release()
		})
		const third = acquireHeadlessCommandSlot("one-panel").then((release) => {
			order.push("third")
			release()
		})
		order.push("first")
		releaseFirst()
		await Promise.all([second, third])
		expect(order).toEqual(["first", "second", "third"])
	})

	it("separates panels and removes cancelled waiters", async () => {
		const release = await acquireHeadlessCommandSlot("panel-a")
		const otherPanel = await acquireHeadlessCommandSlot("panel-b")
		otherPanel()
		const controller = new AbortController()
		const waiting = acquireHeadlessCommandSlot("panel-a", controller.signal)
		controller.abort(new Error("stop waiting"))
		await expect(waiting).rejects.toThrow("stop waiting")
		release()
		const next = await acquireHeadlessCommandSlot("panel-a")
		next()
	})
})
