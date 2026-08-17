import type { EventBus } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { HERDR_EVENTS, withBlocked } from "./herdr-events.js"

function makeBus(): EventBus & { emit: ReturnType<typeof vi.fn> } {
	return { emit: vi.fn() } as unknown as EventBus & { emit: ReturnType<typeof vi.fn> }
}

function blockedCalls(bus: { emit: ReturnType<typeof vi.fn> }) {
	return bus.emit.mock.calls.filter(([channel]) => channel === HERDR_EVENTS.BLOCKED)
}

describe("withBlocked", () => {
	it("emits a balanced activation pair around a resolving fn", async () => {
		const bus = makeBus()
		const result = await withBlocked(bus, "Waiting on user", async () => 42)

		expect(result).toBe(42)
		expect(blockedCalls(bus)).toEqual([
			[HERDR_EVENTS.BLOCKED, { active: true, label: "Waiting on user" }],
			[HERDR_EVENTS.BLOCKED, { active: false }],
		])
	})

	it("keeps blocked active while fn is pending", async () => {
		const bus = makeBus()
		let resolveFn!: () => void
		const pending = withBlocked(bus, "Waiting on user", () => new Promise<void>((resolve) => (resolveFn = resolve)))

		expect(blockedCalls(bus)).toEqual([[HERDR_EVENTS.BLOCKED, { active: true, label: "Waiting on user" }]])

		resolveFn()
		await pending
		expect(blockedCalls(bus)).toEqual([
			[HERDR_EVENTS.BLOCKED, { active: true, label: "Waiting on user" }],
			[HERDR_EVENTS.BLOCKED, { active: false }],
		])
	})

	it("deactivates when fn rejects and rethrows", async () => {
		const bus = makeBus()
		await expect(
			withBlocked(bus, "Waiting on user", async () => {
				throw new Error("prompt crashed")
			}),
		).rejects.toThrow("prompt crashed")

		expect(blockedCalls(bus)).toEqual([
			[HERDR_EVENTS.BLOCKED, { active: true, label: "Waiting on user" }],
			[HERDR_EVENTS.BLOCKED, { active: false }],
		])
	})

	it("balances nested pairs", async () => {
		const bus = makeBus()
		await withBlocked(bus, "outer", () => withBlocked(bus, "inner", async () => {}))

		expect(blockedCalls(bus)).toEqual([
			[HERDR_EVENTS.BLOCKED, { active: true, label: "outer" }],
			[HERDR_EVENTS.BLOCKED, { active: true, label: "inner" }],
			[HERDR_EVENTS.BLOCKED, { active: false }],
			[HERDR_EVENTS.BLOCKED, { active: false }],
		])
	})

	it("runs fn without emitting when no event bus is available", async () => {
		const fn = vi.fn(async () => "ok")
		const result = await withBlocked(undefined, "Waiting on user", fn)

		expect(result).toBe("ok")
		expect(fn).toHaveBeenCalledTimes(1)
	})
})
