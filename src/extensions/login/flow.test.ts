import { LoginDialogComponent, initTheme } from "@earendil-works/pi-coding-agent"
import type { TUI } from "@earendil-works/pi-tui"
import { beforeAll, describe, expect, it, vi } from "vitest"

import { SwappableAuthComponent } from "./flow.js"

beforeAll(() => {
	initTheme("default")
})

function createTui(): TUI {
	return { requestRender: vi.fn() } as unknown as TUI
}

describe("SwappableAuthComponent", () => {
	// Regression for https://github.com/getkimchi/kimchi/issues/616: the subscription
	// (GitHub Copilot) login path hosts a LoginDialogComponent inside SwappableAuthComponent.
	// Typing any non-Escape character forwards the byte to the hosted LoginDialogComponent,
	// whose handleInput dereferences `this.input`. If the forward drops the `this` binding,
	// that runs with `this === undefined` and crashes.
	it("forwards a typed character to the real login dialog without crashing", () => {
		const tui = createTui()
		const host = new SwappableAuthComponent(tui)
		const dialog = new LoginDialogComponent(tui, "github-copilot", () => {}, "GitHub Copilot")
		host.set(dialog)

		expect(() => host.handleInput("a")).not.toThrow()
	})

	// Pinpoints the root cause directly: the hosted component must be invoked as a method so
	// `this` stays bound to it. Fails loudly if the forward ever regresses to a detached bare call.
	it("invokes the hosted component with `this` bound to that component", () => {
		const tui = createTui()
		const host = new SwappableAuthComponent(tui)
		let receivedThis: unknown
		const child = {
			handleInput(this: unknown): void {
				receivedThis = this
			},
		}
		host.set(child)

		host.handleInput("a")

		expect(receivedThis).toBe(child)
	})
})
