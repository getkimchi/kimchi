import { InteractiveMode } from "@earendil-works/pi-coding-agent"
import { describe, expect, it, vi } from "vitest"
import {
	applyInteractiveWorkingIndicatorPatch,
	showWorkingIndicatorAfterAutoCompaction,
	showWorkingIndicatorForAcceptedPrompt,
	wrapGetUserInput,
	wrapHandleEvent,
} from "./interactive-working-indicator.js"

function fakeHost(overrides: Partial<Parameters<typeof showWorkingIndicatorForAcceptedPrompt>[0]> = {}) {
	return {
		workingVisible: true,
		isExtensionCommand: vi.fn((text: string) => text.startsWith("/")),
		showWorkingStatusIndicator: vi.fn(),
		clearStatusIndicator: vi.fn(),
		getUserInput: vi.fn(async () => "hello"),
		...overrides,
	}
}

describe("showWorkingIndicatorForAcceptedPrompt", () => {
	it("shows the working spinner for an accepted prompt", () => {
		const host = fakeHost()
		showWorkingIndicatorForAcceptedPrompt(host, "set up the repo")
		expect(host.showWorkingStatusIndicator).toHaveBeenCalledTimes(1)
	})

	it("never spins for extension commands — they run without an agent turn", () => {
		const host = fakeHost()
		showWorkingIndicatorForAcceptedPrompt(host, "/memory list")
		expect(host.showWorkingStatusIndicator).not.toHaveBeenCalled()
	})

	it("respects a hidden working indicator (turn_start's guard)", () => {
		const host = fakeHost({ workingVisible: false })
		showWorkingIndicatorForAcceptedPrompt(host, "set up the repo")
		expect(host.showWorkingStatusIndicator).not.toHaveBeenCalled()
	})
})

describe("wrapGetUserInput", () => {
	it("clears a stale working indicator at loop re-entry, then arms it on resolution", async () => {
		const host = fakeHost()
		const wrapped = wrapGetUserInput(() => Promise.resolve("next prompt"))
		await expect(wrapped.call(host)).resolves.toBe("next prompt")
		// Re-entry clear first, spinner armed after the input resolved.
		expect(host.clearStatusIndicator).toHaveBeenCalledWith("working")
		expect(host.showWorkingStatusIndicator).toHaveBeenCalledTimes(1)
	})

	it("passes the accepted text through unchanged and delegates the command check to the host", async () => {
		const host = fakeHost()
		const wrapped = wrapGetUserInput(() => Promise.resolve("verbatim text"))
		await expect(wrapped.call(host)).resolves.toBe("verbatim text")
		// The guard must consult the host's registry-backed check, not inline a
		// slash-prefix rule of its own.
		expect(host.isExtensionCommand).toHaveBeenCalledWith("verbatim text")
	})

	it("clears the stale indicator even when the input is an extension command", async () => {
		const host = fakeHost()
		const wrapped = wrapGetUserInput(() => Promise.resolve("/help"))
		await wrapped.call(host)
		expect(host.clearStatusIndicator).toHaveBeenCalledWith("working")
		expect(host.showWorkingStatusIndicator).not.toHaveBeenCalled()
	})

	it("does not arm when the working indicator is hidden", async () => {
		const host = fakeHost({ workingVisible: false })
		const wrapped = wrapGetUserInput(() => Promise.resolve("hello"))
		await wrapped.call(host)
		expect(host.clearStatusIndicator).toHaveBeenCalledWith("working")
		expect(host.showWorkingStatusIndicator).not.toHaveBeenCalled()
	})
})

describe("showWorkingIndicatorAfterAutoCompaction", () => {
	const compactionEnd = (reason: "manual" | "threshold" | "overflow", aborted = false) =>
		({ type: "compaction_end" as const, reason, aborted }) as const

	it("re-arms after a settled auto-compaction — a turn follows", () => {
		for (const reason of ["threshold", "overflow"] as const) {
			const host = fakeHost()
			showWorkingIndicatorAfterAutoCompaction(host, compactionEnd(reason))
			expect(host.showWorkingStatusIndicator).toHaveBeenCalledTimes(1)
		}
	})

	it("never re-arms after manual /compact — no turn follows", () => {
		const host = fakeHost()
		showWorkingIndicatorAfterAutoCompaction(host, compactionEnd("manual"))
		expect(host.showWorkingStatusIndicator).not.toHaveBeenCalled()
	})

	it("never re-arms after an aborted auto-compaction — the run may die with the cancel", () => {
		const host = fakeHost()
		showWorkingIndicatorAfterAutoCompaction(host, compactionEnd("threshold", true))
		expect(host.showWorkingStatusIndicator).not.toHaveBeenCalled()
	})

	it("respects a hidden working indicator", () => {
		const host = fakeHost({ workingVisible: false })
		showWorkingIndicatorAfterAutoCompaction(host, compactionEnd("overflow"))
		expect(host.showWorkingStatusIndicator).not.toHaveBeenCalled()
	})
})

