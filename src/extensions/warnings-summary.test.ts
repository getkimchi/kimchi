import type { ExtensionAPI, ExtensionContext, MessageRenderer, Theme } from "@earendil-works/pi-coding-agent"
import type { Component } from "@earendil-works/pi-tui"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	installWarningsSummary,
	recordRelayedWarning,
	resetWarningsSummaryForTests,
	trackWarningsSummaryContext,
	WARNINGS_ENTRY_TYPE,
} from "./warnings-summary.js"

const plainTheme = { fg: (_color: string, text: string) => text } as unknown as Theme

function fakePi() {
	return {
		registerMessageRenderer: vi.fn(),
		sendMessage: vi.fn(),
	} as unknown as ExtensionAPI & {
		registerMessageRenderer: ReturnType<typeof vi.fn>
		sendMessage: ReturnType<typeof vi.fn>
	}
}

function fakeCtx(hasUI: boolean) {
	return {
		hasUI,
		ui: { notify: vi.fn(), setStatus: vi.fn() },
	} as unknown as ExtensionContext & { ui: { notify: ReturnType<typeof vi.fn>; setStatus: ReturnType<typeof vi.fn> } }
}

function capturedRenderer(pi: ReturnType<typeof fakePi>): MessageRenderer<{ entries: string[] }> {
	expect(pi.registerMessageRenderer).toHaveBeenCalledWith(WARNINGS_ENTRY_TYPE, expect.any(Function))
	return pi.registerMessageRenderer.mock.calls[0][1] as MessageRenderer<{ entries: string[] }>
}

type WarningsMessage = Parameters<MessageRenderer<{ entries: string[] }>>[0]

function fakeMessage(entries: string[]): WarningsMessage {
	return { details: { entries } } as WarningsMessage
}

function mustRender(renderer: MessageRenderer<{ entries: string[] }>, entries: string[], expanded: boolean): Component {
	const component = renderer(fakeMessage(entries), { expanded, outputPad: 0 }, plainTheme)
	if (!component) throw new Error("renderer returned undefined")
	return component
}

beforeEach(() => {
	resetWarningsSummaryForTests()
})

afterEach(() => {
	resetWarningsSummaryForTests()
})

describe("recordRelayedWarning", () => {
	it("sends the transcript message once per session and updates the footer counter", () => {
		const pi = fakePi()
		const ctx = fakeCtx(true)
		installWarningsSummary(pi)
		trackWarningsSummaryContext(ctx)

		recordRelayedWarning("first warning")
		recordRelayedWarning("second warning")

		expect(pi.sendMessage).toHaveBeenCalledTimes(1)
		expect(pi.sendMessage).toHaveBeenCalledWith(
			{
				customType: WARNINGS_ENTRY_TYPE,
				content: "",
				display: true,
				details: { entries: ["first warning"] },
			},
			{ triggerTurn: false },
		)
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("warnings", "2 warnings")
		expect(ctx.ui.notify).not.toHaveBeenCalled()
	})

	it("falls back to ctx.ui.notify when the summary module is not installed", () => {
		const ctx = fakeCtx(true)
		// Deliberately no installWarningsSummary call.
		trackWarningsSummaryContext(ctx)

		recordRelayedWarning("lonely warning")

		expect(ctx.ui.notify).toHaveBeenCalledWith("lonely warning", "warning")
	})

	it("falls back to ctx.ui.notify when the tracked context has no UI", () => {
		const pi = fakePi()
		installWarningsSummary(pi)
		// Headless ctxs are never tracked by the relay in production, but a late
		// ctx swap can hand us one; notify keeps the contract instead of sending.
		const headless = fakeCtx(false)
		trackWarningsSummaryContext(headless)

		recordRelayedWarning("headless-ish warning")

		expect(headless.ui.notify).toHaveBeenCalledWith("headless-ish warning", "warning")
		expect(pi.sendMessage).not.toHaveBeenCalled()
	})

	it("install is idempotent — repeat installs register one renderer", () => {
		const pi = fakePi()
		installWarningsSummary(pi)
		installWarningsSummary(pi)

		expect(pi.registerMessageRenderer).toHaveBeenCalledTimes(1)
	})

	it("track clears the footer counter and resets per-session state", () => {
		const pi = fakePi()
		const first = fakeCtx(true)
		const second = fakeCtx(true)
		installWarningsSummary(pi)
		trackWarningsSummaryContext(first)
		recordRelayedWarning("old session warning")

		trackWarningsSummaryContext(second)
		recordRelayedWarning("fresh session warning")

		expect(second.ui.setStatus).toHaveBeenCalledWith("warnings", undefined)
		expect(second.ui.setStatus).toHaveBeenLastCalledWith("warnings", "1 warning")
		// A new session sends a new transcript message.
		expect(pi.sendMessage).toHaveBeenCalledTimes(2)
		expect(pi.sendMessage).toHaveBeenLastCalledWith(
			expect.objectContaining({ details: { entries: ["fresh session warning"] } }),
			{ triggerTurn: false },
		)
	})
})

