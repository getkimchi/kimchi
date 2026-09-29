import type { Theme } from "@earendil-works/pi-coding-agent"
import { initTheme } from "@earendil-works/pi-coding-agent"
import { beforeAll, describe, expect, it, vi } from "vitest"
import { RatingSelectorComponent } from "./rating-dialog.js"

beforeAll(() => {
	initTheme("default")
})

function makeTheme(): Theme {
	return {
		fg: (_color: string, s: string) => s,
		bg: (_color: string, s: string) => s,
		bold: (s: string) => s,
		getFgAnsi: (_color: string) => "",
	} as unknown as Theme
}

function makeComponent() {
	const done = vi.fn()
	const component = new RatingSelectorComponent(makeTheme(), done)
	return { component, done }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: test-only helper
const ANSI_RE = /\x1b\[[0-9;]*m/g
function stripAnsi(s: string): string {
	return s.replace(ANSI_RE, "")
}

const ARROW_DOWN = "\x1b[B"
const ARROW_UP = "\x1b[A"
const ENTER = "\r"
const ESCAPE = "\x1b"

describe("RatingSelectorComponent", () => {
	it("renders the title, prompt, options, and hint", () => {
		const { component } = makeComponent()
		const text = component.render(100).map(stripAnsi).join("\n")

		expect(text).toContain("Rate response")
		expect(text).toContain("How would you rate this response?")
		expect(text).toContain("Good")
		expect(text).toContain("Bad")
		expect(text).toContain("[Enter] Continue")
		expect(text).toContain("[↑↓] Select")
		expect(text).toContain("[Esc] Cancel")
	})

	it("starts with Good focused", () => {
		const { component } = makeComponent()
		const text = component.render(100).map(stripAnsi).join("\n")

		expect(text).toContain("→ Good")
		expect(text).not.toContain("→ Bad")
	})

	it("arrow keys move the focus indicator between the options", () => {
		const { component } = makeComponent()

		component.handleInput(ARROW_DOWN)
		let text = component.render(100).map(stripAnsi).join("\n")
		expect(text).toContain("→ Bad")

		component.handleInput(ARROW_UP)
		text = component.render(100).map(stripAnsi).join("\n")
		expect(text).toContain("→ Good")
	})

	it("focus clamps at the last option when arrowing down past it", () => {
		const { component } = makeComponent()

		component.handleInput(ARROW_DOWN)
		component.handleInput(ARROW_DOWN)
		const text = component.render(100).map(stripAnsi).join("\n")
		expect(text).toContain("→ Bad")
	})

	it("Enter resolves with the focused sentiment", () => {
		const { component, done } = makeComponent()

		component.handleInput(ENTER)
		expect(done).toHaveBeenCalledWith("positive")

		const second = makeComponent()
		second.component.handleInput(ARROW_DOWN)
		second.component.handleInput(ENTER)
		expect(second.done).toHaveBeenCalledWith("negative")
	})

	it("Escape resolves with undefined", () => {
		const { component, done } = makeComponent()

		component.handleInput(ESCAPE)
		expect(done).toHaveBeenCalledWith(undefined)
	})
})
