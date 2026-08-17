import type { EventBus } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { HERDR_EVENTS, HERDR_LABEL_MAX_LENGTH, withBlocked } from "./herdr-events.js"

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

	it("collapses whitespace and newlines in the label", async () => {
		const bus = makeBus()
		await withBlocked(bus, "  multi\nline\t label  ", async () => {})

		expect(blockedCalls(bus)[0]).toEqual([HERDR_EVENTS.BLOCKED, { active: true, label: "multi line label" }])
	})

	it("truncates labels longer than HERDR_LABEL_MAX_LENGTH with an ellipsis", async () => {
		const bus = makeBus()
		await withBlocked(bus, "x".repeat(HERDR_LABEL_MAX_LENGTH + 50), async () => {})

		const [, payload] = blockedCalls(bus)[0] as [string, { active: boolean; label: string }]
		expect(payload.label).toHaveLength(HERDR_LABEL_MAX_LENGTH)
		expect(payload.label.endsWith("…")).toBe(true)
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
})
