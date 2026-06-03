import { visibleWidth } from "@earendil-works/pi-tui"
import { describe, expect, it } from "vitest"
import { type BannerState, ReconnectBanner } from "./reconnect-banner.js"

function render(state: BannerState | null, width = 80): string[] {
	const banner = new ReconnectBanner(() => state)
	return banner.render(width)
}

function stripAnsi(s: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: needed for ANSI stripping
	return s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
}

describe("ReconnectBanner", () => {
	it("returns an empty array when state is null", () => {
		expect(render(null)).toEqual([])
	})

	it("renders the connecting phase", () => {
		const [line] = render({ phase: "connecting" }, 40)
		expect(stripAnsi(line)).toMatch(/^connecting…\s+$/)
		expect(visibleWidth(stripAnsi(line))).toBe(40)
	})

	it("renders the reconnecting phase with countdown and attempt", () => {
		const [line] = render({ phase: "reconnecting", reconnect: { attempt: 3, secondsRemaining: 4 } }, 60)
		expect(stripAnsi(line)).toMatch(/^reconnecting in 4s \(attempt 3\)…\s+$/)
	})

	it("renders the lost phase with retry hint", () => {
		const [line] = render({ phase: "lost" }, 80)
		expect(stripAnsi(line)).toMatch(/connection lost — ctrl\+r retry · ctrl\+d exit/)
	})

	it("renders the fatal phase with code and reason", () => {
		const [line] = render({ phase: "fatal", fatal: { code: 4003, reason: "session finished" } }, 80)
		expect(stripAnsi(line)).toMatch(/fatal: session finished \(4003\) — ctrl\+d exit/)
	})

	it("falls back to a default reason when fatal.reason is empty", () => {
		const [line] = render({ phase: "fatal", fatal: { code: 4002, reason: "" } }, 80)
		expect(stripAnsi(line)).toMatch(/fatal: session terminated \(4002\)/)
	})

	it("truncates with an ellipsis when content exceeds width", () => {
		const [line] = render(
			{
				phase: "fatal",
				fatal: { code: 4003, reason: "x".repeat(200) },
			},
			20,
		)
		const plain = stripAnsi(line)
		expect(visibleWidth(plain)).toBe(20)
		expect(plain.endsWith("…")).toBe(true)
	})

	it("pads to the requested width when content is shorter", () => {
		const [line] = render({ phase: "connecting" }, 50)
		expect(visibleWidth(stripAnsi(line))).toBe(50)
	})
})
