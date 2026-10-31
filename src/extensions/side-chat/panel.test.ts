import type { Component } from "@earendil-works/pi-tui"
import { describe, expect, it, vi } from "vitest"
import { createSideChatHost } from "../__mocks__/side-chat-host.js"
import { testTheme } from "../__mocks__/theme.js"
import { SideChatPanel } from "./panel.js"

/**
 * Focus-routing contract: while a main-session modal (a permission ask) is
 * open it owns the keyboard, so every panel focus transition must go through
 * `host.focusComponent`, which prefers the modal — a regression back to
 * direct `host.ui.setFocus` would strand the keyboard-only ask unfocused.
 */

const dialog = (): Component => ({ render: () => [], invalidate: () => {} })

function setup() {
	const { host, setModal, lastFocus } = createSideChatHost()
	const panel = new SideChatPanel({
		host,
		theme: testTheme,
		cwd: "/tmp",
		title: "test",
		onSubmit: vi.fn(),
		onEscape: vi.fn(),
		onShortcut: vi.fn(() => false),
		onHeaderAction: vi.fn(),
		onPickHistory: vi.fn(),
	})
	return { host, panel, setModal, lastFocus }
}

describe("SideChatPanel focus delegation", () => {
	it("focus() goes through host.focusComponent, which prefers an open modal", () => {
		const { host, panel, setModal, lastFocus } = setup()

		panel.focus()
		expect(vi.mocked(host.focusComponent)).toHaveBeenCalledWith(panel.editor)
		expect(lastFocus()).toBe(panel.editor)

		const ask = dialog()
		setModal(ask)
		panel.focus()
		expect(lastFocus()).toBe(ask)
	})

	it("showHistory() goes through host.focusComponent, which prefers an open modal", () => {
		const { host, panel, setModal, lastFocus } = setup()

		panel.showHistory([{ id: "1", label: "older chat", current: false }])
		expect(vi.mocked(host.focusComponent)).toHaveBeenCalled()
		expect(lastFocus()).not.toBeUndefined()
		expect(lastFocus()).not.toBe(panel.editor)

		setModal(undefined)
		const ask = dialog()
		setModal(ask)
		panel.showHistory([{ id: "1", label: "older chat", current: false }])
		expect(lastFocus()).toBe(ask)
	})
})
