import type { EventBus } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import { createMiniEventBus } from "./__mocks__/mini-event-bus.js"
import { createBlockedDialogActivity, HERDR_EVENTS, HERDR_LABEL_MAX_LENGTH, withBlocked } from "./herdr-events.js"

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

	it("counts nested dialogs and subtracts the caller's own activations", async () => {
		const { events } = createMiniEventBus()
		let own = 0
		const activity = createBlockedDialogActivity(events, () => own)
		let resolveOwn!: () => void
		own += 1
		const ownPrompt = withBlocked(
			events,
			"Permission (subagent): bash",
			() => new Promise<void>((resolve) => (resolveOwn = resolve)),
		).finally(() => {
			own -= 1
		})
		expect(activity.hasOtherDialogs()).toBe(false)

		let resolveInner!: () => void
		const questionnaire = withBlocked(events, "Questionnaire", () =>
			withBlocked(events, "Ferment choice", () => new Promise<void>((resolve) => (resolveInner = resolve))),
		)
		expect(activity.hasOtherDialogs()).toBe(true)
		resolveInner()
		await questionnaire
		expect(activity.hasOtherDialogs()).toBe(false)

		resolveOwn()
		await ownPrompt
		expect(activity.hasOtherDialogs()).toBe(false)
		activity.dispose()
	})

	it("keeps a foreign dialog counted when one of the caller's own prompts closes", async () => {
		// A deactivation carries no label. Filtering activations by label would
		// let the own prompt's deactivation close the questionnaire in the tally.
		const { events } = createMiniEventBus()
		let own = 0
		const activity = createBlockedDialogActivity(events, () => own)
		let resolveOwn!: () => void
		own += 1
		const ownPrompt = withBlocked(
			events,
			"Permission: write",
			() => new Promise<void>((resolve) => (resolveOwn = resolve)),
		).finally(() => {
			own -= 1
		})
		let resolveQuestionnaire!: () => void
		const questionnaire = withBlocked(
			events,
			"Questionnaire",
			() => new Promise<void>((resolve) => (resolveQuestionnaire = resolve)),
		)
		expect(activity.hasOtherDialogs()).toBe(true)

		resolveOwn()
		await ownPrompt
		expect(activity.hasOtherDialogs()).toBe(true)

		resolveQuestionnaire()
		await questionnaire
		expect(activity.hasOtherDialogs()).toBe(false)
		activity.dispose()
	})

	it("stops reporting blocked dialogs after disposal", async () => {
		const { events } = createMiniEventBus()
		const activity = createBlockedDialogActivity(events)
		let resolveDialog!: () => void
		const waiting = withBlocked(
			events,
			"Questionnaire",
			() => new Promise<void>((resolve) => (resolveDialog = resolve)),
		)
		expect(activity.hasOtherDialogs()).toBe(true)
		activity.dispose()
		expect(activity.hasOtherDialogs()).toBe(false)
		activity.dispose()
		resolveDialog()
		await waiting
	})
})