describe("warningsMessageRenderer", () => {
	it("renders collapsed by default: dim count + latest + expand hint, no details", () => {
		const pi = fakePi()
		const ctx = fakeCtx(true)
		installWarningsSummary(pi)
		trackWarningsSummaryContext(ctx)
		recordRelayedWarning("MCP: 105 direct tools resolved.")
		recordRelayedWarning("second issue\nwith detail")

		const renderer = capturedRenderer(pi)
		const lines = mustRender(renderer, [], false).render(120)

		expect(lines).toHaveLength(1)
		expect(lines[0]).toContain("[2 warnings] Latest: second issue with detail")
		expect(lines[0]).toContain("(ctrl+o to expand)")
		expect(lines.join("\n")).not.toContain("MCP: 105 direct tools resolved.")
	})

	it("expands to the full entry list and updates count from the live store", () => {
		const pi = fakePi()
		const ctx = fakeCtx(true)
		installWarningsSummary(pi)
		trackWarningsSummaryContext(ctx)
		recordRelayedWarning("first message")

		const renderer = capturedRenderer(pi)
		const component = mustRender(renderer, ["first message"], true)
		expect(component.render(120)).toEqual([
			expect.stringContaining("[Warnings]"),
			expect.stringContaining("first message"),
		])

		recordRelayedWarning("late arrival")
		const expanded = component.render(120)
		expect(expanded).toHaveLength(3)
		expect(expanded[2]).toBe("late arrival")

		const collapsed = mustRender(renderer, ["first message"], false).render(120)
		expect(collapsed[0]).toContain("[2 warnings] Latest: late arrival")
	})

	it("caps the buffer at 50 entries and summarizes overflow", () => {
		const pi = fakePi()
		const ctx = fakeCtx(true)
		installWarningsSummary(pi)
		trackWarningsSummaryContext(ctx)
		for (let i = 0; i < 55; i++) recordRelayedWarning(`warn ${i}`)

		const renderer = capturedRenderer(pi)
		const lines = mustRender(renderer, [], true).render(120)

		expect(lines[0]).toContain("[Warnings]")
		expect(lines[1]).toBe("… (5 earlier warnings not shown)")
		expect(lines).toHaveLength(1 + 1 + 50)
		expect(lines[2]).toBe("warn 5")
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("warnings", "50 warnings")
	})

	it("replays from the persisted snapshot when the live store is empty", () => {
		const pi = fakePi()
		installWarningsSummary(pi)
		const renderer = capturedRenderer(pi)

		const component = mustRender(renderer, ["persisted one", "persisted two"], false)
		expect(component.render(120)[0]).toContain("[2 warnings] Latest: persisted two")

		const expanded = mustRender(renderer, ["persisted one", "persisted two"], true).render(120)
		expect(expanded).toHaveLength(3)
	})

	it("returns undefined when there is nothing to show", () => {
		const pi = fakePi()
		installWarningsSummary(pi)
		const renderer = capturedRenderer(pi)

		expect(renderer(fakeMessage([]), { expanded: false, outputPad: 0 }, plainTheme)).toBeUndefined()
	})

	it("click toggles only this row", () => {
		const pi = fakePi()
		const ctx = fakeCtx(true)
		installWarningsSummary(pi)
		trackWarningsSummaryContext(ctx)
		recordRelayedWarning("toggle me")

		const renderer = capturedRenderer(pi)
		const component = mustRender(renderer, [], false)
		expect(component.render(120)[0]).toContain("(ctrl+o to expand)")

		component.handleMouse?.({ type: "click", button: "left" } as never)
		expect(component.render(120)[0]).toContain("(ctrl+o to collapse)")
		expect(component.render(120)).toHaveLength(2)

		expect(component.handleMouse?.({ type: "click", button: "right" } as never)).toBeUndefined()
	})
})
