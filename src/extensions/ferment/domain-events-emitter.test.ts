import type { EventBus } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import type { Ferment } from "../../ferment/types.js"
import { FERMENT_EVENTS, type FermentScopingCompletedPayload } from "./domain-events.js"
import { emitFermentDomainEvent } from "./domain-events-emitter.js"

function makeFerment(overrides: Partial<Ferment> = {}): Ferment {
	return {
		id: "f-test",
		name: "Test Ferment",
		goal: "Test goal",
		successCriteria: ["Tests pass"],
		constraints: [],
		status: "planned",
		worktree: { path: "/tmp/test", branch: undefined, commit: undefined },
		scoping: {},
		phases: [],
		decisions: [],
		memories: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	}
}

function makeEventBus(): { bus: EventBus; emitted: Array<{ channel: string; data: unknown }> } {
	const emitted: Array<{ channel: string; data: unknown }> = []
	const bus = {
		emit: vi.fn((channel: string, data: unknown) => {
			emitted.push({ channel, data })
		}),
		on: vi.fn(() => () => {}),
	} as unknown as EventBus
	return { bus, emitted }
}

describe("emitFermentDomainEvent — scope command", () => {
	it("emits SCOPING_COMPLETE with proposeIterations from the command", () => {
		const { bus, emitted } = makeEventBus()
		const ferment = makeFerment({ id: "f-scope", name: "Scope Test" })

		emitFermentDomainEvent(
			bus,
			{
				type: "scope",
				title: "Scope Test",
				goal: "Test goal",
				successCriteria: ["Tests pass"],
				constraints: [],
				assumptions: undefined,
				phases: [],
				proposeIterations: 3,
			},
			ferment,
		)

		const event = emitted.find((e) => e.channel === FERMENT_EVENTS.SCOPING_COMPLETE)
		expect(event).toBeDefined()
		const payload = event?.data as FermentScopingCompletedPayload
		expect(payload.fermentId).toBe("f-scope")
		expect(payload.name).toBe("Scope Test")
		expect(payload.proposeIterations).toBe(3)
	})

	it("defaults proposeIterations to 0 when not provided", () => {
		const { bus, emitted } = makeEventBus()
		const ferment = makeFerment({ id: "f-scope-2", name: "No Propose" })

		emitFermentDomainEvent(
			bus,
			{
				type: "scope",
				title: "No Propose",
				goal: "Test goal",
				successCriteria: [],
				constraints: [],
				assumptions: undefined,
				phases: [],
			},
			ferment,
		)

		const event = emitted.find((e) => e.channel === FERMENT_EVENTS.SCOPING_COMPLETE)
		expect(event).toBeDefined()
		const payload = event?.data as FermentScopingCompletedPayload
		expect(payload.proposeIterations).toBe(0)
	})

	it("only emits SCOPING_COMPLETE once for a scope command", () => {
		const { bus, emitted } = makeEventBus()
		const ferment = makeFerment()

		emitFermentDomainEvent(
			bus,
			{
				type: "scope",
				goal: "g",
				successCriteria: [],
				constraints: [],
				assumptions: undefined,
				phases: [],
			},
			ferment,
		)

		const scopingEvents = emitted.filter((e) => e.channel === FERMENT_EVENTS.SCOPING_COMPLETE)
		expect(scopingEvents).toHaveLength(1)
	})
})