describe("wrapHandleEvent", () => {
	it("re-arms after the original handler clears the compaction indicator", async () => {
		const host = fakeHost()
		const order: string[] = []
		const wrapped = wrapHandleEvent(async function original(this: unknown, event: { type: string }) {
			order.push(`original:${event.type}`)
		})
		await wrapped.call(host, { type: "compaction_end", reason: "threshold" })
		expect(order).toEqual(["original:compaction_end"])
		expect(host.showWorkingStatusIndicator).toHaveBeenCalledTimes(1)
	})

	it("forwards other events untouched without arming", async () => {
		const host = fakeHost()
		const seen: string[] = []
		const wrapped = wrapHandleEvent(async function original(this: unknown, event: { type: string }) {
			seen.push(event.type)
		})
		await wrapped.call(host, { type: "compaction_end", reason: "manual" })
		await wrapped.call(host, { type: "turn_start" })
		expect(seen).toEqual(["compaction_end", "turn_start"])
		expect(host.showWorkingStatusIndicator).not.toHaveBeenCalled()
	})

	it("clears the working indicator when a run settles — the symmetric transition for runs that end with no following turn", async () => {
		const host = fakeHost()
		const wrapped = wrapHandleEvent(async () => {})
		// An auto-compaction re-arms mid-run…
		await wrapped.call(host, { type: "compaction_end", reason: "threshold" })
		expect(host.showWorkingStatusIndicator).toHaveBeenCalledTimes(1)
		// …and the run then settles with no turn queued — the settle clears it.
		await wrapped.call(host, { type: "agent_settled" })
		expect(host.clearStatusIndicator).toHaveBeenCalledWith("working")
	})
})

describe("applyInteractiveWorkingIndicatorPatch", () => {
	it("wraps both prototype methods exactly once across repeated applications", async () => {
		const imProto = InteractiveMode.prototype as unknown as {
			getUserInput?: (this: unknown) => Promise<string>
			handleEvent?: (this: unknown, event: { type: string }) => Promise<void>
			__kimchiWorkingIndicatorPatched?: boolean
		}
		const originalGetUserInput = imProto.getUserInput
		const originalHandleEvent = imProto.handleEvent
		let upstreamCalls = 0
		let upstreamEvents = 0
		// Fake upstream originals: the patch wraps whatever exists.
		imProto.getUserInput = function fakeUpstream(this: unknown) {
			upstreamCalls++
			return Promise.resolve("from upstream")
		}
		imProto.handleEvent = async function fakeUpstreamEvent(this: unknown) {
			upstreamEvents++
		}
		imProto.__kimchiWorkingIndicatorPatched = undefined
		try {
			applyInteractiveWorkingIndicatorPatch()
			applyInteractiveWorkingIndicatorPatch()
			const host = {
				workingVisible: true,
				isExtensionCommand: (text: string) => text.startsWith("/"),
				showWorkingStatusIndicator: vi.fn(),
				clearStatusIndicator: vi.fn(),
				getUserInput: imProto.getUserInput as (this: unknown) => Promise<string>,
				handleEvent: imProto.handleEvent as (this: unknown, event: { type: string }) => Promise<void>,
			} as unknown as Parameters<typeof showWorkingIndicatorForAcceptedPrompt>[0]
			const result = await imProto.getUserInput?.call(host)
			// One wrap: the upstream original ran once per call, not once per patch
			// application, and the arming/clearing fired exactly once each.
			expect(upstreamCalls).toBe(1)
			expect(result).toBe("from upstream")
			expect(host.showWorkingStatusIndicator).toHaveBeenCalledTimes(1)
			expect(host.clearStatusIndicator).toHaveBeenCalledTimes(1)
			// The handleEvent wrap: the installed method forwards each event to the
			// upstream original once and re-arms on a settled auto-compaction —
			// a manual compaction_end does not arm.
			await imProto.handleEvent?.call(host, { type: "compaction_end", reason: "threshold" })
			await imProto.handleEvent?.call(host, { type: "compaction_end", reason: "manual" })
			expect(upstreamEvents).toBe(2)
			expect(host.showWorkingStatusIndicator).toHaveBeenCalledTimes(2)
		} finally {
			imProto.getUserInput = originalGetUserInput
			imProto.handleEvent = originalHandleEvent
			imProto.__kimchiWorkingIndicatorPatched = undefined
		}
	})
})
