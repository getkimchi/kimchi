import { vi } from "vitest"

/**
 * Creates a mini event-bus mock for `pi.events` that actually delivers
 * `emit` calls to registered `on` handlers. Many test harnesses need this
 * because the plan-review bus routes decisions through `events.emit` →
 * `events.on`; a dead `vi.fn()` stub swallows every delivery.
 *
 * Returns the `events` object plus an `emit` spy for assertion.
 */
export function createMiniEventBus(): {
	events: {
		emit: ReturnType<typeof vi.fn>
		on: ReturnType<typeof vi.fn>
	}
	emit: ReturnType<typeof vi.fn>
} {
	const eventHandlers = new Map<string, ((data: unknown) => unknown)[]>()
	const emit = vi.fn((channel: string, data: unknown) => {
		for (const handler of eventHandlers.get(channel) ?? []) handler(data)
	})
	const on = vi.fn((channel: string, handler: (data: unknown) => unknown) => {
		const list = eventHandlers.get(channel) ?? []
		list.push(handler)
		eventHandlers.set(channel, list)
		return () => {
			const idx = list.indexOf(handler)
			if (idx !== -1) list.splice(idx, 1)
		}
	})
	return { events: { emit, on }, emit }
}
