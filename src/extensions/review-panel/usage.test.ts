import type { AgentSession } from "@earendil-works/pi-coding-agent"
import { expect, it } from "vitest"
import { ReviewPanelUsageBuffer } from "./usage.js"

function fakeSession() {
	const listeners = new Set<(event: unknown) => void>()
	const session = {
		subscribe(listener: (event: unknown) => void) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
	} as unknown as AgentSession
	const emit = (input: number) => {
		for (const listener of listeners) {
			listener({
				type: "message_end",
				message: {
					role: "assistant",
					provider: "p",
					model: "m",
					usage: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			})
		}
	}
	return { session, emit }
}

it("reports only the undelivered usage delta, and only once", async () => {
	const dropped: number[] = []
	let call = 0
	const buffer = new ReviewPanelUsageBuffer(
		async () => {
			call += 1
			if (call === 2) await new Promise(() => {})
		},
		undefined,
		(entry) => dropped.push(entry.usage.input),
	)
	const { session, emit } = fakeSession()
	buffer.attach("spec", session)
	emit(100)
	await buffer.flush() // delivers 100
	emit(5)
	await buffer.flush({ deadline: Date.now() + 50 }) // times out, drops 5
	await buffer.flush() // panel.ts flushes again after finalize
	await buffer.flush({ deadline: Date.now() + 50 }) // and once more in finally
	expect(dropped).toEqual([5])
	buffer.close()
})
